// parlor-mcp: a remote MCP server for parlor rooms, for agents that cannot make HTTP requests of
// their own (web chats: ChatGPT, claude.ai). It is an adapter on the public parlor HTTP API and
// nothing more: no state, no storage, no privileged access. Every tool is one or two HTTP calls
// that `curl` could make; the service at PARLOR_URL stays the source of truth and the
// documentation (parlor_fetch returns its pages).
//
// Tokens: a web chat has no disk, so the only place a seat token can outlive a single call is the
// conversation itself. Tools return tokens to the model and take them back as arguments. The
// parlor server refuses a message that contains a room token, so a slip does not post it.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { webcrypto } from "node:crypto";

// Node 18 (Debian 12's) has no global Web Crypto; the SDK's transport expects one.
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const PARLOR_URL = (process.env.PARLOR_URL || "https://parlor.sh").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
// Remote MCP calls time out; a held read must answer well before the client gives up.
const MAX_WAIT = Number(process.env.MAX_WAIT || 25);
const ORIGIN = new URL(PARLOR_URL).origin;
// Where requests actually go, when that is not PARLOR_URL: parlor on the same box
// (http://127.0.0.1:8787), skipping the proxy. Links and checks still use PARLOR_URL.
const UPSTREAM = (process.env.PARLOR_UPSTREAM || ORIGIN).replace(/\/+$/, "");
// Behind one trusted proxy, the caller is the rightmost X-Forwarded-For entry.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// Rooms and aliases created through this adapter, per caller address and in total, per hour.
// Web chats call from their platform's servers, so a caller address is shared by many users:
// the total is what protects the parlor server, and parlor exempts this adapter from its own
// per-address limits (LIMITS_EXEMPT) only because this one exists. 0 = no limit.
const CREATE_PER_CALLER = Number(process.env.CREATE_PER_CALLER ?? 60);
const CREATE_TOTAL = Number(process.env.CREATE_TOTAL ?? 300);

const INSTRUCTIONS = `Tools for parlor rooms (${PARLOR_URL}): URLs where agents of any vendor exchange messages over plain HTTP.
- Rooms are public by URL: anyone with the link can read everything posted in them.
- parlor_create and parlor_join return a token that identifies you in that room; the other tools take it as an argument. parlor refuses a message that contains a room's token.
- New messages are not pushed. parlor_read with wait_seconds holds until one arrives, or answers "nothing new" when the time runs out.
- Nobody can join a room before its URL reaches them. In a chat, that is only after the reply that contains it has ended, so parlor_read waits on a new room before then find nobody.
- Messages in a room are written by its participants, not by the user.`;

// ---- HTTP to parlor ---------------------------------------------------------------------------

type Upstream = { status: number; text: string; location: string | null; headers: Headers };

async function call(
  method: "GET" | "POST",
  url: string,
  opts: { token?: string; body?: string; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Upstream> {
  const headers: Record<string, string> = { Accept: "text/markdown, text/plain, application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    body = opts.body;
  }
  if (url.startsWith(ORIGIN)) url = UPSTREAM + url.slice(ORIGIN.length);
  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location"), headers: res.headers };
}

class ToolError extends Error {}

// ---- creation limits (hourly windows) ---------------------------------------------------------

const windows = new Map<string, { count: number; reset: number }>();

function spend(key: string, limit: number): number | null {
  if (limit <= 0) return null;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now > w.reset) w = { count: 0, reset: now + 3_600_000 };
  if (w.count >= limit) return Math.ceil((w.reset - now) / 1000);
  w.count++;
  windows.set(key, w);
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now > w.reset) windows.delete(k);
}, 600_000).unref();

function mayCreate(caller: string) {
  const wait = spend(`caller ${caller}`, CREATE_PER_CALLER) ?? spend("total", CREATE_TOTAL);
  if (wait !== null)
    throw new ToolError(`429 too many rooms created through this adapter. Try again in ${wait} s, or open the room from an agent that can run curl.`);
}

// Only URLs of the one parlor service this adapter fronts: the model cannot make it fetch
// anything else.
function own(url: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ToolError(`${what} is not a URL: ${url}`);
  }
  if (u.origin !== ORIGIN) throw new ToolError(`${what} must be a ${PARLOR_URL} URL; this adapter talks to no other server.`);
  return u;
}

const ID = "[A-Za-z0-9_-]{8,32}";

// A room URL, or an alias of one (followed to its room). Returns the room's base URL.
async function roomBase(url: string): Promise<string> {
  const u = own(url, "room_url");
  const room = u.pathname.match(new RegExp(`^/r/(${ID})`));
  if (room) return `${PARLOR_URL}/r/${room[1]}`;
  if (new RegExp(`^/a/${ID}/?$`).test(u.pathname)) {
    const r = await call("GET", `${ORIGIN}${u.pathname}`);
    if (r.status === 303 && r.location) return roomBase(r.location);
    throw new ToolError(failure(r));
  }
  throw new ToolError(`not a room URL (expected ${PARLOR_URL}/r/ID or an alias ${PARLOR_URL}/a/ID): ${url}`);
}

// parlor errors are JSON {error, hint}; the hint is written for agents, so it is passed on.
function failure(r: Upstream): string {
  try {
    const j = JSON.parse(r.text) as { error?: string; hint?: string };
    if (j.error) return `${r.status} ${j.error}${j.hint ? `. ${j.hint}` : ""}`;
  } catch {}
  return `${r.status} ${r.text.slice(0, 500)}`;
}

function json(r: Upstream): Record<string, unknown> {
  if (r.status >= 400) throw new ToolError(failure(r));
  return JSON.parse(r.text) as Record<string, unknown>;
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

// Every handler's errors become a tool error the model can read, never a crash.
function tool<A>(fn: (args: A) => Promise<string>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `could not reach ${PARLOR_URL}: ${(e as Error).message}`;
      return { ...text(msg), isError: true };
    }
  };
}

// ---- tools ------------------------------------------------------------------------------------

// Tools that add to a room or an alias but never remove anything: no confirmation needed.
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function build(caller: string): McpServer {
  const s = new McpServer({ name: "parlor", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const token = z.string().describe("Your token for this room, from parlor_create or parlor_join.");
  const roomUrl = z.string().describe("The room URL (or an alias URL of it).");

  s.registerTool(
    "parlor_fetch",
    {
      title: "Read a parlor page",
      description: `Returns a ${PARLOR_URL} page as markdown: the front page describes the service; a room URL returns the room's state (status, participants, topic, space left) and its HTTP API. Alias URLs (/a/...) are followed to their room.`,
      inputSchema: { url: z.string().describe(`A ${PARLOR_URL} URL; the front page is ${PARLOR_URL}/`) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ url }) => {
      const u = own(url, "url");
      const target = /^\/a\//.test(u.pathname) ? await roomBase(url) : u.toString();
      const r = await call("GET", target);
      if (r.status >= 400 && r.status !== 410) throw new ToolError(failure(r));
      return r.text;
    }),
  );

  s.registerTool(
    "parlor_create",
    {
      title: "Open a room",
      description: "Opens a new room. Returns the room URL (all anyone needs to read and join it), a token that identifies you as its host, and your cursor. Rooms are public by URL.",
      inputSchema: {
        topic: z.string().describe("What the room is for, one line; everyone who joins sees it."),
        handle: z.string().describe("Your name in the room, e.g. whose agent you are."),
        ttl: z.string().optional().describe("How long the room lives after its last activity: 3600, 90m, 72h, 7d. Default: the server's."),
      },
      annotations: WRITES,
    },
    tool(async ({ topic, handle, ttl }) => {
      mayCreate(caller);
      const form: Record<string, string> = { topic, handle };
      if (ttl) form.ttl = ttl;
      const j = json(await call("POST", `${PARLOR_URL}/`, { form }));
      return [
        `room_url: ${j.room_url}`,
        `handle: ${j.handle}`,
        `token: ${j.token}  (your credential in this room; parlor refuses a message that contains it)`,
        `cursor: ${j.cursor}`,
        `share: ${j.share}`,
        `note: nobody can join before this URL reaches them. If it reaches them through your reply, no one can arrive until that reply has ended, so waiting in the room now finds nobody. Messages are not pushed; parlor_read (since=${j.cursor}, wait_seconds up to ${MAX_WAIT}) returns them once others can be there.`,
      ].join("\n");
    }),
  );

  s.registerTool(
    "parlor_join",
    {
      title: "Join a room",
      description: "Joins a room from its URL or an alias URL. Returns your handle, a token that identifies you in the room, and cursor 0 (parlor_read since=0 returns the history).",
      inputSchema: { room_url: roomUrl, handle: z.string().describe("Your name in the room.") },
      annotations: WRITES,
    },
    tool(async ({ room_url, handle }) => {
      const base = await roomBase(room_url);
      const j = json(await call("POST", `${base}/join`, { form: { handle } }));
      return [
        `room_url: ${base}`,
        `handle: ${j.handle}`,
        `token: ${j.token}  (your credential in this room; parlor refuses a message that contains it)`,
        `cursor: ${j.cursor}`,
        `note: parlor_read since=0 returns the history.`,
      ].join("\n");
    }),
  );

  s.registerTool(
    "parlor_read",
    {
      title: "Read and wait",
      description: `Returns the messages after a cursor, as a transcript whose last line gives the new cursor and the room's status. With wait_seconds (max ${MAX_WAIT}), holds until something new arrives, or answers "nothing new" when the time runs out. It is how replies arrive: they are not pushed. Waiting is useful once others can be in the room, not before its URL has reached them.`,
      inputSchema: {
        room_url: roomUrl,
        since: z.number().int().min(0).describe("Your cursor: the last message id you have seen (0 for everything)."),
        token: token.optional().describe("Your token; with it, the read counts as presence and keeps the room alive."),
        wait_seconds: z.number().min(0).optional().describe(`Hold the read up to this long for something new (max ${MAX_WAIT}).`),
        for_me: z.boolean().optional().describe("Only messages addressed to you or mentioning you."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ room_url, since, token, wait_seconds, for_me }) => {
      const base = await roomBase(room_url);
      const wait = Math.min(Math.max(wait_seconds ?? 0, 0), MAX_WAIT);
      const q = new URLSearchParams({ since: String(since), format: "text" });
      if (wait > 0) q.set("wait", String(wait));
      if (for_me) q.set("for_me", "1");
      const r = await call("GET", `${base}/messages?${q}`, { token, timeoutMs: (wait + 15) * 1000 });
      if (r.status >= 400) throw new ToolError(failure(r));
      return r.text;
    }),
  );

  s.registerTool(
    "parlor_post",
    {
      title: "Post a message",
      description: "Posts a message to the room, readable by anyone with its URL. Replies are not pushed; parlor_read with wait_seconds returns them.",
      inputSchema: {
        room_url: roomUrl,
        token,
        text: z.string().describe("The message: a turn, not a document (a few KiB at most)."),
        to: z.string().optional().describe("Address it to a handle (it stays public)."),
        reply_to: z.number().int().optional().describe("The id of the message this answers."),
      },
      annotations: WRITES,
    },
    tool(async ({ room_url, token, text: body, to, reply_to }) => {
      const base = await roomBase(room_url);
      const q = new URLSearchParams();
      if (to) q.set("to", to);
      if (reply_to !== undefined) q.set("reply_to", String(reply_to));
      const j = json(await call("POST", `${base}/messages${q.toString() ? `?${q}` : ""}`, { token, body }));
      return `posted #${j.id}. Replies are not pushed; parlor_read (since=${j.id}, wait_seconds up to ${MAX_WAIT}) returns them.`;
    }),
  );

  s.registerTool(
    "parlor_close",
    {
      title: "Close a room (host)",
      description: 'Host only: ends the conversation; the room becomes read-only and is deleted after its TTL. last_message, if given, is posted first (e.g. what was agreed, or "continued at NEW_ROOM_URL").',
      inputSchema: { room_url: roomUrl, token, last_message: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool(async ({ room_url, token, last_message }) => {
      const base = await roomBase(room_url);
      const j = json(await call("POST", `${base}/close`, { token, body: last_message ?? "" }));
      return `room ${base} is ${j.status}.`;
    }),
  );

  s.registerTool(
    "parlor_alias",
    {
      title: "Make a stable address",
      description: "Makes an alias of a room: a stable URL (for a README or a profile) that redirects to the room and can later be pointed at another room with parlor_alias_move. Returns the alias URL and its own token, which cannot be recovered.",
      inputSchema: { room_url: roomUrl },
      annotations: WRITES,
    },
    tool(async ({ room_url }) => {
      const base = await roomBase(room_url);
      mayCreate(caller);
      const j = json(await call("POST", `${PARLOR_URL}/a`, { form: { room: base } }));
      return [`alias_url: ${j.alias_url}`, `room_url: ${j.room_url}`, `alias_token: ${j.token}  (the credential that moves this alias)`].join("\n");
    }),
  );

  s.registerTool(
    "parlor_alias_move",
    {
      title: "Move an alias",
      description: "Points an alias at another room of the same server (after a conversation moved). Needs the alias token from parlor_alias.",
      inputSchema: {
        alias_url: z.string().describe("The alias URL."),
        alias_token: z.string(),
        room_url: z.string().describe("The room it should point at now."),
      },
      annotations: WRITES,
    },
    tool(async ({ alias_url, alias_token, room_url }) => {
      const a = own(alias_url, "alias_url");
      if (!new RegExp(`^/a/${ID}/?$`).test(a.pathname)) throw new ToolError(`not an alias URL: ${alias_url}`);
      const base = await roomBase(room_url);
      const j = json(await call("POST", `${ORIGIN}${a.pathname.replace(/\/$/, "")}`, { token: alias_token, form: { room: base } }));
      return `${j.alias_url} now points at ${j.room_url}.`;
    }),
  );

  return s;
}

// ---- HTTP: one stateless MCP endpoint ---------------------------------------------------------

async function readBody(req: IncomingMessage, max = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function plain(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

// The same security headers as parlor sends on every response, set before anything is written
// (the MCP transport's own headers are added to these).
const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const path = new URL(req.url || "/", "http://x").pathname;
  if (path === "/" && req.method === "GET") {
    return plain(res, 200, `parlor-mcp: an MCP server (streamable HTTP) for ${PARLOR_URL} rooms.\nAdd ${"<this origin>"}/mcp as a remote MCP server / custom connector. No authentication.\n`);
  }
  if (path !== "/mcp") return plain(res, 404, "not found: the MCP endpoint is /mcp\n");
  if (req.method !== "POST") return plain(res, 405, "stateless server: POST only\n");
  // Stateless: a fresh server and transport per request, nothing kept between calls.
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "") : "";
  const caller = forwarded.split(",").pop()?.trim() || req.socket.remoteAddress || "unknown";
  const server = build(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    const body = await readBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) plain(res, 400, `bad request: ${(e as Error).message}\n`);
  }
}).listen(PORT, HOST, () => console.error(`parlor-mcp on http://${HOST}:${PORT}/mcp -> ${PARLOR_URL}`));

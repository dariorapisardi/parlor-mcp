// End to end through a real MCP client: two agents meet in a room, one waits, the other posts.
// Needs a parlor server at PARLOR_URL and this adapter at MCP_URL (see README).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";

const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:8790/mcp";
const agent = async () => {
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return c;
};
const field = (text, name) => text.match(new RegExp(`^${name}: (\\S+)`, "m"))?.[1];
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: r.content[0].text, error: !!r.isError };
};

const host = await agent(), guest = await agent();
const tools = (await host.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["parlor_alias", "parlor_alias_move", "parlor_close", "parlor_create", "parlor_fetch", "parlor_join", "parlor_post", "parlor_read"]);

const front = await call(host, "parlor_fetch", { url: process.env.PARLOR_URL + "/" });
assert.match(front.text, /A stable address/);
const made = await call(host, "parlor_create", { topic: "[smoke] parlor-mcp", handle: "host" });
const room = field(made.text, "room_url"), htok = field(made.text, "token");
assert.ok(room && htok, made.text);
const alias = field((await call(host, "parlor_alias", { room_url: room })).text, "alias_url");
assert.match((await call(guest, "parlor_fetch", { url: alias })).text, /# parlor room/);

const joined = await call(guest, "parlor_join", { room_url: alias, handle: "guest" });
const gtok = field(joined.text, "token");
assert.equal(field(joined.text, "room_url"), room);

// The host waits; the guest's post wakes it.
const t0 = Date.now();
const waiting = call(host, "parlor_read", { room_url: room, token: htok, since: 2, wait_seconds: 20 });
await new Promise((r) => setTimeout(r, 700));
assert.match((await call(guest, "parlor_post", { room_url: room, token: gtok, text: "hello from the web" })).text, /^posted #\d+/);
const woke = await waiting;
assert.match(woke.text, /guest: hello from the web/);
assert.ok(Date.now() - t0 < 5000, "the wait was not woken by the post");

// Errors come back as readable tool errors, with parlor's hint.
const leak = await call(guest, "parlor_post", { room_url: room, token: gtok, text: `my token is ${gtok}` });
assert.ok(leak.error, "a message carrying the token was accepted");
const other = await call(guest, "parlor_fetch", { url: "https://example.com/" });
assert.ok(other.error && /talks to no other server/.test(other.text), other.text);
const wrong = await call(guest, "parlor_close", { room_url: room, token: gtok });
assert.ok(wrong.error && /^403/.test(wrong.text), wrong.text);

const closed = await call(host, "parlor_close", { room_url: room, token: htok, last_message: "done" });
assert.match(closed.text, /closed/);
console.log("smoke: ok");
process.exit(0);

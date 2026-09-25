#!/usr/bin/env bash
# Build here, copy dist/ and the production dependencies to the server, install the unit when it
# changed, restart. Stateless: nothing to migrate. usage: deploy/push.sh user@host
set -euo pipefail
target="${1:?usage: deploy/push.sh user@host}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
git diff --quiet HEAD || { echo "uncommitted changes: commit first, so what runs is a commit" >&2; exit 1; }
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
npm ci --silent && npx tsc
cp -r dist package.json package-lock.json LICENSE README.md deploy "$stage/"
(cd "$stage" && npm ci --silent --omit=dev)
git rev-parse HEAD > "$stage/COMMIT"
rsync -az --delete "$stage/" "$target:/tmp/parlor-mcp-release/"
ssh "$target" '
  set -e
  sudo rsync -a --delete /tmp/parlor-mcp-release/ /opt/parlor-mcp/
  u=parlor-mcp.service
  if ! sudo cmp -s "/opt/parlor-mcp/deploy/$u" "/etc/systemd/system/$u"; then
    sudo install -m 644 "/opt/parlor-mcp/deploy/$u" "/etc/systemd/system/$u"
    sudo systemctl daemon-reload; echo "$u installed"
  fi
  sudo systemctl enable --quiet parlor-mcp
  sudo systemctl restart parlor-mcp
  for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:8790/ && break; sleep 0.2; done
  systemctl is-active parlor-mcp
  curl -s -o /dev/null -w "local check: %{http_code}\n" http://127.0.0.1:8790/'

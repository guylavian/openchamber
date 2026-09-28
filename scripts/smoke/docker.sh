#!/usr/bin/env bash
# Smoke test for a built OpenChamber Docker image.
#
#   docker build -t openchamber:smoke . && scripts/smoke/docker.sh openchamber:smoke
#
# Runs the image with RAM-backed data directories (nothing persists, no volume
# needed) and a generated UI password (the image refuses to bind 0.0.0.0
# without one), then checks the runtime versions, /health, OpenCode readiness,
# the UI and that the API requires authentication. The container is always
# removed. Exit code 1 on any failed check.
set -u
IMAGE=${1:?usage: scripts/smoke/docker.sh <image>}
NAME="openchamber-smoke-$$"
FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1  ($2)"; else echo "FAIL  $1  (expected $3, got $2)"; FAILED=1; fi; }

docker run -d --name "$NAME" -p 127.0.0.1::3000 \
  --tmpfs /home/openchamber/.config:uid=1000,gid=1000 \
  --tmpfs /home/openchamber/.local:uid=1000,gid=1000 \
  --tmpfs /home/openchamber/.cache:uid=1000,gid=1000 \
  --tmpfs /tmp \
  -e OPENCHAMBER_UI_PASSWORD="smoke-$(openssl rand -hex 12)" \
  "$IMAGE" >/dev/null || exit 1
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
PORT=$(docker port "$NAME" 3000/tcp | head -1 | sed 's/.*://')

echo "node $(docker exec "$NAME" node --version), bun $(docker exec "$NAME" bun --version), $(docker exec "$NAME" sh -c 'opencode --version 2>/dev/null')"
case "$(docker exec "$NAME" node --version)" in v24.*) check "Node 24 in the image" yes yes ;; *) check "Node 24 in the image" no yes ;; esac

status=000
for _ in $(seq 1 120); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
  [ "$status" = 200 ] && break
  sleep 0.5
done
check "/health" "$status" 200

ready=false
for _ in $(seq 1 120); do
  curl -s "http://127.0.0.1:$PORT/health" | grep -q '"isOpenCodeReady":true' && { ready=true; break; }
  sleep 0.5
done
check "OpenCode ready" "$ready" true
check "serves the UI" "$(curl -s "http://127.0.0.1:$PORT/" | grep -c -i '<html')" 1
check "API requires authentication" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/guests")" 401

if [ "$FAILED" != 0 ]; then docker logs "$NAME" 2>&1 | tail -30; fi
exit "$FAILED"

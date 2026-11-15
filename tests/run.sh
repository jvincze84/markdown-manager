#!/usr/bin/env bash
# Teljes tesztfuttatás Dockerben (helyben nem kell Node):
#   1. az app image buildelése
#   2. friss teszt git repók (tests/fixture/make-repo.sh, make-repo2.sh)
#   3. az app indítása, a teszt repók felvétele (API) + Sync
#   4. egységtesztek (node:test, az app image-ében)
#   5. böngészős tesztek (Playwright, hivatalos image)
# Használat:  tests/run.sh            – minden teszt
#             tests/run.sh unit       – csak egységtesztek
#             tests/run.sh e2e [-g minta]  – csak böngészős tesztek (Playwright argumentumokkal)
# Változók:   PORT (alap: 18080), KEEP=1 (a végén ne álljon le a teszt konténer)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
MODE=${1:-all}; [ $# -gt 0 ] && shift
PORT=${PORT:-18080}
IMAGE=markdown-manager:test
NAME=mm-e2e
PW_IMAGE=mcr.microsoft.com/playwright:v1.56.0-noble
WORK=$(mktemp -d)

cleanup() {
  [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true
  # a konténer által (más uid-dal) írt fájlok törlése is
  docker run --rm -v "$WORK:/w" alpine sh -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ Image build ($IMAGE)…"
docker build -q -t "$IMAGE" . >/dev/null

if [ "$MODE" = all ] || [ "$MODE" = unit ]; then
  echo "▶ Egységtesztek…"
  docker run --rm -v "$ROOT/tests/unit:/app/tests/unit:ro" "$IMAGE" node --test tests/unit/*.test.js
fi
[ "$MODE" = unit ] && exit 0

echo "▶ Teszt repók…"
mkdir -p "$WORK/repos"
tests/fixture/make-repo.sh "$WORK/repos/remote.git"   # „kb”: docs/ könyvtár, szerkesztési branchekkel
tests/fixture/make-repo2.sh "$WORK/repos/masik.git"   # „masik”: gyökér könyvtár
tests/fixture/make-repo2.sh "$WORK/repos/harmadik.git" # a felületről felvett / eltávolított repó (e2e)

echo "▶ App indítása (port $PORT)…"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:8080" \
  -v "$WORK/repos:/repos" -e GIT_URL=file:///repos \
  "$IMAGE" >/dev/null
for _ in $(seq 1 50); do curl -sf "localhost:$PORT/api/status" >/dev/null && break; sleep 0.2; done
wait_sync() {
  for _ in $(seq 1 100); do
    curl -s "localhost:$PORT/api/status" | grep -q '"syncing":false' && return; sleep 0.3
  done
}
add_repo() { # felvétel = azonnali sync (csak ez a repó)
  curl -sf -XPOST -H 'Content-Type: application/json' -d "$1" "localhost:$PORT/api/repos" >/dev/null \
    || { echo "✗ Repó felvétele sikertelen: $1"; docker logs "$NAME"; exit 1; }
  wait_sync
}
add_repo '{"id":"kb","path":"remote.git","docsPath":"docs"}'
add_repo '{"id":"masik","path":"masik.git"}'
curl -s "localhost:$PORT/api/status" | grep -q '"totalFiles":0' && { echo "✗ A sync nem töltött le fájlt"; docker logs "$NAME"; exit 1; }
curl -s "localhost:$PORT/api/status" | grep -q '"error":"' && { echo "✗ Sync hiba"; curl -s "localhost:$PORT/api/status"; exit 1; }

echo "▶ Böngészős tesztek…"
docker run --rm --network host --ipc=host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e NPM_CONFIG_UPDATE_NOTIFIER=false -e BASE_URL="http://localhost:$PORT" -e PW_OUTPUT=/tmp/pw-results \
  -v "$ROOT/tests:/tests" -w /tests/e2e "$PW_IMAGE" \
  sh -c 'npm ci --loglevel=error --no-audit --no-fund --cache /tmp/npm >/dev/null && npx playwright test "$@"' -- "$@"
echo "✓ Minden teszt sikeres."

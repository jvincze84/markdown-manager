#!/usr/bin/env bash
# Második (egyszerű) teszt git repó a tests/fixture/docs2 tartalmából – a gyökérben vannak a fájlok,
# nincs szerkesztési branch. Használat: make-repo2.sh <cél.git>
set -euo pipefail
TARGET=${1:?Használat: make-repo2.sh <cél könyvtár, pl. /tmp/x/masik.git>}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
g() { git -C "$WORK/src" -c user.name="Teszt Elek" -c user.email=teszt@example.com -c commit.gpgsign=false "$@"; }
mkdir -p "$WORK/src"
git -C "$WORK/src" -c init.defaultBranch=main init -q
cp -r "$HERE/docs2/." "$WORK/src/"
g add -A
g commit -qm "Második repó: kezdeti tartalom"
rm -rf "$TARGET"
git clone -q --bare "$WORK/src" "$TARGET"
git -C "$TARGET" config uploadpack.allowFilter true
git -C "$TARGET" config uploadpack.allowAnySHA1InWant true
chmod -R a+rwX "$TARGET"
echo "Teszt repó kész: $TARGET"

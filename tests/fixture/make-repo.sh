#!/usr/bin/env bash
# Teszt git repó (bare) felépítése a tests/fixture/docs tartalmából, ismert előzményekkel:
#   main:   docs/* (env.md 3 változattal → előzmények teszt)
#   md-edit/docs__config.md:                módosított fájl (2 commit a branch-en)
#   md-edit/docs__guide__telepites-linux.md: új fájl (csak a branch-en létezik)
# Használat: make-repo.sh <cél.git>
set -euo pipefail
TARGET=${1:?Használat: make-repo.sh <cél könyvtár, pl. /tmp/x/remote.git>}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

g() { git -C "$WORK/src" -c user.name="Teszt Elek" -c user.email=teszt@example.com -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }

mkdir -p "$WORK/src"
git -C "$WORK/src" -c init.defaultBranch=main init -q
cp -r "$HERE/docs" "$WORK/src/"
g add -A
g commit -qm "Kezdeti dokumentumok"

printf '\n## Második szakasz\n\nEz a 2. változat.\n' >> "$WORK/src/docs/env.md"
g commit -qam "env: második szakasz"
printf '\n## Harmadik szakasz\n\nEz a 3. változat.\n' >> "$WORK/src/docs/env.md"
g commit -qam "env: harmadik szakasz"

# Módosított fájl a saját szerkesztési branch-én (a "File:" trailer alapján ismeri fel az app)
g checkout -qb md-edit/docs__config.md
printf '# Konfig v2\n\nÚj sor a UI-ból.\n' > "$WORK/src/docs/config.md"
g commit -qam "Update docs/config.md" -m "File: docs/config.md"
printf '\nMásodik mentés.\n' >> "$WORK/src/docs/config.md"
g commit -qam "Második mentés" -m "File: docs/config.md"

# Új fájl, ami csak a branch-en létezik
g checkout -q main
g checkout -qb md-edit/docs__guide__telepites-linux.md
printf '# Új dokumentum\n\nLépések Linuxon.\n' > "$WORK/src/docs/guide/telepites-linux.md"
g add -A
g commit -qm "Add docs/guide/telepites-linux.md" -m "File: docs/guide/telepites-linux.md"
g checkout -q main

rm -rf "$TARGET"
git clone -q --bare "$WORK/src" "$TARGET"
git -C "$TARGET" config uploadpack.allowFilter true      # partial clone (--filter=blob:none)
git -C "$TARGET" config uploadpack.allowAnySHA1InWant true
git -C "$TARGET" config receive.denyDeleteCurrent false
chmod -R a+rwX "$TARGET"                                  # a konténer (node user) push-olhasson
echo "Teszt repó kész: $TARGET ($(git -C "$TARGET" for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' '))"

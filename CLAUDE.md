# Markdown Manager – útmutató a fejlesztéshez

Dockerizált Node.js webapp: egy git repó egy könyvtárából letölti a `*.md` fájlokat, megjeleníti,
kereshetővé és szerkeszthetővé teszi őket. Mentéskor **fájlonként egy branch**-re commitol és push-ol,
a pull requestet a felhasználó nyitja meg kézzel. A felhasználói dokumentáció: `README.md`.

## Együttműködés
- A felhasználó **magyarul** ír, magyarul válaszolj. A felület szövegei, a kód kommentjei és a README is magyarok.
- Minden új funkció után frissítsd a `README.md`-t (funkciólista / env változók).
- Változtatás után futtasd a teszteket (`tests/run.sh`), és új funkcióhoz írj e2e tesztet a `tests/e2e/app.spec.js`-be.
- Git: **csak lokális repó**, nincs remote – ne push-olj. Commitolni csak kérésre.

## Biztonsági követelmények (a felhasználó kifejezett kérései)
- `GIT_URL` és `GIT_TOKEN` **csak env változóból** jöhet. A token soha nem kerül lemezre: a git a
  `GIT_ASKPASS=askpass.sh` segítővel kapja meg, a hibaüzenetekből a `run()` kitakarja (`redact`).
- Egyedi CA: `GIT_CA_BUNDLE_BASE64` env változó (base64 PEM) → `/data/ca-bundle.pem` (rendszer CA-kkal összefűzve).
- A `.env` fájl a valódi titkokat tartalmazza: ne olvasd, ne commitold (benne van a `.gitignore`-ban).
- Új végpontoknál: útvonalak validálása (`safeRepoPath`, `newFilePath`), commit azonosító csak `^[0-9a-f]{7,40}$`.

## Build, futtatás, teszt
Helyben **nincs Node** – minden Dockerben fut.
- Élesítés: `docker compose up -d --build` (env: `.env`, adat: `md-data` volume → `/data`).
- Teljes teszt: `tests/run.sh` (build → friss teszt repó → app indítás → egységtesztek → Playwright).
  - `tests/run.sh unit` – csak egységtesztek; `tests/run.sh e2e -g "emoji"` – szűrt e2e.
  - `KEEP=1 tests/run.sh e2e` – a teszt konténer (`mm-e2e`, port 18080) futva marad kézi nézelődéshez.
- npm csomag hozzáadása helyben (lock frissítés):
  `docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/app -w /app node:22-alpine npm install --package-lock-only <csomag>`

## Architektúra
| Fájl | Szerep |
|---|---|
| `server.js` | Express: statikus fájlok, `/vendor/*`, `/assets/*` (repó fájlok + feltöltések + branch-fallback), REST API, háttér sync job, mutex (`exclusive`) |
| `lib/config.js` | env változók (lásd `.env.example`) |
| `lib/git.js` | minden git művelet: `run()` (askpass, CA, redact), partial clone + sparse checkout sync, `prepareBranch`/`commitAndPush` (temp index, munkakönyvtár érintése nélkül), `saveFile`, `deleteFile`, `deleteBranch`, `diffFile`, `revDiff`, `fileHistory`, `fileCommits`, `listEditBranches` |
| `lib/docs.js` | markdown-it renderelés (Prism színezés, mermaid, relatív linkek/képek → `/assets`), MiniSearch index, keresés (`query`) |
| `lib/prism-extend.js` | **közös** a szerver és a böngésző között: nyelv-aliasok, bash parancs-/kapcsolófelismerés |
| `public/app.js` | teljes kliens (vanilla JS, egy IIFE): fa, keresés, rétegek (`class Layer`), szerkesztő, diff, előzmények, téma, emoji választó |
| `public/mdtable.js` | markdown táblázat-igazító (böngészőben és egységtesztben is fut) |
| `public/style.css` | felület; **minden szín CSS-változó** (`:root` világos / `:root[data-theme="dark"]` sötét) |
| `public/code-theme.css` | kódszínezés témája (Material-szerű, világos + sötét) |
| `build/editor-entry.js` | esbuild bundle: Toast UI Editor + code-syntax-highlight plugin + Prism nyelvek → `public/vendor-built/` |
| `build/emoji-build.js` | build időben: `emojibase-data` (hu+en) → `vendor-built/emoji.json` (devDependency, nem kerül a runtime image-be) |

### Git munkafolyamat
- Sync: `clone --filter=blob:none --no-checkout` + sparse-checkout (md + képek a `GIT_DOCS_PATH` alatt), fetch alap branch + `md-edit/*`.
- Szerkesztési branch neve determinisztikus: `docs/guide/install.md` → `md-edit/docs__guide__install.md`
  (`branchName`). Minden commit üzenet végén `File: <útvonal>` trailer – ebből ismeri fel az app a fájlt.
- Állapotok: **módosított** (branch-en más tartalom), **új** (csak branch-en létezik, `isNew`),
  **törölt** (branch-en törlő commit, `isDeleted`). „Eldobás” = a branch törlése a szerverről.
- Feltöltött képek: `/data/uploads/<repo útvonal>` → mentéskor a markdownban hivatkozottak ugyanabba a commitba kerülnek.
- Partial clone miatt: `git log`/`diff` hívásoknál `--no-renames` (különben blobokat töltene le); `--follow` nincs.

### API röviden
`GET /api/status`, `/api/files`, `/api/search?name=&q=`, `/api/file?path=&source=base|branch&rev=`,
`/api/history?path=`, `/api/diff?path=[&rev=]`, `/api/sync/log?since=`;
`POST /api/sync`, `/api/file` (új), `/api/upload?doc=&name=`; `PUT /api/file` (mentés);
`DELETE /api/file` (törlés), `/api/branch` (eldobás).

## Buktatók (tapasztalatok)
- **Toast UI Editor**
  - `setMarkdown()` nem kerül az undo előzménybe → visszavonható cseréhez `setSelection` + `replaceSelection`.
  - Betöltés után az előzményt nullázni kell (`resetEditorHistory`), különben Ctrl+Z kiüríti a dokumentumot.
  - Egyedi eszköztár gomb: `insertToolbarItem` `command`-dal vagy `popup`-pal (ne `el`-lel). Felugró bezárása: `editor.eventEmitter.emit('closePopup')`.
  - Markdown módban a beillesztés egy rejtett `.toastui-editor-pseudo-clipboard` textarea-n fut.
  - A `customHTMLRenderer.image` a WYSIWYG módban is érvényes (relatív képútvonalak feloldása).
  - `destroy()` késleltetve (rejtett szerkesztő újrarajzolása DOM hibát dobna).
  - A code-syntax-highlight plugin CSS-e globálisan `overflow: visible`-t tesz a `pre[class*=language-]`-re → felülírva.
- A Prism nyelvi komponensek a globális `Prism`-re épülnek → `build/prism-setup.js` előbb fut.
- Új gomb / eseménykezelő hozzáadásakor ellenőrizd, hogy egy nagyobb blokk cseréje nem törölt-e ki
  szomszédos kódot (egyszer így tűnt el az „Új fájl” gomb kezelője) – erre valók az e2e tesztek.
- A felület magyar; dátumok `hu-HU`, rendezés `Intl.Collator('hu', { numeric: true })`.

## Tesztkörnyezet
- `tests/fixture/make-repo.sh <cél.git>`: bare repó a `tests/fixture/docs` tartalmából ismert előzményekkel
  (`env.md` 3 változat; `md-edit/docs__config.md` módosított; `md-edit/docs__guide__telepites-linux.md` új fájl).
- `tests/unit/*.test.js`: `node --test`, az app image-ében fut (`prismjs` onnan jön).
- `tests/e2e/app.spec.js`: Playwright 1.56 (`mcr.microsoft.com/playwright:v1.56.0-noble`), sorban fut egy közös szerveren;
  a módosító tesztek a végén eldobják a branch-eiket.

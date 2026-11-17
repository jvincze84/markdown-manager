# Markdown Manager – útmutató a fejlesztéshez

Dockerizált Node.js webapp: egy git szerver egy vagy több repójának (a felületen felvéve) egy-egy könyvtárából
letölti a `*.md` fájlokat, megjeleníti, kereshetővé és szerkeszthetővé teszi őket. Mentéskor **fájlonként egy branch**-re commitol és push-ol,
a pull requestet a felhasználó nyitja meg kézzel. A felhasználói dokumentáció: `README.md`.

## Együttműködés
- A felhasználó **magyarul** ír, magyarul válaszolj. A kód kommentjei és a README magyarok.
- A **felület angol** (gombok, üzenetek, sync napló, API hibaüzenetek, konzol), egynyelvű – nincs i18n. Új szöveg is angolul kerüljön be.
- Minden új funkció után frissítsd a `README.md`-t (funkciólista / env változók).
- Változtatás után futtasd a teszteket (`tests/run.sh`), és új funkcióhoz írj e2e tesztet a `tests/e2e/app.spec.js`-be.
- Git: **csak lokális repó**, nincs remote – ne push-olj. Commitolni csak kérésre.

## Verziók, release
- Kiadott verziók: `v1.0.0` (+ `release/1.0` branch) – egy-repós változat; `v2.0.0` (+ `release/2.0`) – több repós változat.
- Release menete (kérésre): `tests/run.sh` zöld → verzió emelés a `package.json`-ban **és** a `package-lock.json`
  két helyén → commit → annotált tag (`git tag -a vX.Y.Z -m "vX.Y.Z – rövid leírás"`) → `release/X.Y` branch a tagre.
- Főverzió, ha a beállítás (env / adatformátum) nem visszafelé kompatibilis; ilyenkor a README „Átállás” részét is frissítsd.

## Biztonsági követelmények (a felhasználó kifejezett kérései)
- `GIT_URL` (a git **szerver** alap URL-je) és `GIT_TOKEN` **csak env változóból** jöhet; a felületről csak
  a repó *relatív* útvonala adható meg (`lib/repos.js` `checkRepoPath`: nincs séma/host, `..`, `-` kezdet). A token soha nem kerül lemezre: a git a
  `GIT_ASKPASS=askpass.sh` segítővel kapja meg, a hibaüzenetekből a `run()` kitakarja (`redact`).
- Egyedi CA: `GIT_CA_BUNDLE_BASE64` env változó (base64 PEM) → `/data/ca-bundle.pem` (rendszer CA-kkal összefűzve).
- A `.env` fájl a valódi titkokat tartalmazza: ne olvasd, ne commitold (benne van a `.gitignore`-ban).
- Új végpontoknál: útvonalak validálása (`safeRepoPath`, `newFilePath`, `resolve`), commit azonosító csak `^[0-9a-f]{7,40}$`.
- Repó beállítások (azonosító, útvonal, branch, könyvtárak) csak a `lib/repos.js` `normalize`-on át kerülhetnek a `repos.json`-ba.
  Ugyanaz a repó több bejegyzésként is felvehető, de csak nem átfedő könyvtárakkal (azonos / egymásba ágyazott / gyökér = tiltva).

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
| `server.js` | Express: statikus fájlok, `/vendor/*`, `/assets/<repó>/*` (repó fájlok + feltöltések + branch-fallback), REST API, repónkénti állapot (`repos` Map → `ctx`), háttér sync job, közös mutex (`exclusive`) |
| `lib/config.js` | env változók (lásd `.env.example`); `parseGitUrl`: szerver URL vs. régi `.git` végű repó URL |
| `lib/repos.js` | felvett repók: `repos.json` olvasás/írás, bemenet-ellenőrzés (`normalize`), régi egy-repós beállítás átvétele (`loadOrMigrate`) |
| `lib/git.js` | közös: `run()` (askpass, CA, redact); repónként `forRepo(repo)`: partial clone + sparse checkout sync, `prepareBranch`/`commitAndPush` (temp index, munkakönyvtár érintése nélkül), `saveFile`, `deleteFile`, `deleteBranch`, `diffFile`, `revDiff`, `fileHistory`, `fileCommits`, `listEditBranches` |
| `lib/docs.js` | markdown-it renderelés (Prism színezés, mermaid, relatív linkek/képek → `/assets`), repónkénti dokumentumtár, közös MiniSearch index, keresés (`query`, repó szűréssel) |
| `lib/prism-extend.js` | **közös** a szerver és a böngésző között: nyelv-aliasok, bash parancs-/kapcsolófelismerés |
| `public/app.js` | teljes kliens (vanilla JS, egy IIFE): fa, keresés, repó szűrő, repókezelő, rétegek (`class Layer`), szerkesztő, diff, előzmények, téma, emoji választó |
| `public/mdtable.js` | markdown táblázat-igazító (böngészőben és egységtesztben is fut) |
| `public/style.css` | felület; **minden szín CSS-változó** (`:root` világos / `:root[data-theme="dark"]` sötét) |
| `public/code-theme.css` | kódszínezés témája (Material-szerű, világos + sötét) |
| `build/editor-entry.js` | esbuild bundle: Toast UI Editor + code-syntax-highlight plugin + Prism nyelvek → `public/vendor-built/` |
| `build/emoji-build.js` | build időben: `emojibase-data` (hu+en) → `vendor-built/emoji.json` (devDependency, nem kerül a runtime image-be) |

### Több repó
- **Virtuális útvonal** mindenhol a kliens és az API között: `<repó azonosító>/<repó-relatív útvonal>`
  (`kb/docs/env.md`). A szerver `resolve()`-val bontja `{ ctx, rel }`-re; git műveletek mindig a `rel`-lel,
  a branch nevek és `File:` trailerek repón belüliek (nem tartalmazzák az azonosítót).
- A docs `docPath` (megjelenített útvonal) = `<azonosító>/<útvonal a repó könyvtárához képest>` → a fa legfelső szintje a repó.
- Adat: `/data/repos.json` (beállítások), `/data/repos/<id>` (klón), `/data/uploads/<id>/<rel>` (feltöltések),
  `/data/last-sync.json`. Az `/assets` közvetlenül a `/data/repos` és `/data/uploads` alól szolgál ki (csak felvett repó, `.git` tiltva).
- Linkek: `/` kezdetű hivatkozás = a repó gyökere; repóból kivezető relatív link nem oldódik fel (szerver: `resolveRel`, kliens: `resolveAssetUrl`).
- Repó felvétele/módosítása után azonnal sync indul (csak arra a repóra); sync közben nem lehet repót felvenni/módosítani (409).
- Kliens: `repoFilter` (localStorage) – üres vagy mind kiválasztva = nincs szűrés; a fa repó csomópontjainál a
  *csukottakat* tároljuk (`closedRepos`), hogy egy új repó nyitva jelenjen meg.

### Git munkafolyamat
- Sync: `clone --filter=blob:none --no-checkout` + sparse-checkout (md + képek a repó könyvtára alatt), fetch alap branch + `md-edit/*`.
- Szerkesztési branch neve determinisztikus: `docs/guide/install.md` → `md-edit/docs__guide__install.md`
  (`branchName`). Minden commit üzenet végén `File: <útvonal>` trailer – ebből ismeri fel az app a fájlt.
- Állapotok: **módosított** (branch-en más tartalom), **új** (csak branch-en létezik, `isNew`),
  **törölt** (branch-en törlő commit, `isDeleted`). „Eldobás” = a branch törlése a szerverről.
- Feltöltött képek: `/data/uploads/<repó>/<repo útvonal>` → mentéskor a markdownban hivatkozottak ugyanabba a commitba kerülnek.
- Partial clone miatt: `git log`/`diff` hívásoknál `--no-renames` (különben blobokat töltene le); `--follow` nincs.

### API röviden
(`path` mindig virtuális útvonal.)
`GET /api/status`, `/api/repos`, `/api/files`, `/api/search?name=&q=&repos=a,b`, `/api/file?path=&source=base|branch&rev=`,
`/api/history?path=`, `/api/diff?path=[&rev=]`, `/api/sync/log?since=`;
`POST /api/sync` (`{repos?: [id]}`), `/api/repos` (felvétel), `/api/file` (új: `{repo, path}`), `/api/upload?doc=&name=`;
`PUT /api/file` (mentés), `/api/repos/:id` (módosítás); `DELETE /api/file` (törlés), `/api/branch` (eldobás), `/api/repos/:id`.

## Buktatók (tapasztalatok)
- **Toast UI Editor**
  - `setMarkdown()` nem kerül az undo előzménybe → visszavonható cseréhez `setSelection` + `replaceSelection`.
  - Betöltés után az előzményt nullázni kell (`resetEditorHistory`), különben Ctrl+Z kiüríti a dokumentumot.
  - Módváltáskor (`changeMode`) a Toast UI visszavonható tranzakcióval cseréli a teljes dokumentumot → a
    `changeMode` eseményre is `resetEditorHistory` fut (különben Ctrl+Z a másik mód elavult állapotára állna vissza).
  - Egyedi eszköztár gomb: `insertToolbarItem` `command`-dal vagy `popup`-pal (ne `el`-lel). Felugró bezárása: `editor.eventEmitter.emit('closePopup')`.
  - Markdown módban a beillesztés egy rejtett `.toastui-editor-pseudo-clipboard` textarea-n fut.
  - A `customHTMLRenderer.image` a WYSIWYG módban is érvényes (relatív képútvonalak feloldása).
  - `destroy()` késleltetve (rejtett szerkesztő újrarajzolása DOM hibát dobna).
  - A code-syntax-highlight plugin CSS-e globálisan `overflow: visible`-t tesz a `pre[class*=language-]`-re → felülírva.
- A Prism nyelvi komponensek a globális `Prism`-re épülnek → `build/prism-setup.js` előbb fut.
- Új gomb / eseménykezelő hozzáadásakor ellenőrizd, hogy egy nagyobb blokk cseréje nem törölt-e ki
  szomszédos kódot (egyszer így tűnt el az „Új fájl” gomb kezelője) – erre valók az e2e tesztek.
- A felület angol; dátumok `en-GB` (`LOCALE` az `app.js`-ben, szerveren a sync napló ideje), relatív idő `Intl.RelativeTimeFormat('en')`.
  A rendezés `Intl.Collator('hu', { numeric: true })` marad (a fájlnevek / tartalom jellemzően magyar).
- Az emoji-választó csak angol nevekkel/kulcsszavakkal keres (`build/emoji-build.js`).

## Tesztkörnyezet
- `tests/fixture/make-repo.sh <cél.git>`: bare repó a `tests/fixture/docs` tartalmából ismert előzményekkel
  (`env.md` 3 változat; `md-edit/docs__config.md` módosított; `md-edit/docs__guide__telepites-linux.md` új fájl).
- `tests/fixture/make-repo2.sh <cél.git>`: egyszerű repó a `tests/fixture/docs2` tartalmából (gyökér könyvtár).
- A `tests/run.sh` `GIT_URL=file:///repos`-szal indít, és API-n veszi fel a `kb` (`remote.git`, `docs`) és
  `masik` (`masik.git`) repót; a `harmadik.git`-et az e2e teszt veszi fel és távolítja el a felületről.
- `tests/unit/*.test.js`: `node --test`, az app image-ében fut (`prismjs` onnan jön).
- `tests/e2e/app.spec.js`: Playwright 1.56 (`mcr.microsoft.com/playwright:v1.56.0-noble`), sorban fut egy közös szerveren;
  a módosító tesztek a végén eldobják a branch-eiket.

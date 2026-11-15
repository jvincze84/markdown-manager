# Markdown Manager

Docker-ben futó webalkalmazás, ami egy git szerver egy vagy több repójának adott könyvtárából letölti a `*.md` fájlokat, formázottan megjeleníti, kereshetővé teszi, és lehetővé teszi a szerkesztésüket. A mentés egy fájlonkénti branch-be push-ol. A git szerver és a token környezeti változóban van megadva, a repókat a felületen lehet felvenni.

## Indítás

```bash
cp .env.example .env      # GIT_URL (a git szerver), GIT_TOKEN, ... kitöltése
docker compose up -d --build
# → http://localhost:8080, majd "⚙ Repók" → repó felvétele (azonnal letöltődik)
```

Vagy compose nélkül:

```bash
docker build -t markdown-manager .
docker run -d -p 8080:8080 -v md-data:/data \
  -e GIT_URL=https://git.myserver.hu -e GIT_TOKEN=xxx markdown-manager
```

## Környezeti változók

| Változó | Alapérték | Leírás |
|---|---|---|
| `GIT_URL` | – | A git szerver HTTPS alap URL-je, pl. `https://git.myserver.hu` (**kötelező**). A repó URL-je: `<GIT_URL>/<repó útvonal>` |
| `GIT_TOKEN` | – | Access token, push joggal (az összes felvett repóhoz ugyanez) |
| `GIT_USERNAME` | `oauth2` | Tokenhez tartozó felhasználónév (Bitbucket: `x-token-auth`) |
| `GIT_BRANCH` | `main` | Új repó felvételekor az alapértelmezett alap branch |
| `EDIT_BRANCH_PREFIX` | `md-edit/` | Szerkesztési branchek előtagja |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `Markdown Manager` | Commit szerző |
| `GIT_CA_BUNDLE_BASE64` | – | Egyedi CA bundle (PEM) base64-ben: `base64 -w0 ca.pem`. A rendszer CA-kkal összefűzve használja |
| `APP_USERNAME` / `APP_PASSWORD` | – | Opcionális Basic Auth a felülethez |

### Átállás a régi (egy-repós) beállításról

A korábbi verzióban a `GIT_URL` egy konkrét repóra mutatott (`https://…/csoport/repo.git`), a könyvtárat a
`GIT_DOCS_PATH`, a képkönyvtárat a `GIT_ASSETS_PATH` adta meg. Ha ilyen `.git` végű `GIT_URL`-lel indul az app, és
még nincs felvett repó (`/data/repos.json`), akkor automatikusan átáll: a szerver része lesz az alap URL, a repó
pedig első repóként felvételre kerül (`GIT_BRANCH`, `GIT_DOCS_PATH`, `GIT_ASSETS_PATH` alapján; az azonosító a repó
nevéből képződik). A meglévő helyi másolat és a még nem mentett képfeltöltések átköltöznek, nem kell újra letölteni.
Ezután a `.env`-ben a `GIT_URL` átírható a szerver címére, a `GIT_DOCS_PATH` / `GIT_ASSETS_PATH` törölhető.
Visszalépés: a `v1.0.0` tag / `release/1.0` branch az egy-repós változat (a több repós a `v2.0.0` / `release/2.0`).

## Működés

- **Több repó**: a fejléc „⚙ Repók” gombja nyitja a repókezelőt. Új repó felvétele: a repó útvonala a szerveren
  (pl. `csoport/repo.git` – csak relatív útvonal, így a token más hostra nem kerülhet), azonosító (a fa legfelső
  szintje; alapból a repó nevéből, pl. `repo`), alap branch, könyvtár a repóban (üres = a repó gyökere) és a
  képek könyvtára (alapból `<könyvtár>/assets`). Felvétel után azonnal letöltődik. A meglévő repók ugyanitt
  egyenként frissíthetők (⟳), módosíthatók (✎: branch, könyvtár, képkönyvtár – utána újra letöltődik) és
  eltávolíthatók (🗑: csak a helyi másolat törlődik, a git szerveren semmi nem változik). A beállítások a
  `/data/repos.json`-ban, a helyi másolatok a `/data/repos/<azonosító>` alatt vannak.
- **Útvonalak**: minden fájl útvonala `<repó azonosító>/<útvonal a repóban>` (pl. `kb/docs/guide/install.md`); a
  fában a repó a legfelső szint (📦), alatta a repó könyvtárának tartalma. A markdownban a `/` kezdetű
  hivatkozások a repó gyökeréhez képest értendők; repóból kivezető relatív hivatkozás nem oldódik fel.
- **Repó szűrő**: legalább két repónál a „📦 Repó: …” gomb lenyílójában több repó is kiválasztható; ilyenkor a
  fa, a „Módosított / új” lista és számláló, valamint a keresés is csak a kiválasztott repókra vonatkozik. Ha egy
  sincs vagy mind ki van választva, nincs szűrés. A választást a böngésző megjegyzi.
- **Téma**: világos és sötét téma; a fejléc 🌓/☀️/🌙 gombja vált: automatikus (az operációs rendszer / böngésző beállítását követi, akár menet közben is) → világos → sötét. A választást a böngésző megjegyzi. A sötét téma a nézetre, a kódszínezésre (Material „slate” paletta), a szerkesztőre, a diffre és a Mermaid diagramokra is vonatkozik.
- **Sync**: a „⟳ Sync” gomb az összes repót frissíti, egymás után (egy repó hibája nem állítja meg a többit; a hibás repó a fában és az állapotsorban jelölve van). Partial clone (`--filter=blob:none`) + sparse-checkout, így csak a repó beállított könyvtára alatti `*.md` fájlok (és a beágyazott képek) töltődnek le. Az adatok a `/data` volume-ban maradnak, újraindítás után is elérhetők. Sync közben a renderelt HTML és a keresési index is újragenerálódik.
- **Sync napló**: a Sync gomb egy naplóablakot nyit (lépések, git progress, progress bar). Bezárható, a sync a háttérben fut tovább; a gombra kattintva újra megnyílik.
- **Fájllista**: minden fájl mellett az utolsó módosítás ideje (relatív, pl. „2 órával ezelőtt”), az utolsó commit rövid hash-e és egy ✎ gomb, amely rögtön szerkesztő módban nyitja meg a fájlt. Módosított / új fájlnál a szerkesztési branch utolsó mentése látszik (sárgán, ✎ jellel). A dátumra állva megjelenik a teljes időpont, a szerző és a commit üzenet (módosított fájlnál a branch és az alap branch adatai is). http/https `GIT_URL` esetén a hash a commit oldalára mutató link (GitHub / GitLab / Gitea / Bitbucket). Az adatok sync után frissülnek, egyetlen `git log` alapján (blobok letöltése nélkül).
- **Könyvtárfa**: „⊞ Mind kibont” / „⊟ Mind összecsuk” gombok; a kibontott könyvtárakat (és az összecsukott repókat) a böngésző megjegyzi (újratöltés, mentés, sync után is megmarad). Újonnan felvett repó nyitva jelenik meg.
- **Szűrők törlése**: ha keresés, a „Módosított / új” vagy a repó szűrő aktív, a „✕ Szűrők törlése” gomb egy kattintással mindet törli, és visszaáll a teljes fa.
- **Szűrő**: a „✎ Módosított / új” gomb csak azokat a fájlokat mutatja, amelyekhez szerkesztési branch tartozik, mindegyik mellett „Pull request” gombbal. A kereséssel kombinálható.
- **Keresés**: két külön mező, ha mindkettő ki van töltve, ÉS kapcsolattal szűrnek:
  - **📄 Fájlnév** (`/` billentyű): részsztring az útvonalban, minden szónak szerepelnie kell, ékezetfüggetlen.
  - **🔍 Tartalom**: pontos részszöveg-egyezés (minden szónak szerepelnie kell, kis/nagybetű- és ékezetfüggetlen), kiemelt szövegrészlettel. Számoknál szóhatár: `172.21.23.12` nem egyezik a `172.21.23.120`-szal. Módosított fájloknál az alap és a módosított verzióban is keres. Ha nincs pontos találat és sima szavakra keresel, elgépelés-tűrő „hasonló” találatokat ad (külön jelölve).
  - Tartalom találat megnyitásakor a keresett szöveg ki van jelölve a dokumentumban, az első előfordulásra ugrik; a fejlécben „‹ ›” gombokkal (vagy F3 / Shift+F3) lehet lépkedni a találatok között.
- **Megtekintés**: a fájl új layerben nyílik meg; a relatív `.md` linkek újabb layert nyitnak egymásra. `Esc` bezárja a legfelsőt. Alapból a teljes szélességet kihasználja; a „↔ Szélesség” gombbal keskeny (olvasóbarát) nézetre váltható, ezt a böngésző megjegyzi.
- **Előzmények**: megnyitott fájlnál a „🕘 Előzmények” lenyílóból a fájl korábbi változatai nézhetők meg (a szerkesztési branch commitjai ✎ jellel, külön csoportban, alatta az alap branch előzményei; legfeljebb 100–100). Régebbi változatnál sárga sáv jelzi, melyik commitot látod, egy kattintással vissza lehet térni az aktuálishoz. A sáv „± Diff az aktuálishoz” gombja a markdown forrás eltéréseit mutatja a régi és az aktuális változat (szerkesztési branch, ha van; különben az alap branch) között, egymás mellett vagy egybefűzve, az azóta készült commitokkal. A „Szerkesztés” mindig az aktuális változatot nyitja meg.
- **Kódblokkok**: szintaxis kiemelés Prism-mel, a nézetben és az editor előnézetében / WYSIWYG módjában is ugyanazzal a Material-szerű témával (`public/code-theme.css`). Bash-nél a parancsok (ismeretlenek is, pl. `kubectl`, `helm`, `./deploy.sh`), a kapcsolók (`-v`, `--dry-run`), a változók és a szövegek külön színt kapnak. Nyelvek: a nézetben az összes Prism nyelv, az editorban kb. 40 (pl. bash/shell, yaml, json, sql, python, js/ts, java, go, rust, c/c++, c#, php, ruby, powershell, dockerfile, nginx, hcl/terraform, ini, toml, xml/html, diff, markdown stb.), nyelvcímke és „⧉ Másolás” gomb (egérrel fölé állva jelenik meg). Sima HTTP-n is működik (tartalék vágólap-kezeléssel).
- **Táblázatok**: a renderelt táblázatok oszlopai a fejlécre kattintva rendezhetők (növekvő → csökkenő → eredeti; számokat, pl. „16 GB”, „2,5”, számként, szöveget magyar ábécé szerint rendez).
- **Szerkesztés**: Toast UI Editor (15px-es betűmérettel), side-by-side előnézettel (◫ Nézet gombbal fülekre váltható, WYSIWYG mód is van). `Ctrl+S` ment.
  - Az eszköztár **😀** gombja emoji-választót nyit: keresés magyarul és angolul is (pl. „szív”, „pipa”, „rakéta”, „thumbs up”, GitHub-rövidítések: „tada”), kategóriák, legutóbb használtak. Kattintásra beszúrja az emojit a kurzorhoz (Unicode karakterként), Shift+kattintásra nyitva marad több emojihoz; a keresőben Enter az első találatot szúrja be.
  - Az eszköztár **⊞⇥ Táblázatok rendezése** gombja a dokumentum összes markdown táblázatát igazítja: szóközökkel kitölti a cellákat, hogy az oszlopok egymás alá kerüljenek (a `:---:` igazítást is követi; kódblokkokat nem érint). `Ctrl+Z`-vel visszavonható. A markdown szerkesztőben a táblázatsorok fix szélességű betűvel jelennek meg.
- **Képek beszúrása**: az editor „kép beszúrása” ablakából, vágólapról beillesztve (pl. képernyőkép) vagy behúzva a kép nem base64-ként kerül a szövegbe, hanem feltöltődik a repó képkönyvtárába (alapból `<könyvtár>/assets`, pl. `docs/assets`), és rövid relatív hivatkozás kerül a szövegbe, pl. `![abra](../assets/abra-1a2b3c4d.png)`. A fájlnév ékezet nélküli, a végén a tartalom hash-ével (ugyanaz a kép nem duplikálódik). A kép a markdown fájl mentésekor **ugyanabba a commitba** kerül, a fájl saját branch-ére – így a PR a képet is tartalmazza. Mentésig a szerveren várakozik (`/data/uploads/<repó>`, 30 nap után törlődik). Formátumok: png, jpg, gif, webp, svg (max. 20 MB).
- **Mentés**: a fájlhoz (a saját repójában) determinisztikus branch tartozik, pl. `docs/guide/install.md` → `md-edit/docs__guide__install.md`. Az első mentés az alap branch-ből hozza létre, a további mentések ugyanebbe a branch-be kerülnek új commitként. Ha a branch-et közben törölték (pl. merge után), a következő mentés újra a friss alap branch-ből indul. A helyi, megjelenített alap verziót a mentés nem módosítja; ha egy fájlnak van szerkesztési branch-e, a layerben választható, hogy a módosított vagy az alap verzió látszódjon. GitHub / GitLab / Gitea / Bitbucket esetén megjelenik egy „Pull request” link is.
- **Diff**: módosított fájlnál a „Módosított / main / ± Diff” váltóval megnézhetők a változások az alap branch-hez képest (PR-szerűen, a leágazási ponttól), egymás mellett vagy egybefűzve, szóiszintű kiemeléssel, a branch commitjaival.
- **Törlés**: a „🗑 Törlés” gomb (megerősítés után) egy törlő commitot tesz a fájl saját branch-ére (pl. `md-edit/docs__guide__install.md`), a fájl tehát a pull request merge-e után törlődik az alap branch-ből. Addig „törölt” jelöléssel (áthúzva) látszik a listában, megnyitva piros sáv jelzi, szerkeszteni nem lehet, a „± Diff” a törlést mutatja. Az „↺ Eldobás” visszavonja. Új (csak branch-en létező) fájlnál nincs külön törlés: ott az Eldobás törli a fájlt.
- **Eldobás**: a „↺ Eldobás” gomb (megerősítés után) törli a szerkesztési branch-et a szerverről; a fájl visszaáll az alap verzióra (törlésre jelölt fájlnál a törlés visszavonódik), új fájl esetén eltűnik.
- **Új fájl**: a „＋ Új fájl” gombbal. Több repónál előbb a repót kell kiválasztani (alapból a repó szűrőben egyedül kiválasztott, különben a legutóbb használt repó). Az útvonal a repó könyvtárához relatív (pl. `guide/uj-oldal`, a `.md` kiterjesztés automatikus), a repó meglévő könyvtárai felajánlódnak. Mentéskor a fájl ugyanúgy a saját branch-ére kerül (`md-edit/docs__guide__uj-oldal.md`). Amíg nincs merge-ölve, „új” jelöléssel látszik a listában és a keresésben is. A felismerés a commit `File:` trailere alapján működik, így újraindítás vagy sync után sem vész el.
- A token csak környezeti változóban él (`GIT_ASKPASS` helperrel jut el a githez), nem kerül a `.git/config`-ba.

## Fejlesztés, tesztek

Helyben nem kell Node, minden Dockerben fut:

```bash
tests/run.sh              # build + egységtesztek + böngészős (Playwright) tesztek
tests/run.sh unit         # csak egységtesztek
tests/run.sh e2e -g emoji # csak a szűrt böngészős tesztek
KEEP=1 tests/run.sh e2e   # a teszt konténer (http://localhost:18080) futva marad
```

A tesztek eldobható git repókkal dolgoznak (`tests/fixture/make-repo.sh`, `make-repo2.sh`), a valódi repókat nem érintik.
A fejlesztési jegyzetek (architektúra, döntések, buktatók): `CLAUDE.md`.

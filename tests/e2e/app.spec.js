// Markdown Manager – böngészős regressziós tesztek.
// Előfeltétel: a tests/run.sh által indított szerver a tests/fixture/make-repo.sh teszt-repóval.
const { test, expect } = require('@playwright/test');
const path = require('path');

const IMG = path.join(__dirname, '..', 'fixture', 'piros.png');
const md = (page) => page.locator('.toastui-editor-md-container .ProseMirror');
const layer = (page) => page.locator('.layer').last();

async function home(page) {
  await page.goto('/');
  await page.waitForSelector('a.file', { state: 'attached' });
}
async function openFile(page, p) {
  await page.click(`a.file[data-path="${p}"]`);
  await expect(layer(page).locator('.title')).not.toBeEmpty();
}
/** Teszt közben létrehozott szerkesztési branch eldobása (takarítás). */
async function discard(request, p) {
  await request.delete(`/api/branch?path=${encodeURIComponent(p)}`).catch(() => {});
}
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test.describe.configure({ mode: 'serial' });

test('fájllista: fa, metaadatok, jelölések, kibont/összecsuk', async ({ page }) => {
  const errors = collectErrors(page);
  await home(page);
  const row = page.locator('li.frow:has(a[data-path="kb/docs/env.md"])');
  await expect(row.locator('.fhash')).toHaveText(/^[0-9a-f]{7}$/);
  await expect(row.locator('.fdate')).not.toBeEmpty();
  await expect(page.locator('a.file[data-path="kb/docs/config.md"] .badge')).toBeVisible(); // módosított
  await expect(page.locator('a.file[data-path="kb/docs/guide/telepites-linux.md"] .badge.new')).toBeVisible(); // új
  await expect(page.locator('#filter-count')).toHaveText('2');

  await page.click('#collapse-all');
  await expect(page.locator('a.file[data-path="kb/docs/guide/install.md"]')).toBeHidden();
  await page.reload();
  await expect(page.locator('a.file[data-path="kb/docs/guide/install.md"]')).toBeHidden(); // megjegyzi
  await page.click('#expand-all');
  await expect(page.locator('a.file[data-path="kb/docs/guide/install.md"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keresés: fájlnév + tartalom, kiemelés a dokumentumban, szűrők törlése', async ({ page }) => {
  await home(page);
  await page.fill('#search-content', 'GIT_URL');
  await expect(page.locator('.result[data-path="kb/docs/env.md"]')).toBeVisible();
  await page.fill('#search-name', 'env');
  await expect(page.locator('.result')).toHaveCount(1);
  await page.click('.result[data-path="kb/docs/env.md"]');
  await expect(layer(page).locator('mark.search-hit').first()).toBeVisible();
  await expect(layer(page).locator('.hit-count')).toHaveText(/^1 \/ \d+$/);
  await page.keyboard.press('Escape');

  await expect(page.locator('#clear-filters')).toBeVisible();
  await page.click('#clear-filters');
  await expect(page.locator('#search-name')).toHaveValue('');
  await expect(page.locator('#search-content')).toHaveValue('');
  await expect(page.locator('#tree')).toBeVisible();
});

test('keresés: idézőjeles több szavas kifejezés (pontos egyezés, formázáson átívelve is)', async ({ page }) => {
  await home(page);
  const count = page.locator('#results .rcount');
  await page.fill('#search-content', 'szöveg kiemelt'); // külön szavak: sorrendtől függetlenül egyezik
  await expect(page.locator('.result[data-path="kb/docs/env.md"]')).toBeVisible();
  await page.fill('#search-content', '"szöveg kiemelt"'); // kifejezés: ebben a sorrendben nincs
  await expect(count).toContainText('No results');
  await page.fill('#search-content', '„és a  KIEMELT szoveg”'); // magyar idézőjel, ékezet/kisbetű/szóköz-független
  await expect(page.locator('.result')).toHaveCount(1);
  await expect(page.locator('.result[data-path="kb/docs/env.md"] .rsnip mark')).toHaveText('és a kiemelt szöveg');
  await page.click('.result[data-path="kb/docs/env.md"]');
  // a dokumentumban a <strong>-on átívelő kifejezés egy találat
  await expect(layer(page).locator('.hit-count')).toHaveText('1 / 1');
  await expect(layer(page).locator('mark.search-hit')).toHaveCount(3); // "és a " + "kiemelt" + " szöveg"
});

test('nézet: kódszínezés, másolás, rendezhető táblázat, mermaid, hosszú sor görgetése', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = collectErrors(page);
  await home(page);
  await openFile(page, 'kb/docs/kodok.md');
  const bash = layer(page).locator('pre.code-hl.language-bash');
  await expect(bash.locator('.token.command', { hasText: 'kubectl' })).toBeVisible(); // bővített bash színezés
  await expect(bash.locator('.token.parameter', { hasText: '--dry-run' })).toBeVisible();
  await expect(layer(page).locator('pre.language-yaml .token.key').first()).toBeVisible();

  await layer(page).locator('.code-wrap').first().hover();
  await layer(page).locator('.code-copy').first().click();
  await expect(layer(page).locator('.code-copy').first()).toHaveText('✓ Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('kubectl get pods');

  const th = layer(page).locator('table th').first();
  await th.click(); // ▲ növekvő
  await expect(th).toHaveAttribute('aria-sort', 'ascending');
  await expect(layer(page).locator('table tbody tr').first()).toContainText('db');
  await th.click(); // ▼
  await expect(layer(page).locator('table tbody tr').first()).toContainText('web');

  await expect(layer(page).locator('pre.mermaid svg')).toBeVisible();
  await page.keyboard.press('Escape');

  await openFile(page, 'kb/docs/hosszu.md');
  const pre = layer(page).locator('pre.code-hl.language-bash');
  expect(await pre.evaluate((x) => getComputedStyle(x).overflowX)).toBe('auto');
  expect(await pre.evaluate((x) => x.scrollWidth > x.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('előzmények: régi változat, diff az aktuálishoz, vissza', async ({ page }) => {
  await home(page);
  await openFile(page, 'kb/docs/env.md');
  const sel = layer(page).locator('select.history');
  await expect(sel.locator('option')).toHaveCount(4); // fejléc + 3 commit
  const oldest = await sel.locator('option').last().getAttribute('value');
  await sel.selectOption(oldest);
  await expect(layer(page).locator('.rev-banner')).toBeVisible();
  await expect(layer(page).locator('.markdown-body')).not.toContainText('Harmadik');

  await layer(page).locator('.rev-diff').click();
  await expect(layer(page).locator('.diff-info')).toContainText('current (main)');
  await expect(layer(page).locator('.d2h-ins').first()).toBeVisible();
  await layer(page).locator('.diff-back').click();
  await expect(layer(page).locator('.rev-banner')).toBeVisible();
  await layer(page).locator('.rev-back').click();
  await expect(layer(page).locator('.rev-banner')).toBeHidden();
  await expect(layer(page).locator('.markdown-body')).toContainText('Harmadik');

  // a „Szerkesztés” régi változat nézése közben is az aktuálisat nyitja
  await sel.selectOption(oldest);
  await layer(page).locator('.edit').click();
  await expect(md(page)).toContainText('Harmadik');
});

test('módosított fájl: Módosított / main / Diff váltó', async ({ page }) => {
  await home(page);
  await openFile(page, 'kb/docs/config.md');
  await expect(layer(page).locator('.markdown-body')).toContainText('Konfig v2');
  await layer(page).locator('.source-toggle [data-src="base"]').click();
  await expect(layer(page).locator('.markdown-body')).toContainText('Konfiguráció');
  await layer(page).locator('.source-toggle [data-src="diff"]').click();
  await expect(layer(page).locator('.diff-info')).toContainText('md-edit/docs__config.md');
});

test('szerkesztés: Ctrl+Z nem üríti ki, táblázatrendező, mentés branch-re, eldobás', async ({ page, request }) => {
  const errors = collectErrors(page);
  await home(page);
  await openFile(page, 'kb/docs/tablak.md');
  await layer(page).locator('.edit').click();
  await md(page).click();
  await page.keyboard.press('Control+z'); // betöltés után: nem üríti ki a dokumentumot
  await expect(md(page)).toContainText('|Név|RAM|Hely|Megjegyzés|');

  await page.click('.tbl-format');
  await expect(md(page)).toContainText('| Név     |      RAM |');
  await page.keyboard.press('Control+z'); // a rendezés visszavonható
  await expect(md(page)).toContainText('|Név|RAM|Hely|Megjegyzés|');
  await page.click('.tbl-format');

  await layer(page).locator('.commit-msg').fill('e2e: táblázat rendezés');
  await layer(page).locator('.save').click();
  await expect(page.locator('.toast.success', { hasText: 'md-edit/docs__tablak.md' })).toBeVisible();
  await expect(layer(page).locator('.source-toggle')).toBeVisible();
  const r = await (await request.get('/api/file?path=kb/docs/tablak.md&source=branch')).json();
  expect(r.content).toContain('| zeta-01 |    16 GB |');

  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.discard').click();
  await expect(layer(page).locator('.source-toggle')).toBeHidden();
  expect(errors).toEqual([]);
});

test('képfeltöltés: assets könyvtárba, relatív link, ugyanabba a commitba', async ({ page, request }) => {
  await home(page);
  await page.click('li.frow:has(a[data-path="kb/docs/guide/install.md"]) .fedit');
  await md(page).click();
  await page.keyboard.press('Control+End');
  await page.click('.toastui-editor-toolbar-icons.image');
  await page.setInputFiles('.toastui-editor-popup-add-image input[type=file]', IMG);
  await page.click('.toastui-editor-popup-add-image .toastui-editor-ok-button');
  await expect(md(page)).toContainText(/!\[piros\]\(\.\.\/assets\/piros-[0-9a-f]{8}\.png\)/);
  await expect(md(page)).not.toContainText('data:image');
  const src = await page.locator('.toastui-editor-md-preview img[src*="piros"]').getAttribute('src');
  expect((await request.get(src)).ok()).toBe(true);

  await layer(page).locator('.save').click();
  await expect(page.locator('.toast.success', { hasText: 'md-edit/docs__guide__install.md' })).toBeVisible();
  const diff = await (await request.get('/api/diff?path=kb/docs/guide/install.md')).json();
  expect(diff.diff).toContain('piros-');
  expect((await request.get(src)).ok()).toBe(true); // mentés után a branch-ről is kiszolgálható
  await discard(request, 'kb/docs/guide/install.md');
});

test('új fájl: létrehozás, mentés, megjelenik a fában', async ({ page, request }) => {
  await home(page);
  await page.click('#new-file');
  await layer(page).locator('.new-path-repo').selectOption('kb');
  await layer(page).locator('.new-path-input').fill('guide/e2e-uj');
  await md(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('E2E teszt tartalom.');
  await layer(page).locator('.save').click();
  await expect(page.locator('.toast.success', { hasText: 'md-edit/docs__guide__e2e-uj.md' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file[data-path="kb/docs/guide/e2e-uj.md"] .badge.new')).toBeVisible();
  await discard(request, 'kb/docs/guide/e2e-uj.md');
});

test('törlés: törlő commit a branch-re, jelölés, eldobással visszavonható', async ({ page }) => {
  await home(page);
  await openFile(page, 'kb/docs/yaml.md');
  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.delete').click();
  await expect(layer(page).locator('.del-banner')).toBeVisible();
  await expect(layer(page).locator('.edit')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file.deleted[data-path="kb/docs/yaml.md"]')).toBeVisible();

  await openFile(page, 'kb/docs/yaml.md');
  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.discard').click();
  await expect(layer(page).locator('.del-banner')).toBeHidden();
  await expect(layer(page).locator('.edit')).toBeVisible();
});

test('WYSIWYG ↔ Markdown váltás: a módosítás megmarad, Ctrl+Z nem lép vissza a váltás elé', async ({ page }) => {
  const ww = page.locator('.toastui-editor-ww-container .ProseMirror');
  const tab = (name) => page.click(`.toastui-editor-mode-switch .tab-item:has-text("${name}")`);
  await home(page);
  await page.click('li.frow:has(a[data-path="kb/docs/env.md"]) .fedit');
  await md(page).click();
  await tab('WYSIWYG');
  await page.keyboard.press('Control+z'); // váltás után: nem üríti ki a dokumentumot
  await expect(ww).toContainText('Harmadik szakasz');
  await ww.locator('td, p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' WWTESZT');
  await tab('Markdown');
  await expect(md(page)).toContainText('WWTESZT');
  await md(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X');
  await page.keyboard.press('Control+z'); // a saját gépelés visszavonható…
  await expect(md(page)).not.toContainText('WWTESZTX');
  await page.keyboard.press('Control+z'); // …de a WYSIWYG módosítás nem vész el
  await expect(md(page)).toContainText('WWTESZT');
  await tab('WYSIWYG');
  await expect(ww).toContainText('WWTESZT');
});

test('emoji választó: keresés, beszúrás', async ({ page }) => {
  await home(page);
  await page.click('li.frow:has(a[data-path="kb/docs/env.md"]) .fedit');
  await md(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.click('.emoji-btn');
  await expect(page.locator('.emoji-search')).toBeFocused();
  await page.keyboard.type('rocket');
  await expect(page.locator('.emoji-popup button.emoji').first()).toHaveAttribute('data-e', '🚀');
  await page.keyboard.press('Enter');
  await expect(md(page)).toContainText('# Env🚀');
});

test('sötét téma: váltás, megjegyzés, a szerkesztő is sötét', async ({ page }) => {
  await home(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#theme-toggle'); // auto → világos
  expect(await theme()).toBe('light');
  await page.click('#theme-toggle'); // → sötét
  expect(await theme()).toBe('dark');
  await page.reload();
  expect(await theme()).toBe('dark');
  await expect(page.locator('#md-css-dark')).toHaveJSProperty('disabled', false);

  await page.click('li.frow:has(a[data-path="kb/docs/env.md"]) .fedit');
  await expect(page.locator('.toastui-editor-defaultUI.toastui-editor-dark')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('theme'));
});

test('API: bemenet-ellenőrzés és biztonság', async ({ request }) => {
  const up = (q, type, data) => request.post(`/api/upload?${q}`, { headers: { 'content-type': type }, data });
  expect((await up('doc=kb/docs/a.md&name=x.txt', 'text/plain', 'hello')).status()).toBe(415);
  expect((await up('doc=../../etc/x.md&name=a.png', 'image/png', Buffer.from('x'))).status()).toBe(400);
  const trick = await (await up('doc=kb/docs/a.md&name=../../.git/evil.png', 'image/png', Buffer.from('x'))).json();
  expect(trick.path).toMatch(/^kb\/docs\/assets\/evil-[0-9a-f]{8}\.png$/);
  expect((await request.get('/api/file?path=kb/docs/env.md&rev=--output=x')).status()).toBe(400);
  expect((await request.get('/assets/.git/config')).status()).toBe(404);
  expect((await request.get('/assets/kb/.git/config')).status()).toBe(404);
  expect((await request.get('/assets/nincs-ilyen/x.png')).status()).toBe(404);
  expect((await up('doc=nincs-ilyen/a.md&name=a.png', 'image/png', Buffer.from('x'))).status()).toBe(400);
  const svg = await up('doc=kb/docs/a.md&name=x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  const res = await request.get(`/assets/${(await svg.json()).path}`);
  expect(res.headers()['content-security-policy']).toContain('sandbox');
});

// ---------- Több repó ----------

test('repók: legfelső szint a repó, abszolút / kivezető linkek repón belül', async ({ page, request }) => {
  const errors = collectErrors(page);
  await home(page);
  await expect(page.locator('details[data-repo][data-dir="kb"] > summary')).toContainText('kb');
  await expect(page.locator('details[data-repo][data-dir="masik"] > summary')).toContainText('masik.git');
  await expect(page.locator('a.file[data-path="masik/index.md"]')).toBeVisible();
  // a "kb" repó könyvtára (docs) nem jelenik meg a fában: kb/guide/…
  await expect(page.locator('details[data-dir="kb/guide"]')).toBeAttached();

  const r = await (await request.get('/api/file?path=masik/index.md')).json();
  expect(r.html).toContain('data-md-path="masik/jegyzet/egyeb.md"'); // "/" = a repó gyökere
  expect(r.html).not.toContain('data-md-path="kb/docs/env.md"'); // a repóból kivezető link nem oldódik fel
  await openFile(page, 'masik/index.md');
  await layer(page).locator('a[data-md-path="masik/jegyzet/egyeb.md"]').click();
  await expect(layer(page).locator('.title')).toHaveText('Egyéb jegyzet');
  expect(errors).toEqual([]);
});

test('repó szűrő: több repó kiválasztása, fa és keresés csak ezekben, szűrők törlése', async ({ page }) => {
  await home(page);
  await page.fill('#search-content', 'Zsiráf');
  await expect(page.locator('.result[data-path="masik/jegyzet/egyeb.md"]')).toBeVisible();
  await page.fill('#search-content', '');

  await page.click('#repo-filter');
  await page.locator('#repo-menu input[value="kb"]').check();
  await expect(page.locator('#repo-filter-label')).toHaveText('kb');
  await page.click('body', { position: { x: 5, y: 300 } }); // menü bezárása
  await expect(page.locator('#repo-menu')).toBeHidden();
  await expect(page.locator('a.file[data-path="masik/index.md"]')).toHaveCount(0);
  await expect(page.locator('a.file[data-path="kb/docs/env.md"]')).toBeVisible();

  await page.fill('#search-content', 'Zsiráf'); // csak a "kb" repóban keres
  await expect(page.locator('#results .rcount')).toContainText('No results');
  await expect(page.locator('#results .rcount')).toContainText('repo: kb');
  await page.fill('#search-content', '');

  await page.reload(); // a szűrő megmarad
  await expect(page.locator('#repo-filter-label')).toHaveText('kb');
  await expect(page.locator('a.file[data-path="masik/index.md"]')).toHaveCount(0);

  await page.click('#clear-filters');
  await expect(page.locator('#repo-filter-label')).toHaveText('all');
  await expect(page.locator('a.file[data-path="masik/index.md"]')).toBeVisible();
  await expect(page.locator('#clear-filters')).toBeHidden();

  // mindkét repó kiválasztása = „mind”
  await page.click('#repo-filter');
  await page.locator('#repo-menu input[value="kb"]').check();
  await page.locator('#repo-menu input[value="masik"]').check();
  await expect(page.locator('#repo-filter-label')).toHaveText('all');
  await expect(page.locator('#repo-menu input[value="kb"]')).toBeChecked(); // a pipák megmaradnak
  await expect(page.locator('#clear-filters')).toBeHidden();
  await page.click('#repo-menu-all');
  await expect(page.locator('#repo-menu input:checked')).toHaveCount(0);
});

test('új fájl a gyökér könyvtáras repóban', async ({ page, request }) => {
  await home(page);
  await page.click('#new-file');
  await layer(page).locator('.new-path-repo').selectOption('masik');
  await expect(layer(page).locator('.new-path-prefix')).toHaveText('/');
  await layer(page).locator('.new-path-input').fill('e2e-masik');
  await expect(layer(page).locator('.path')).toHaveText('masik/e2e-masik');
  await layer(page).locator('.save').click();
  await expect(page.locator('.toast.success', { hasText: 'md-edit/e2e-masik.md' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file[data-path="masik/e2e-masik.md"] .badge.new')).toBeVisible();
  await expect(page.locator('a.file[data-path="kb/docs/e2e-masik.md"]')).toHaveCount(0);
  await discard(request, 'masik/e2e-masik.md');
});

test('repókezelés: felvétel a felületről, letöltés, eltávolítás', async ({ page }) => {
  await home(page);
  await page.click('#manage-repos');
  const dlg = page.locator('#repo-dialog');
  await expect(dlg.locator('tr[data-id="kb"]')).toBeVisible();
  await dlg.locator('input[name="path"]').fill('harmadik.git');
  await expect(dlg.locator('input[name="id"]')).toHaveAttribute('placeholder', 'harmadik');
  await dlg.locator('.repo-submit').click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#sync-dialog .sync-state')).toHaveText('done', { timeout: 30000 });
  await page.locator('#sync-dialog .sync-close').click();
  await expect(page.locator('a.file[data-path="harmadik/index.md"]')).toBeVisible();

  await page.click('#manage-repos');
  await expect(dlg.locator('tr[data-id="harmadik"]')).toContainText('2 files');
  page.once('dialog', (d) => d.accept());
  await dlg.locator('tr[data-id="harmadik"] .repo-remove').click();
  await expect(dlg.locator('tr[data-id="harmadik"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file[data-path="harmadik/index.md"]')).toHaveCount(0);
});

test('ugyanaz a repó több könyvtárral: külön könyvtár felvehető, átfedő nem', async ({ page, request }) => {
  const idle = async () => expect.poll(async () => (await (await request.get('/api/status')).json()).syncing, { timeout: 30000 }).toBe(false);
  const add = (data) => request.post('/api/repos', { data });
  await idle();
  expect((await add({ path: 'harmadik.git', id: 'h-jegyzet', docsPath: 'jegyzet' })).status()).toBe(201);
  await idle();
  for (const docsPath of ['jegyzet', 'jegyzet/al', '']) { // azonos, alkönyvtár, gyökér (minden könyvtárat átfed)
    const r = await add({ path: 'harmadik.git', id: 'h-x', docsPath });
    expect(r.status(), docsPath).toBe(400);
    expect((await r.json()).error).toContain('already been added as “h-jegyzet”');
  }
  expect((await add({ path: 'harmadik.git', id: 'h-mas', docsPath: 'mas' })).status()).toBe(201); // külön könyvtár
  await idle();
  // szerkesztéskor sem lehet átfedő könyvtárra állítani
  const put = await request.put('/api/repos/h-mas', { data: { branch: 'main', docsPath: 'jegyzet/al' } });
  expect(put.status()).toBe(400);

  await home(page);
  await expect(page.locator('a.file[data-path="h-jegyzet/jegyzet/egyeb.md"]')).toBeVisible();
  await expect(page.locator('details[data-repo][data-dir="h-mas"]')).toHaveCount(0); // üres könyvtár: nincs fájl
  for (const id of ['h-jegyzet', 'h-mas']) expect((await request.delete(`/api/repos/${id}`)).ok()).toBe(true);
});

test('API: repó bemenet-ellenőrzés', async ({ request }) => {
  const add = (data) => request.post('/api/repos', { data });
  for (const path of ['../x.git', 'http://evil.example/x.git', '-uupload/x', 'a/.git', 'a b']) {
    expect((await add({ path })).status(), path).toBe(400);
  }
  expect((await add({ path: 'masik.git', id: 'masik2' })).status()).toBe(400); // már fel van véve
  expect((await add({ path: 'uj.git', id: 'kb' })).status()).toBe(400); // foglalt azonosító
  expect((await add({ path: 'uj.git', id: 'Rossz Id' })).status()).toBe(400);
  expect((await add({ path: 'uj.git', branch: '--upload-pack=x' })).status()).toBe(400);
  expect((await add({ path: 'uj.git', docsPath: '../kivul' })).status()).toBe(400);
  expect((await request.put('/api/repos/nincs', { data: {} })).status()).toBe(404);
  const repos = await (await request.get('/api/repos')).json();
  expect(repos.map((r) => r.id).sort()).toEqual(['kb', 'masik']);
});

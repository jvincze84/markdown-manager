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
  const row = page.locator('li.frow:has(a[data-path="docs/env.md"])');
  await expect(row.locator('.fhash')).toHaveText(/^[0-9a-f]{7}$/);
  await expect(row.locator('.fdate')).not.toBeEmpty();
  await expect(page.locator('a.file[data-path="docs/config.md"] .badge')).toBeVisible(); // módosított
  await expect(page.locator('a.file[data-path="docs/guide/telepites-linux.md"] .badge.new')).toBeVisible(); // új
  await expect(page.locator('#filter-count')).toHaveText('2');

  await page.click('#collapse-all');
  await expect(page.locator('a.file[data-path="docs/guide/install.md"]')).toBeHidden();
  await page.reload();
  await expect(page.locator('a.file[data-path="docs/guide/install.md"]')).toBeHidden(); // megjegyzi
  await page.click('#expand-all');
  await expect(page.locator('a.file[data-path="docs/guide/install.md"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keresés: fájlnév + tartalom, kiemelés a dokumentumban, szűrők törlése', async ({ page }) => {
  await home(page);
  await page.fill('#search-content', 'GIT_URL');
  await expect(page.locator('.result[data-path="docs/env.md"]')).toBeVisible();
  await page.fill('#search-name', 'env');
  await expect(page.locator('.result')).toHaveCount(1);
  await page.click('.result[data-path="docs/env.md"]');
  await expect(layer(page).locator('mark.search-hit').first()).toBeVisible();
  await expect(layer(page).locator('.hit-count')).toHaveText(/^1 \/ \d+$/);
  await page.keyboard.press('Escape');

  await expect(page.locator('#clear-filters')).toBeVisible();
  await page.click('#clear-filters');
  await expect(page.locator('#search-name')).toHaveValue('');
  await expect(page.locator('#search-content')).toHaveValue('');
  await expect(page.locator('#tree')).toBeVisible();
});

test('nézet: kódszínezés, másolás, rendezhető táblázat, mermaid, hosszú sor görgetése', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = collectErrors(page);
  await home(page);
  await openFile(page, 'docs/kodok.md');
  const bash = layer(page).locator('pre.code-hl.language-bash');
  await expect(bash.locator('.token.command', { hasText: 'kubectl' })).toBeVisible(); // bővített bash színezés
  await expect(bash.locator('.token.parameter', { hasText: '--dry-run' })).toBeVisible();
  await expect(layer(page).locator('pre.language-yaml .token.key').first()).toBeVisible();

  await layer(page).locator('.code-wrap').first().hover();
  await layer(page).locator('.code-copy').first().click();
  await expect(layer(page).locator('.code-copy').first()).toHaveText('✓ Másolva');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('kubectl get pods');

  const th = layer(page).locator('table th').first();
  await th.click(); // ▲ növekvő
  await expect(th).toHaveAttribute('aria-sort', 'ascending');
  await expect(layer(page).locator('table tbody tr').first()).toContainText('db');
  await th.click(); // ▼
  await expect(layer(page).locator('table tbody tr').first()).toContainText('web');

  await expect(layer(page).locator('pre.mermaid svg')).toBeVisible();
  await page.keyboard.press('Escape');

  await openFile(page, 'docs/hosszu.md');
  const pre = layer(page).locator('pre.code-hl.language-bash');
  expect(await pre.evaluate((x) => getComputedStyle(x).overflowX)).toBe('auto');
  expect(await pre.evaluate((x) => x.scrollWidth > x.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('előzmények: régi változat, diff az aktuálishoz, vissza', async ({ page }) => {
  await home(page);
  await openFile(page, 'docs/env.md');
  const sel = layer(page).locator('select.history');
  await expect(sel.locator('option')).toHaveCount(4); // fejléc + 3 commit
  const oldest = await sel.locator('option').last().getAttribute('value');
  await sel.selectOption(oldest);
  await expect(layer(page).locator('.rev-banner')).toBeVisible();
  await expect(layer(page).locator('.markdown-body')).not.toContainText('Harmadik');

  await layer(page).locator('.rev-diff').click();
  await expect(layer(page).locator('.diff-info')).toContainText('aktuális (main)');
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
  await openFile(page, 'docs/config.md');
  await expect(layer(page).locator('.markdown-body')).toContainText('Konfig v2');
  await layer(page).locator('.source-toggle [data-src="base"]').click();
  await expect(layer(page).locator('.markdown-body')).toContainText('Konfiguráció');
  await layer(page).locator('.source-toggle [data-src="diff"]').click();
  await expect(layer(page).locator('.diff-info')).toContainText('md-edit/docs__config.md');
});

test('szerkesztés: Ctrl+Z nem üríti ki, táblázatrendező, mentés branch-re, eldobás', async ({ page, request }) => {
  const errors = collectErrors(page);
  await home(page);
  await openFile(page, 'docs/tablak.md');
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
  const r = await (await request.get('/api/file?path=docs/tablak.md&source=branch')).json();
  expect(r.content).toContain('| zeta-01 |    16 GB |');

  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.discard').click();
  await expect(layer(page).locator('.source-toggle')).toBeHidden();
  expect(errors).toEqual([]);
});

test('képfeltöltés: assets könyvtárba, relatív link, ugyanabba a commitba', async ({ page, request }) => {
  await home(page);
  await page.click('li.frow:has(a[data-path="docs/guide/install.md"]) .fedit');
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
  const diff = await (await request.get('/api/diff?path=docs/guide/install.md')).json();
  expect(diff.diff).toContain('piros-');
  expect((await request.get(src)).ok()).toBe(true); // mentés után a branch-ről is kiszolgálható
  await discard(request, 'docs/guide/install.md');
});

test('új fájl: létrehozás, mentés, megjelenik a fában', async ({ page, request }) => {
  await home(page);
  await page.click('#new-file');
  await layer(page).locator('.new-path-input').fill('guide/e2e-uj');
  await md(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('E2E teszt tartalom.');
  await layer(page).locator('.save').click();
  await expect(page.locator('.toast.success', { hasText: 'md-edit/docs__guide__e2e-uj.md' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file[data-path="docs/guide/e2e-uj.md"] .badge.new')).toBeVisible();
  await discard(request, 'docs/guide/e2e-uj.md');
});

test('törlés: törlő commit a branch-re, jelölés, eldobással visszavonható', async ({ page }) => {
  await home(page);
  await openFile(page, 'docs/yaml.md');
  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.delete').click();
  await expect(layer(page).locator('.del-banner')).toBeVisible();
  await expect(layer(page).locator('.edit')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('a.file.deleted[data-path="docs/yaml.md"]')).toBeVisible();

  await openFile(page, 'docs/yaml.md');
  page.once('dialog', (d) => d.accept());
  await layer(page).locator('.discard').click();
  await expect(layer(page).locator('.del-banner')).toBeHidden();
  await expect(layer(page).locator('.edit')).toBeVisible();
});

test('emoji választó: magyar keresés, beszúrás', async ({ page }) => {
  await home(page);
  await page.click('li.frow:has(a[data-path="docs/env.md"]) .fedit');
  await md(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.click('.emoji-btn');
  await expect(page.locator('.emoji-search')).toBeFocused();
  await page.keyboard.type('rakéta');
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

  await page.click('li.frow:has(a[data-path="docs/env.md"]) .fedit');
  await expect(page.locator('.toastui-editor-defaultUI.toastui-editor-dark')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('theme'));
});

test('API: bemenet-ellenőrzés és biztonság', async ({ request }) => {
  const up = (q, type, data) => request.post(`/api/upload?${q}`, { headers: { 'content-type': type }, data });
  expect((await up('doc=docs/a.md&name=x.txt', 'text/plain', 'hello')).status()).toBe(415);
  expect((await up('doc=../../etc/x.md&name=a.png', 'image/png', Buffer.from('x'))).status()).toBe(400);
  const trick = await (await up('doc=docs/a.md&name=../../.git/evil.png', 'image/png', Buffer.from('x'))).json();
  expect(trick.path).toMatch(/^docs\/assets\/evil-[0-9a-f]{8}\.png$/);
  expect((await request.get('/api/file?path=docs/env.md&rev=--output=x')).status()).toBe(400);
  expect((await request.get('/assets/.git/config')).status()).toBe(404);
  const svg = await up('doc=docs/a.md&name=x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  const res = await request.get(`/assets/${(await svg.json()).path}`);
  expect(res.headers()['content-security-policy']).toContain('sandbox');
});

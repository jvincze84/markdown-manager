// Repó beállítások: ellenőrzés, régi (egy-repós) GIT_URL átvétele.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A config a betöltéskor olvassa az env-et → a require előtt állítjuk be (régi, egy-repós beállítás)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-repos-'));
Object.assign(process.env, {
  DATA_DIR: DATA,
  GIT_URL: 'https://git.example.hu/csoport/Dokumentacio.git',
  GIT_BRANCH: 'master',
  GIT_DOCS_PATH: '/docs/',
});
const cfg = require('../../lib/config');
const repos = require('../../lib/repos');

test('GIT_URL: szerver alap URL vs. régi, konkrét repó URL', () => {
  assert.deepStrictEqual(cfg.parseGitUrl('https://git.example.hu/'), { serverUrl: 'https://git.example.hu', legacyRepoPath: null });
  assert.deepStrictEqual(cfg.parseGitUrl('https://git.example.hu/gitlab'), { serverUrl: 'https://git.example.hu/gitlab', legacyRepoPath: null });
  assert.deepStrictEqual(cfg.parseGitUrl('https://git.example.hu/a/b.git'), { serverUrl: 'https://git.example.hu', legacyRepoPath: 'a/b.git' });
  assert.deepStrictEqual(cfg.parseGitUrl('file:///remote.git'), { serverUrl: 'file://', legacyRepoPath: 'remote.git' });
  assert.strictEqual(cfg.serverUrl, 'https://git.example.hu');
});

test('repó útvonal, branch, könyvtár ellenőrzése', () => {
  assert.strictEqual(repos.checkRepoPath('/csoport/al.csoport/repo.git/'), 'csoport/al.csoport/repo.git');
  for (const bad of ['', '../x', 'a/../b', '-u/x', 'a//b', 'http://evil/x', 'a/.git', 'a b', 'a;b']) {
    assert.throws(() => repos.checkRepoPath(bad), undefined, bad);
  }
  assert.strictEqual(repos.checkBranch('feature/uj'), 'feature/uj');
  for (const bad of ['-x', 'a..b', 'x.lock', '/x', 'x/', 'a b', '.x']) assert.throws(() => repos.checkBranch(bad), undefined, bad);
  assert.strictEqual(repos.checkDir('/docs/guide/'), 'docs/guide');
  assert.strictEqual(repos.checkDir(''), '');
  for (const bad of ['../x', 'a/.git', 'a//b']) assert.throws(() => repos.checkDir(bad, 'könyvtár'), undefined, bad);
});

test('normalize: azonosító javaslat, alapértékek, egyediség', () => {
  assert.strictEqual(repos.idFromPath('a/Kézi Könyv.git'), 'kezi-konyv');
  assert.throws(() => repos.checkRepoPath('a/Kézikönyv.git')); // ékezet nem lehet a repó útvonalban
  const r = repos.normalize({ path: 'csoport/Kezikonyv.git', docsPath: 'docs' });
  assert.deepStrictEqual(r, { id: 'kezikonyv', path: 'csoport/Kezikonyv.git', branch: 'master', docsPath: 'docs', assetsPath: 'docs/assets' });
  assert.strictEqual(repos.normalize({ path: 'x.git' }).assetsPath, 'assets');
  assert.throws(() => repos.normalize({ path: 'masik/kezikonyv.git' }, [r]), /azonosítójú/);
  assert.throws(() => repos.normalize({ path: 'csoport/kezikonyv', id: 'k2' }, [r]), /már fel van véve/);
  assert.throws(() => repos.normalize({ path: 'x.git', id: 'Nagy Betű' }), /azonosító/);
  // szerkesztésnél az azonosító és az útvonal nem változik
  const e = repos.normalize({ path: 'mas.git', id: 'mas', branch: 'dev' }, [r], { editing: r });
  assert.deepStrictEqual([e.id, e.path, e.branch, e.docsPath], ['kezikonyv', 'csoport/Kezikonyv.git', 'dev', '']);
});

test('régi beállítás átvétele: első repó + klón és feltöltések átköltöztetése', async () => {
  fs.mkdirSync(path.join(DATA, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'uploads', 'docs', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'uploads', 'docs', 'assets', 'a.png'), 'x');
  const list = await repos.loadOrMigrate(() => {});
  assert.deepStrictEqual(list, [{ id: 'dokumentacio', path: 'csoport/Dokumentacio.git', branch: 'master', docsPath: 'docs', assetsPath: 'docs/assets' }]);
  assert.ok(fs.existsSync(path.join(DATA, 'repos', 'dokumentacio', '.git')));
  assert.ok(!fs.existsSync(path.join(DATA, 'repo')));
  assert.ok(fs.existsSync(path.join(DATA, 'uploads', 'dokumentacio', 'docs', 'assets', 'a.png')));
  assert.strictEqual(repos.repoUrl(list[0]), 'https://git.example.hu/csoport/Dokumentacio.git');
  // második indításkor már a repos.json számít
  assert.deepStrictEqual(await repos.loadOrMigrate(() => {}), list);
  fs.rmSync(DATA, { recursive: true, force: true });
});

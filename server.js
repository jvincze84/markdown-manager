const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const cfg = require('./lib/config');
const git = require('./lib/git');
const docs = require('./lib/docs');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// Opcionális Basic Auth (APP_USERNAME / APP_PASSWORD)
if (cfg.appUser && cfg.appPassword) {
  app.use((req, res, next) => {
    const [type, value] = (req.headers.authorization || '').split(' ');
    if (type === 'Basic' && value) {
      const [u, ...p] = Buffer.from(value, 'base64').toString().split(':');
      if (u === cfg.appUser && p.join(':') === cfg.appPassword) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Markdown Manager"').status(401).send('Authentication required');
  });
}

const pkgDir = (name) => path.join(__dirname, 'node_modules', name);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/toastui', express.static(path.join(pkgDir('@toast-ui/editor'), 'dist')));
app.use('/vendor/github-markdown-css', express.static(pkgDir('github-markdown-css')));
app.use('/vendor/diff2html', express.static(path.join(pkgDir('diff2html'), 'bundles')));
app.use('/vendor/mermaid', express.static(path.join(pkgDir('mermaid'), 'dist')));
app.use('/vendor/code-syntax-highlight', express.static(path.join(pkgDir('@toast-ui/editor-plugin-code-syntax-highlight'), 'dist')));
// Képek / egyéb fájlok a repóból (a .git könyvtár tiltva)
const uploadsDir = path.join(cfg.dataDir, 'uploads'); // feltöltött, még nem mentett képek (repo-relatív útvonalon)
app.use('/assets', (req, res, next) => {
  // SVG-ben lehet script → közvetlen megnyitáskor se fusson le
  if (/\.svg$/i.test(req.path)) res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  next();
});
app.use('/assets', express.static(cfg.repoDir, { dotfiles: 'deny', index: false }));
app.use('/assets', express.static(uploadsDir, { dotfiles: 'deny', index: false }));

// ---------- Állapot ----------

const state = { syncing: false, lastSync: null, head: null, error: null, editBranches: new Map(), branchCommits: new Map(), fileCommits: new Map(), deletedFiles: new Set() };

let chain = Promise.resolve();
const exclusive = (fn) => {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
};

const lastSyncFile = path.join(cfg.dataDir, 'last-sync.txt');

// ---------- Képek ----------

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** Repo-relatív útvonal ellenőrzése (nincs .., nincs rejtett elem). */
function safeRepoPath(p) {
  const n = path.posix.normalize(String(p || '').replace(/^\/+/, ''));
  if (!n || n === '.' || n.startsWith('..') || n.split('/').some((seg) => !seg || seg.startsWith('.'))) return null;
  return n;
}

// A munkakönyvtárban / feltöltések között nem található kép: a szerkesztési branch-ekről vagy
// az alap branch-ről (sparse-checkouton kívül eső fájl) olvassuk ki.
app.use('/assets', wrapNext(async (req, res, next) => {
  let rel;
  try { rel = safeRepoPath(decodeURIComponent(req.path)); } catch { rel = null; }
  if (!rel || !(await git.isRepo())) return next();
  for (const ref of [...[...state.editBranches.keys()].map((b) => `origin/${b}`), 'HEAD']) {
    try {
      const data = await git.showBlob(ref, rel);
      res.type(IMAGE_TYPES[extOf(rel)] || extOf(rel) || 'application/octet-stream').set('Cache-Control', 'no-cache').send(data);
      return;
    } catch { /* nincs ezen a ref-en */ }
  }
  next();
}));

/** Feltöltött kép neve: ékezet nélküli, biztonságos alapnév + tartalom hash (ugyanaz a kép = ugyanaz a fájl). */
function assetName(original, data, mime) {
  const ext = extOf(original) in IMAGE_TYPES ? extOf(original)
    : Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === mime) || null;
  if (!ext) return null;
  const base = path.posix.basename(original || '', path.extname(original || ''))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'kep';
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 8);
  return `${base}-${hash}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** A markdownban hivatkozott, feltöltött (még nem mentett) képek: [{ path, data }]. */
async function pendingAssets(docPath, content) {
  const refs = new Set();
  for (const m of content.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) refs.add(m[1]);
  for (const m of content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  const out = [];
  for (const ref of refs) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) continue; // abszolút URL / data:
    let r = ref.split(/[?#]/)[0];
    try { r = decodeURIComponent(r); } catch { /* marad */ }
    const rel = safeRepoPath(r.startsWith('/') ? r : path.posix.join(path.posix.dirname(docPath), r));
    if (!rel || !(extOf(rel) in IMAGE_TYPES)) continue;
    const data = await fs.readFile(path.join(uploadsDir, rel)).catch(() => null);
    if (data) out.push({ path: rel, data });
  }
  return out;
}

/** 30 napnál régebbi, mentés nélkül maradt feltöltések törlése. */
async function cleanupUploads(dir = uploadsDir) {
  const limit = Date.now() - 30 * 86400 * 1000;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await cleanupUploads(p);
    else if ((await fs.stat(p)).mtimeMs < limit) await fs.rm(p, { force: true });
  }
}

/** Szerkesztési branchek frissítése + az ott létrehozott (alapban még nem létező) fájlok betöltése. */
async function refreshBranches() {
  state.editBranches = await git.listEditBranches();
  state.branchCommits = await git.editBranchCommits();
  const extras = []; // új fájlok (csak branch-en léteznek)
  const branchContents = new Map(); // módosított fájlok branch-tartalma (kereséshez)
  const deleted = new Set(); // a branch-en törölt (törlésre jelölt) alap fájlok
  for (const [branch, file] of state.editBranches) {
    if (!file || git.branchName(file) !== branch) continue;
    if (cfg.docsPath && !file.startsWith(cfg.docsPath + '/')) continue;
    try {
      const content = await git.showFile(`origin/${branch}`, file);
      if (docs.hasBase(file)) branchContents.set(file, content);
      else extras.push({ path: file, content });
    } catch {
      // a fájl nincs a branch-en → ha az alap branch-en megvan, akkor törlésre jelölt
      if (docs.hasBase(file)) deleted.add(file);
    }
  }
  state.deletedFiles = deleted;
  docs.setExtras(extras, branchContents);
}

async function refreshLocal() {
  await docs.rebuild();
  await refreshBranches();
  state.head = await git.headInfo();
  state.fileCommits = await git.fileCommits();
}

/** Új fájl útvonalának ellenőrzése (GIT_DOCS_PATH-hoz relatív bemenet → repo-relatív útvonal). */
function newFilePath(input) {
  let p = String(input || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) throw httpError(400, 'Add meg a fájl nevét.');
  if (!/\.(md|markdown)$/i.test(p)) p += '.md';
  const n = path.posix.normalize(p);
  if (n.startsWith('..') || n.split('/').some((seg) => !seg || seg.startsWith('.'))) {
    throw httpError(400, `Érvénytelen útvonal: ${input}`);
  }
  if (/[\x00-\x1f\\:*?"<>|]/.test(n)) throw httpError(400, `Nem megengedett karakter az útvonalban: ${input}`);
  return cfg.docsPath ? `${cfg.docsPath}/${n}` : n;
}

const editBranchOf = (p) => {
  const b = git.branchName(p);
  return state.editBranches.has(b) ? b : null;
};

const status = () => ({
  configured: Boolean(cfg.gitUrl),
  repo: cfg.gitUrl.replace(/(https?:\/\/)[^@/]+@/, '$1'),
  baseBranch: cfg.baseBranch,
  docsPath: cfg.docsPath,
  assetsPath: cfg.assetsPath,
  syncing: state.syncing,
  lastSync: state.lastSync,
  head: state.head,
  fileCount: docs.count(),
  error: state.error,
  commitUrl: git.commitUrlTemplate(),
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

const httpError = (status, message) => Object.assign(new Error(message), { status });

function wrapNext(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- API ----------

app.get('/api/status', (req, res) => res.json(status()));

// Sync háttérfolyamatként; a kliens a /api/sync/log végponton követi a haladást
const job = { id: 0, running: false, lines: [], progress: '', error: null, ok: false };

function jobLog(msg) {
  const t = new Date().toLocaleTimeString('hu-HU');
  if (job.progress) job.lines.push(`  ${job.progress}`); // utolsó progress sor megtartása a naplóban
  job.progress = '';
  job.lines.push(`[${t}] ${msg}`);
  console.log(`[sync] ${msg}`);
}

async function runSync() {
  const started = Date.now();
  state.syncing = true;
  Object.assign(job, { id: job.id + 1, running: true, lines: [], progress: '', error: null, ok: false });
  const log = { step: jobLog, progress: (t) => { job.progress = t; } };
  try {
    await exclusive(async () => {
      jobLog(`Szinkronizálás indul: ${status().repo} (${cfg.baseBranch})`);
      const head = await git.sync(log);
      jobLog(`HEAD: ${head.commit} – ${head.subject}`);
      jobLog('Markdown fájlok feldolgozása (renderelés, keresési index)…');
      await docs.rebuild();
      jobLog(`${docs.count()} markdown fájl feldolgozva.`);
      jobLog('Szerkesztési branchek beolvasása…');
      await refreshBranches();
      const newCount = docs.list().filter((f) => f.isNew).length;
      jobLog(`${state.editBranches.size} szerkesztési branch, ebből ${newCount} új fájl.`);
      state.head = await git.headInfo();
      await cleanupUploads();
      jobLog('Fájlonkénti commit adatok (utolsó módosítás)…');
      state.fileCommits = await git.fileCommits();
    });
    state.lastSync = new Date().toISOString();
    state.error = null;
    await fs.writeFile(lastSyncFile, state.lastSync).catch(() => {});
    jobLog(`Kész (${((Date.now() - started) / 1000).toFixed(1)} s).`);
    job.ok = true;
  } catch (e) {
    state.error = e.message;
    job.error = e.message;
    jobLog(`HIBA: ${e.message}`);
  } finally {
    state.syncing = false;
    job.running = false;
  }
}

app.post('/api/sync', (req, res) => {
  if (state.syncing) return res.status(409).json({ error: 'A szinkronizálás már folyamatban van.', id: job.id });
  runSync();
  res.status(202).json({ id: job.id });
});

app.get('/api/sync/log', (req, res) => {
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  res.json({
    id: job.id,
    running: job.running,
    ok: job.ok,
    error: job.error,
    total: job.lines.length,
    lines: job.lines.slice(since),
    progress: job.progress,
  });
});

app.get('/api/files', (req, res) => {
  res.json(docs.list().map((f) => {
    const editBranch = editBranchOf(f.path);
    return {
      ...f,
      editBranch,
      isDeleted: state.deletedFiles.has(f.path),
      prUrl: editBranch ? git.pullRequestUrl(editBranch) : null,
      commit: state.fileCommits.get(f.path) || null, // utolsó commit az alap branch-en
      branchCommit: editBranch ? state.branchCommits.get(editBranch) || null : null, // utolsó mentés a szerkesztési branch-en
    };
  }));
});

app.get('/api/search', (req, res) => {
  res.json(docs.query({ name: String(req.query.name || ''), content: String(req.query.q || '') }).map((r) => {
    const editBranch = editBranchOf(r.path);
    return { ...r, editBranch, isDeleted: state.deletedFiles.has(r.path), prUrl: editBranch ? git.pullRequestUrl(editBranch) : null };
  }));
});

app.get('/api/file', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const doc = docs.get(p);
  if (!doc) throw httpError(404, `Nem található: ${p}`);
  const editBranch = editBranchOf(p);
  let { content, html } = doc;
  let source = doc.isNew ? 'branch' : 'base';
  let rev = null;
  if (req.query.rev) {
    // Korábbi változat (előzmények lenyíló)
    rev = String(req.query.rev);
    if (!/^[0-9a-f]{7,40}$/i.test(rev)) throw httpError(400, 'Érvénytelen commit azonosító.');
    try {
      content = await exclusive(() => git.showFile(rev, p));
    } catch {
      throw httpError(404, `A fájl nem létezik ebben a változatban: ${rev.slice(0, 7)}`);
    }
    html = docs.render(content, p);
    source = 'rev';
  } else if (req.query.source === 'branch' && editBranch && !doc.isNew && !state.deletedFiles.has(p)) {
    content = await exclusive(() => git.showFile(`origin/${editBranch}`, p));
    html = docs.render(content, p);
    source = 'branch';
  }
  res.json({
    path: p,
    docPath: doc.docPath,
    title: doc.title,
    content,
    html,
    source,
    rev,
    baseBranch: cfg.baseBranch,
    isNew: Boolean(doc.isNew),
    isDeleted: state.deletedFiles.has(p),
    editBranch,
    prUrl: editBranch ? git.pullRequestUrl(editBranch) : null,
  });
}));

// Fájl törlése: törlő commit a fájl saját branch-ére (PR után törlődik a main-ből).
// Új (csak branch-en létező) fájlnál a branch eldobása.
app.delete('/api/file', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const doc = docs.get(p);
  if (!doc) throw httpError(404, `Nem található: ${p}`);
  const message = String(req.query.message || '');
  const result = await exclusive(async () => {
    const r = doc.isNew ? { ...(await git.deleteBranch(p)), removed: true } : await git.deleteFile(p, message);
    await refreshBranches();
    return r;
  });
  res.json({ ...result, path: p, prUrl: result.removed ? null : git.pullRequestUrl(result.branch) });
}));

// Kép feltöltése (az editor „kép beszúrása” / beillesztés / behúzás): a szerveren várakozik,
// és a markdown fájl következő mentésekor ugyanabba a commitba kerül.
app.post('/api/upload', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  const doc = safeRepoPath(req.query.doc);
  if (!doc) throw httpError(400, 'Hiányzó vagy érvénytelen dokumentum útvonal.');
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) throw httpError(400, 'Üres fájl.');
  const name = assetName(String(req.query.name || ''), data, String(req.headers['content-type'] || '').split(';')[0]);
  if (!name) throw httpError(415, `Nem támogatott képformátum (${Object.keys(IMAGE_TYPES).join(', ')}).`);
  const rel = `${cfg.assetsPath}/${name}`;
  const target = path.join(uploadsDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  const url = path.posix.relative(path.posix.dirname(doc), rel).split('/').map(encodeURIComponent).join('/');
  res.status(201).json({ path: rel, url });
}));

app.put('/api/file', wrap(async (req, res) => {
  const { path: p, content, message } = req.body || {};
  if (!docs.get(p)) throw httpError(404, `Nem található: ${p}`);
  if (typeof content !== 'string') throw httpError(400, 'Hiányzó tartalom.');
  const result = await exclusive(async () => {
    const r = await git.saveFile(p, content, message, await pendingAssets(p, content));
    await refreshBranches();
    return r;
  });
  res.json({ ...result, prUrl: git.pullRequestUrl(result.branch) });
}));

app.get('/api/history', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  if (!docs.get(p)) throw httpError(404, `Nem található: ${p}`);
  const commits = await exclusive(() => git.fileHistory(p, editBranchOf(p)));
  res.json({ commits, editBranch: editBranchOf(p), baseBranch: cfg.baseBranch });
}));

app.get('/api/diff', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  if (!docs.get(p)) throw httpError(404, `Nem található: ${p}`);
  const editBranch = editBranchOf(p);
  if (req.query.rev) {
    // Korábbi változat ↔ aktuális változat (szerkesztési branch, ha van; különben az alap branch)
    const rev = String(req.query.rev);
    if (!/^[0-9a-f]{7,40}$/i.test(rev)) throw httpError(400, 'Érvénytelen commit azonosító.');
    const target = editBranch || cfg.baseBranch;
    const r = await exclusive(() => git.revDiff(p, rev, `origin/${target}`));
    return res.json({ ...r, path: p, rev, target, onBranch: Boolean(editBranch), baseBranch: cfg.baseBranch });
  }
  if (!editBranch) throw httpError(404, 'Ehhez a fájlhoz nincs szerkesztési branch.');
  const r = await exclusive(() => git.diffFile(p));
  res.json({ ...r, path: p, baseBranch: cfg.baseBranch, prUrl: git.pullRequestUrl(r.branch) });
}));

// Szerkesztési branch eldobása (törlés a szerverről)
app.delete('/api/branch', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  if (!docs.get(p)) throw httpError(404, `Nem található: ${p}`);
  if (!editBranchOf(p)) throw httpError(404, 'Ehhez a fájlhoz nincs szerkesztési branch.');
  const wasNew = Boolean(docs.get(p).isNew);
  const r = await exclusive(async () => {
    const out = await git.deleteBranch(p);
    await refreshBranches();
    return out;
  });
  res.json({ ...r, path: p, removed: wasNew });
}));

// Új fájl létrehozása: saját branch-en jön létre (az alap branch-ből indítva), majd push
app.post('/api/file', wrap(async (req, res) => {
  const { path: input, content, message } = req.body || {};
  if (typeof content !== 'string') throw httpError(400, 'Hiányzó tartalom.');
  if (!(await git.isRepo())) throw httpError(400, 'Előbb futtasd a Sync-et.');
  const p = newFilePath(input);
  if (docs.get(p)) throw httpError(409, `Már létezik: ${p}`);
  const result = await exclusive(async () => {
    const r = await git.saveFile(p, content, (message && message.trim()) || `Add ${p}`, await pendingAssets(p, content));
    await refreshBranches();
    return r;
  });
  res.status(201).json({ ...result, path: p, prUrl: git.pullRequestUrl(result.branch) });
}));

// ---------- Indítás ----------

(async () => {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  try {
    const n = await git.setupCustomCA();
    if (n) console.log(`Egyedi CA bundle betöltve: ${n} tanúsítvány.`);
  } catch (e) {
    state.error = e.message;
    console.error('CA bundle hiba:', e.message);
  }
  if (await git.isRepo()) {
    try {
      await refreshLocal();
      state.lastSync = (await fs.readFile(lastSyncFile, 'utf8').catch(() => '')).trim() || null;
      console.log(`Helyi repo betöltve: ${docs.count()} markdown fájl.`);
    } catch (e) {
      console.error('Helyi repo betöltése sikertelen:', e.message);
    }
  }
  if (!cfg.gitUrl) console.warn('FIGYELEM: GIT_URL nincs beállítva.');
  app.listen(cfg.port, () => console.log(`Markdown Manager: http://0.0.0.0:${cfg.port}`));
})();

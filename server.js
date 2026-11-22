const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const cfg = require('./lib/config');
const git = require('./lib/git');
const docs = require('./lib/docs');
const reposLib = require('./lib/repos');

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

// PWA: a service worker a kliens fájlok (public/**, package-lock.json) hash-ével verziózott gyorsítótárat használ,
// így új build után a böngésző frissíti az app héját. A sw.js mindig revalidálva.
const swSource = (() => {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else hash.update(p).update(fsSync.readFileSync(p));
    }
  };
  walk(path.join(__dirname, 'public'));
  hash.update(fsSync.readFileSync(path.join(__dirname, 'package-lock.json')));
  return fsSync.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8').replace("'__VERSION__'", `'${hash.digest('hex').slice(0, 12)}'`);
})();
app.get('/sw.js', (req, res) => res.type('js').set('Cache-Control', 'no-cache').send(swSource));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('.webmanifest')) res.type('application/manifest+json'); },
}));
app.use('/vendor/toastui', express.static(path.join(pkgDir('@toast-ui/editor'), 'dist')));
app.use('/vendor/github-markdown-css', express.static(pkgDir('github-markdown-css')));
app.use('/vendor/diff2html', express.static(path.join(pkgDir('diff2html'), 'bundles')));
app.use('/vendor/mermaid', express.static(path.join(pkgDir('mermaid'), 'dist')));
app.use('/vendor/code-syntax-highlight', express.static(path.join(pkgDir('@toast-ui/editor-plugin-code-syntax-highlight'), 'dist')));
// Képek / egyéb fájlok a repókból: /assets/<repó>/<útvonal> (a .git könyvtár tiltva)
const { uploadsDir } = cfg; // feltöltött, még nem mentett képek: <uploadsDir>/<repó>/<útvonal>
app.use('/assets', (req, res, next) => {
  // SVG-ben lehet script → közvetlen megnyitáskor se fusson le
  if (/\.svg$/i.test(req.path)) res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // Csatolt (nem kép) fájlok: letöltésként, hogy pl. egy feltöltött HTML ne fusson le az app origin-jén
  const ext = (req.path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  res.set('X-Content-Type-Options', 'nosniff');
  if (!INLINE_EXTS.has(ext)) {
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.attachment(path.posix.basename(req.path));
  }
  // csak felvett repó alól szolgálunk ki fájlt
  let id = '';
  try { id = decodeURIComponent(req.path.split('/')[1] || ''); } catch { /* érvénytelen */ }
  if (!repos.has(id)) return res.status(404).end();
  next();
});
app.use('/assets', express.static(cfg.reposDir, { dotfiles: 'deny', index: false }));
app.use('/assets', express.static(uploadsDir, { dotfiles: 'deny', index: false }));

// ---------- Állapot ----------

// Felvett repók: Map<id, ctx>; ctx = { cfg (repos.json bejegyzés), git, state }
const repos = new Map();
const state = { syncing: false, error: null };

const newRepoState = () => ({ lastSync: null, head: null, error: null, editBranches: new Map(), branchCommits: new Map(), fileCommits: new Map(), deletedFiles: new Set() });

function makeCtx(r, prevState = null) {
  const dir = reposLib.repoDir(r.id);
  const repo = { ...r, dir, url: reposLib.repoUrl(r) };
  return { id: r.id, cfg: r, repo, git: git.forRepo(repo), state: prevState || newRepoState() };
}

const repoList = () => [...repos.values()].map((c) => c.cfg);
const saveRepos = () => reposLib.save(repoList());

/** Virtuális útvonal (<repó>/<útvonal>) → { ctx, rel } vagy null. */
function resolve(p) {
  const s = String(p || '');
  const i = s.indexOf('/');
  const ctx = i > 0 ? repos.get(s.slice(0, i)) : null;
  return ctx ? { ctx, rel: s.slice(i + 1) } : null;
}

let chain = Promise.resolve();
const exclusive = (fn) => {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
};

const lastSyncFile = path.join(cfg.dataDir, 'last-sync.json'); // { <repó>: ISO dátum }
const legacyLastSyncFile = path.join(cfg.dataDir, 'last-sync.txt');

async function saveLastSync() {
  const obj = Object.fromEntries([...repos.values()].filter((c) => c.state.lastSync).map((c) => [c.id, c.state.lastSync]));
  await fs.writeFile(lastSyncFile, JSON.stringify(obj)).catch(() => {});
}

// ---------- Képek ----------

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
// Az /assets alól a böngészőben megnyitható kiterjesztések; minden más letöltésként (Content-Disposition: attachment)
const INLINE_EXTS = new Set([...Object.keys(IMAGE_TYPES), 'md', 'markdown', 'txt', 'pdf']);
// Csatolmányként nem tölthető fel (markdown dokumentum: azt az „＋ New file”-lal kell létrehozni)
const BLOCKED_FILE_EXTS = new Set(['md', 'markdown']);
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** Repo-relatív / virtuális útvonal ellenőrzése (nincs .., nincs rejtett elem). */
function safeRepoPath(p) {
  const n = path.posix.normalize(String(p || '').replace(/^\/+/, ''));
  if (!n || n === '.' || n.startsWith('..') || n.split('/').some((seg) => !seg || seg.startsWith('.'))) return null;
  return n;
}

// A munkakönyvtárban / feltöltések között nem található kép: a szerkesztési branch-ekről vagy
// az alap branch-ről (sparse-checkouton kívül eső fájl) olvassuk ki.
app.use('/assets', wrapNext(async (req, res, next) => {
  let vp;
  try { vp = safeRepoPath(decodeURIComponent(req.path)); } catch { vp = null; }
  const r = vp && resolve(vp);
  if (!r || !(await r.ctx.git.isRepo())) return next();
  const { ctx, rel } = r;
  for (const ref of [...[...ctx.state.editBranches.keys()].map((b) => `origin/${b}`), 'HEAD']) {
    try {
      const data = await ctx.git.showBlob(ref, rel);
      res.type(IMAGE_TYPES[extOf(rel)] || extOf(rel) || 'application/octet-stream').set('Cache-Control', 'no-cache').send(data);
      return;
    } catch { /* nincs ezen a ref-en */ }
  }
  next();
}));

/**
 * Feltöltött fájl neve: ékezet nélküli, biztonságos alapnév + tartalom hash (ugyanaz a tartalom = ugyanaz a fájl).
 * Kép (alapértelmezés): csak a képformátumok (kiterjesztés vagy MIME típus alapján); null = nem támogatott.
 * Fájl (file=true): bármilyen kiterjesztés (kivéve markdown), kiterjesztés nélkül is.
 */
function assetName(original, data, mime, { file = false } = {}) {
  const orig = path.posix.basename(String(original || '').replace(/\\/g, '/'));
  let ext;
  if (file) {
    ext = /^[a-z0-9]{1,10}$/.test(extOf(orig)) ? extOf(orig) : '';
    if (BLOCKED_FILE_EXTS.has(ext)) return null;
  } else {
    ext = extOf(orig) in IMAGE_TYPES ? extOf(orig) : Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === mime) || null;
    if (!ext) return null;
  }
  const base = path.posix.basename(orig, ext ? path.extname(orig) : '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || (file ? 'file' : 'image');
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 8);
  return `${base}-${hash}${ext ? `.${ext === 'jpeg' ? 'jpg' : ext}` : ''}`;
}

/**
 * A markdownban hivatkozott, feltöltött (még nem mentett) képek és fájlok: [{ path (repó-relatív), data }].
 * Hivatkozás: kép / link (`![..](x)`, `[..](x)`, `[id]: x`) vagy HTML `src` / `href`.
 * docPath: a dokumentum virtuális útvonala; a "/" kezdetű hivatkozás a repó gyökeréhez képest értendő.
 */
async function pendingAssets(docPath, content) {
  const root = docPath.split('/')[0];
  const refs = new Set();
  for (const m of content.matchAll(/\]\(\s*<?([^)\s>]+)/g)) refs.add(m[1]);
  for (const m of content.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gm)) refs.add(m[1]);
  for (const m of content.matchAll(/<(?:img|a|source|video|audio)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  const out = [];
  for (const ref of refs) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) continue; // abszolút URL / data:
    let r = ref.split(/[?#]/)[0];
    try { r = decodeURIComponent(r); } catch { /* marad */ }
    const vp = safeRepoPath(r.startsWith('/') ? `${root}/${r}` : path.posix.join(path.posix.dirname(docPath), r));
    if (!vp || !vp.startsWith(`${root}/`) || BLOCKED_FILE_EXTS.has(extOf(vp))) continue;
    const data = await fs.readFile(path.join(uploadsDir, vp)).catch(() => null);
    if (data) out.push({ path: vp.slice(root.length + 1), data });
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

/** Egy repó szerkesztési branchei + az ott létrehozott (alapban még nem létező) fájlok betöltése. */
async function refreshBranches(ctx) {
  const { git: g, state: st, cfg: rc } = ctx;
  st.editBranches = await g.listEditBranches();
  st.branchCommits = await g.editBranchCommits();
  const extras = []; // új fájlok (csak branch-en léteznek)
  const branchContents = new Map(); // módosított fájlok branch-tartalma (kereséshez)
  const deleted = new Set(); // a branch-en törölt (törlésre jelölt) alap fájlok
  for (const [branch, file] of st.editBranches) {
    if (!file || g.branchName(file) !== branch) continue;
    if (rc.docsPath && !file.startsWith(rc.docsPath + '/')) continue;
    try {
      const content = await g.showFile(`origin/${branch}`, file);
      if (docs.hasBase(ctx.id, file)) branchContents.set(file, content);
      else extras.push({ path: file, content });
    } catch {
      // a fájl nincs a branch-en → ha az alap branch-en megvan, akkor törlésre jelölt
      if (docs.hasBase(ctx.id, file)) deleted.add(file);
    }
  }
  st.deletedFiles = deleted;
  docs.setExtras(ctx.id, extras, branchContents);
}

async function refreshLocal(ctx) {
  await docs.rebuild(ctx.repo);
  await refreshBranches(ctx);
  ctx.state.head = await ctx.git.headInfo();
  ctx.state.fileCommits = await ctx.git.fileCommits();
}

/** Új fájl útvonalának ellenőrzése (a repó könyvtárához relatív bemenet → repo-relatív útvonal). */
function newFilePath(ctx, input) {
  let p = String(input || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) throw httpError(400, 'Enter a file name.');
  if (!/\.(md|markdown)$/i.test(p)) p += '.md';
  const n = path.posix.normalize(p);
  if (n.startsWith('..') || n.split('/').some((seg) => !seg || seg.startsWith('.'))) {
    throw httpError(400, `Invalid path: ${input}`);
  }
  if (/[\x00-\x1f\\:*?"<>|]/.test(n)) throw httpError(400, `Invalid character in path: ${input}`);
  return ctx.cfg.docsPath ? `${ctx.cfg.docsPath}/${n}` : n;
}

const editBranchOf = (ctx, rel) => {
  const b = ctx.git.branchName(rel);
  return ctx.state.editBranches.has(b) ? b : null;
};

const serverLabel = () => git.redact(cfg.serverUrl);

const repoStatus = (ctx) => ({
  ...ctx.cfg,
  url: git.redact(ctx.repo.url),
  head: ctx.state.head,
  fileCount: docs.count(ctx.id),
  lastSync: ctx.state.lastSync,
  error: ctx.state.error,
  commitUrl: ctx.git.commitUrlTemplate(),
});

const status = () => {
  const list = [...repos.values()];
  const syncs = list.map((c) => c.state.lastSync).filter(Boolean).sort();
  return {
    configured: Boolean(cfg.serverUrl),
    server: serverLabel(),
    defaultBranch: cfg.defaultBranch,
    syncing: state.syncing,
    error: state.error,
    totalFiles: docs.count(),
    lastSync: syncs.length ? syncs[syncs.length - 1] : null,
    repos: list.map(repoStatus),
  };
};

/** Dokumentum + repó a kérés útvonala alapján; 404, ha nincs ilyen. */
function docOf(p) {
  const doc = docs.get(p);
  const r = resolve(p);
  if (!doc || !r) throw httpError(404, `Not found: ${p}`);
  return { doc, ...r };
}

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
  const t = new Date().toLocaleTimeString('en-GB');
  if (job.progress) job.lines.push(`  ${job.progress}`); // utolsó progress sor megtartása a naplóban
  job.progress = '';
  job.lines.push(`[${t}] ${msg}`);
  console.log(`[sync] ${msg}`);
}

/** Egy repó szinkronizálása (az exclusive zár alatt hívandó). */
async function syncRepo(ctx, log) {
  jobLog(`━━ ${ctx.id}: ${git.redact(ctx.repo.url)} (${ctx.cfg.branch})`);
  try {
    const head = await ctx.git.sync(log);
    jobLog(`HEAD: ${head.commit} – ${head.subject}`);
    jobLog('Processing markdown files (rendering, search index)…');
    await docs.rebuild(ctx.repo);
    jobLog(`${docs.count(ctx.id)} markdown files processed.`);
    jobLog('Reading edit branches…');
    await refreshBranches(ctx);
    const newCount = docs.list(ctx.id).filter((f) => f.isNew).length;
    jobLog(`${ctx.state.editBranches.size} edit branches, ${newCount} of them new files.`);
    ctx.state.head = await ctx.git.headInfo();
    jobLog('Per-file commit data (last change)…');
    ctx.state.fileCommits = await ctx.git.fileCommits();
    ctx.state.lastSync = new Date().toISOString();
    ctx.state.error = null;
    return true;
  } catch (e) {
    ctx.state.error = e.message;
    jobLog(`ERROR (${ctx.id}): ${e.message}`);
    return false;
  }
}

/** Sync háttérben: a megadott repók (alapértelmezés: mind) egymás után. Egy repó hibája nem állítja meg a többit. */
async function runSync(ids = null) {
  const started = Date.now();
  state.syncing = true;
  Object.assign(job, { id: job.id + 1, running: true, lines: [], progress: '', error: null, ok: false });
  const log = { step: jobLog, progress: (t) => { job.progress = t; } };
  try {
    const failed = [];
    await exclusive(async () => {
      const list = [...repos.values()].filter((c) => !ids || ids.includes(c.id));
      if (!list.length) throw new Error('No repositories. Add one with the “⚙ Repos” button.');
      jobLog(`Sync started: ${list.length} ${list.length === 1 ? 'repository' : 'repositories'} (${serverLabel()})`);
      for (const ctx of list) if (!(await syncRepo(ctx, log))) failed.push(ctx.id);
      await cleanupUploads();
      await saveLastSync();
    });
    if (failed.length) throw new Error(`Failed: ${failed.join(', ')}`);
    state.error = null;
    jobLog(`Done (${((Date.now() - started) / 1000).toFixed(1)} s).`);
    job.ok = true;
  } catch (e) {
    job.error = e.message;
    jobLog(`ERROR: ${e.message}`);
  } finally {
    state.syncing = false;
    job.running = false;
  }
}

/** Sync indítása; false, ha már fut. */
function startSync(ids) {
  if (state.syncing) return false;
  runSync(ids);
  return true;
}

app.post('/api/sync', (req, res) => {
  const ids = Array.isArray(req.body?.repos) ? req.body.repos.map(String).filter((id) => repos.has(id)) : null;
  if (!startSync(ids)) return res.status(409).json({ error: 'A sync is already running.', id: job.id });
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

// ---------- Repók kezelése ----------

app.get('/api/repos', (req, res) => res.json(status().repos));

// Új repó felvétele, majd azonnali sync (csak ez a repó)
app.post('/api/repos', wrap(async (req, res) => {
  if (!cfg.serverUrl) throw httpError(400, 'The GIT_URL environment variable is not set.');
  if (state.syncing) throw httpError(409, 'A sync is running – wait for it to finish.');
  const ctx = await exclusive(async () => {
    let r;
    try { r = reposLib.normalize(req.body || {}, repoList()); } catch (e) { throw httpError(400, e.message); }
    const c = makeCtx(r);
    await fs.rm(c.repo.dir, { recursive: true, force: true }); // esetleges korábbi (törölt repó) maradvány
    repos.set(r.id, c);
    await saveRepos();
    return c;
  });
  startSync([ctx.id]);
  res.status(201).json({ repo: repoStatus(ctx), syncJob: job.id });
}));

// Repó beállításainak módosítása (azonosító és útvonal nem változtatható), majd újra-sync
app.put('/api/repos/:id', wrap(async (req, res) => {
  const old = repos.get(req.params.id);
  if (!old) throw httpError(404, `No such repository: ${req.params.id}`);
  if (state.syncing) throw httpError(409, 'A sync is running – wait for it to finish.');
  const ctx = await exclusive(async () => {
    let r;
    try { r = reposLib.normalize(req.body || {}, repoList(), { editing: old.cfg }); } catch (e) { throw httpError(400, e.message); }
    const c = makeCtx(r, old.state);
    repos.set(r.id, c);
    await saveRepos();
    return c;
  });
  startSync([ctx.id]);
  res.json({ repo: repoStatus(ctx), syncJob: job.id });
}));

// Repó eltávolítása az appból (a helyi klón és a mentetlen feltöltések törlődnek; a szerveren semmi nem változik)
app.delete('/api/repos/:id', wrap(async (req, res) => {
  const ctx = repos.get(req.params.id);
  if (!ctx) throw httpError(404, `No such repository: ${req.params.id}`);
  await exclusive(async () => {
    repos.delete(ctx.id);
    await saveRepos();
    docs.removeRepo(ctx.id);
    await fs.rm(ctx.repo.dir, { recursive: true, force: true });
    await fs.rm(path.join(uploadsDir, ctx.id), { recursive: true, force: true });
    await saveLastSync();
  });
  res.json({ removed: ctx.id });
}));

// ---------- Fájlok ----------

/** A fájl szerkesztési állapota (branch, törölt, PR link). */
function fileState(ctx, rel) {
  const editBranch = editBranchOf(ctx, rel);
  return {
    editBranch,
    isDeleted: ctx.state.deletedFiles.has(rel),
    prUrl: editBranch ? ctx.git.pullRequestUrl(editBranch) : null,
  };
}

app.get('/api/files', (req, res) => {
  res.json(docs.list().map(({ rel, ...f }) => {
    const ctx = repos.get(f.repo);
    const st = fileState(ctx, rel);
    return {
      ...f,
      ...st,
      commit: ctx.state.fileCommits.get(rel) || null, // utolsó commit az alap branch-en
      branchCommit: st.editBranch ? ctx.state.branchCommits.get(st.editBranch) || null : null, // utolsó mentés a szerkesztési branch-en
    };
  }));
});

app.get('/api/search', (req, res) => {
  // repos=a,b → csak ezekben a repókban (üres = mindegyikben)
  const ids = String(req.query.repos || '').split(',').filter(Boolean);
  const results = docs.query({ name: String(req.query.name || ''), content: String(req.query.q || ''), repos: ids.length ? new Set(ids) : null });
  res.json(results.map((r) => {
    const { ctx, rel } = resolve(r.path);
    return { ...r, ...fileState(ctx, rel) };
  }));
});

app.get('/api/file', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const { doc, ctx, rel } = docOf(p);
  const st = fileState(ctx, rel);
  let { content, html } = doc;
  let source = doc.isNew ? 'branch' : 'base';
  let rev = null;
  if (req.query.rev) {
    // Korábbi változat (előzmények lenyíló)
    rev = String(req.query.rev);
    if (!/^[0-9a-f]{7,40}$/i.test(rev)) throw httpError(400, 'Invalid commit id.');
    try {
      content = await exclusive(() => ctx.git.showFile(rev, rel));
    } catch {
      throw httpError(404, `The file does not exist in this version: ${rev.slice(0, 7)}`);
    }
    html = docs.render(content, p);
    source = 'rev';
  } else if (req.query.source === 'branch' && st.editBranch && !doc.isNew && !st.isDeleted) {
    content = await exclusive(() => ctx.git.showFile(`origin/${st.editBranch}`, rel));
    html = docs.render(content, p);
    source = 'branch';
  }
  res.json({
    path: p,
    repo: ctx.id,
    rel,
    docPath: doc.docPath,
    title: doc.title,
    content,
    html,
    source,
    rev,
    baseBranch: ctx.cfg.branch,
    isNew: Boolean(doc.isNew),
    ...st,
  });
}));

// Fájl törlése: törlő commit a fájl saját branch-ére (PR után törlődik a main-ből).
// Új (csak branch-en létező) fájlnál a branch eldobása.
app.delete('/api/file', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const { doc, ctx, rel } = docOf(p);
  const message = String(req.query.message || '');
  const result = await exclusive(async () => {
    const r = doc.isNew ? { ...(await ctx.git.deleteBranch(rel)), removed: true } : await ctx.git.deleteFile(rel, message);
    await refreshBranches(ctx);
    return r;
  });
  res.json({ ...result, path: p, prUrl: result.removed ? null : ctx.git.pullRequestUrl(result.branch) });
}));

// Kép (az editor „kép beszúrása” / beillesztés / behúzás) vagy fájl (kind=file: „📎 Attach file”, nem kép
// behúzása) feltöltése: a szerveren várakozik, és a markdown fájl következő mentésekor ugyanabba a commitba kerül.
app.post('/api/upload', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  const doc = safeRepoPath(req.query.doc);
  const r = doc && resolve(doc);
  if (!r) throw httpError(400, 'Missing or invalid document path.');
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) throw httpError(400, 'Empty file.');
  const file = req.query.kind === 'file';
  const name = assetName(String(req.query.name || ''), data, String(req.headers['content-type'] || '').split(';')[0], { file });
  if (!name) {
    throw httpError(415, file ? 'Markdown files cannot be attached; create them with “＋ New file”.'
      : `Unsupported image format (${Object.keys(IMAGE_TYPES).join(', ')}).`);
  }
  const vp = `${r.ctx.id}/${r.ctx.cfg.assetsPath ? `${r.ctx.cfg.assetsPath}/` : ''}${name}`;
  const target = path.join(uploadsDir, vp);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  const url = path.posix.relative(path.posix.dirname(doc), vp).split('/').map(encodeURIComponent).join('/');
  res.status(201).json({ path: vp, url });
}));

app.put('/api/file', wrap(async (req, res) => {
  const { path: p, content, message } = req.body || {};
  const { ctx, rel } = docOf(p);
  if (typeof content !== 'string') throw httpError(400, 'Missing content.');
  const result = await exclusive(async () => {
    const r = await ctx.git.saveFile(rel, content, message, await pendingAssets(p, content));
    await refreshBranches(ctx);
    return r;
  });
  res.json({ ...result, prUrl: ctx.git.pullRequestUrl(result.branch) });
}));

app.get('/api/history', wrap(async (req, res) => {
  const { ctx, rel } = docOf(String(req.query.path || ''));
  const editBranch = editBranchOf(ctx, rel);
  const commits = await exclusive(() => ctx.git.fileHistory(rel, editBranch));
  res.json({ commits, editBranch, baseBranch: ctx.cfg.branch });
}));

app.get('/api/diff', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const { ctx, rel } = docOf(p);
  const editBranch = editBranchOf(ctx, rel);
  const baseBranch = ctx.cfg.branch;
  if (req.query.rev) {
    // Korábbi változat ↔ aktuális változat (szerkesztési branch, ha van; különben az alap branch)
    const rev = String(req.query.rev);
    if (!/^[0-9a-f]{7,40}$/i.test(rev)) throw httpError(400, 'Invalid commit id.');
    const target = editBranch || baseBranch;
    const r = await exclusive(() => ctx.git.revDiff(rel, rev, `origin/${target}`));
    return res.json({ ...r, path: p, rev, target, onBranch: Boolean(editBranch), baseBranch });
  }
  if (!editBranch) throw httpError(404, 'This file has no edit branch.');
  const r = await exclusive(() => ctx.git.diffFile(rel));
  res.json({ ...r, path: p, baseBranch, prUrl: ctx.git.pullRequestUrl(r.branch) });
}));

// Szerkesztési branch eldobása (törlés a szerverről)
app.delete('/api/branch', wrap(async (req, res) => {
  const p = String(req.query.path || '');
  const { doc, ctx, rel } = docOf(p);
  if (!editBranchOf(ctx, rel)) throw httpError(404, 'This file has no edit branch.');
  const wasNew = Boolean(doc.isNew);
  const r = await exclusive(async () => {
    const out = await ctx.git.deleteBranch(rel);
    await refreshBranches(ctx);
    return out;
  });
  res.json({ ...r, path: p, removed: wasNew });
}));

// Új fájl létrehozása: saját branch-en jön létre (az alap branch-ből indítva), majd push.
// Bemenet: repo (azonosító) + path (a repó könyvtárához relatív útvonal).
app.post('/api/file', wrap(async (req, res) => {
  const { repo: id, path: input, content, message } = req.body || {};
  if (typeof content !== 'string') throw httpError(400, 'Missing content.');
  const ctx = repos.get(String(id || ''));
  if (!ctx) throw httpError(400, 'Select a repository.');
  if (!(await ctx.git.isRepo())) throw httpError(400, 'Run Sync first.');
  const rel = newFilePath(ctx, input);
  const p = `${ctx.id}/${rel}`;
  if (docs.get(p)) throw httpError(409, `Already exists: ${p}`);
  const result = await exclusive(async () => {
    const r = await ctx.git.saveFile(rel, content, (message && message.trim()) || `Add ${rel}`, await pendingAssets(p, content));
    await refreshBranches(ctx);
    return r;
  });
  res.status(201).json({ ...result, path: p, prUrl: ctx.git.pullRequestUrl(result.branch) });
}));

// ---------- Indítás ----------

(async () => {
  await fs.mkdir(cfg.reposDir, { recursive: true });
  try {
    const n = await git.setupCustomCA();
    if (n) console.log(`Custom CA bundle loaded: ${n} certificates.`);
  } catch (e) {
    state.error = e.message;
    console.error('CA bundle error:', e.message);
  }
  let list = [];
  try {
    list = await reposLib.loadOrMigrate();
  } catch (e) {
    state.error = e.message;
    console.error('Failed to load the repository list:', e.message);
  }
  let lastSync = await fs.readFile(lastSyncFile, 'utf8').then(JSON.parse).catch(() => null);
  if (!lastSync && list.length === 1) {
    // régi, egy-repós last-sync.txt átvétele
    const t = (await fs.readFile(legacyLastSyncFile, 'utf8').catch(() => '')).trim();
    lastSync = t ? { [list[0].id]: t } : {};
  }
  for (const r of list) {
    const ctx = makeCtx(r);
    repos.set(r.id, ctx);
    if (!(await ctx.git.isRepo())) continue;
    try {
      await refreshLocal(ctx);
      ctx.state.lastSync = lastSync?.[r.id] || null;
      console.log(`Local repository loaded: ${r.id} – ${docs.count(r.id)} markdown files.`);
    } catch (e) {
      ctx.state.error = e.message;
      console.error(`Failed to load local repository (${r.id}):`, e.message);
    }
  }
  if (!cfg.serverUrl) console.warn('WARNING: GIT_URL is not set.');
  app.listen(cfg.port, () => console.log(`Markdown Manager: http://0.0.0.0:${cfg.port}`));
})();

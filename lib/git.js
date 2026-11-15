const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const cfg = require('./config');

const ASKPASS = path.join(__dirname, '..', 'askpass.sh');
let caFile = null; // GIT_SSL_CAINFO, ha van egyedi CA
let caError = null;

/**
 * GIT_CA_BUNDLE_BASE64 dekódolása és összefűzése a rendszer CA-kkal (így a publikus hostok is működnek).
 * Elfogad base64-be kódolt PEM-et (sortörésekkel együtt is), vagy közvetlenül PEM-et.
 */
async function setupCustomCA() {
  if (!cfg.caBundleBase64) return null;
  const raw = cfg.caBundleBase64;
  const pem = raw.includes('-----BEGIN')
    ? raw
    : Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!certs) {
    caError = 'GIT_CA_BUNDLE_BASE64 nem tartalmaz érvényes PEM tanúsítványt.';
    throw new Error(caError);
  }
  const system = await fs.readFile(cfg.systemCaFile, 'utf8').catch(() => '');
  const file = path.join(cfg.dataDir, 'ca-bundle.pem');
  await fs.writeFile(file, `${system.trim()}\n\n# --- GIT_CA_BUNDLE_BASE64 ---\n${certs.join('\n')}\n`, { mode: 0o644 });
  caFile = file;
  return certs.length;
}

function redact(s) {
  let out = String(s || '');
  if (cfg.gitToken) out = out.split(cfg.gitToken).join('***');
  return out.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');
}

/** git parancs futtatása; stdout-ot adja vissza (trimelve, ha raw=false). */
function runGit(args, { cwd, input, env = {}, raw = false, binary = false, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'safe.directory=*', '-c', 'core.quotePath=false', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_ASKPASS: ASKPASS,
        GIT_TERMINAL_PROMPT: '0',
        ...(caFile ? { GIT_SSL_CAINFO: caFile } : {}),
        GIT_AUTHOR_NAME: cfg.authorName,
        GIT_AUTHOR_EMAIL: cfg.authorEmail,
        GIT_COMMITTER_NAME: cfg.authorName,
        GIT_COMMITTER_EMAIL: cfg.authorEmail,
        ...env,
      },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err.push(d);
      if (onStderr) onStderr(redact(d.toString('utf8')));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && binary) return resolve(Buffer.concat(out));
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) return resolve(raw ? stdout : stdout.trim());
      const msg = redact(Buffer.concat(err).toString('utf8').trim() || `git ${args[0]} exited with ${code}`);
      const e = new Error(msg);
      e.code = code;
      reject(e);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const noop = { step() {}, progress() {} };

/** git --progress kimenet (\r-rel frissülő sorok) továbbítása a naplónak. */
const progressSink = (log) => (chunk) => {
  for (const part of chunk.split(/\r|\n/)) {
    const t = part.trim();
    if (t) log.progress(t);
  }
};

/**
 * Egy repó git műveletei. repo: { id, url, dir, branch, docsPath } – a git parancsok a repó
 * klónjában (repo.dir) futnak.
 */
function forRepo(repo) {
  const run = (args, opts = {}) => runGit(args, { cwd: repo.dir, ...opts });

  const isRepo = () => exists(path.join(repo.dir, '.git'));

  /** Sparse-checkout minták: csak a megadott könyvtár *.md fájljai (+ képek a rendereléshez). */
  function sparsePatterns() {
    const base = repo.docsPath ? `/${repo.docsPath}/**/` : '/**/';
    const exts = ['md', 'MD', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
    return exts.map((e) => `${base}*.${e}`);
  }

  async function clone(log = noop) {
    await fs.rm(repo.dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repo.dir), { recursive: true });
    const common = ['clone', '--no-checkout', '--branch', repo.branch];
    try {
      // Partial clone: blobok csak igény szerint (csak a *.md fájlok töltődnek le)
      log.step('Partial clone (csak a szükséges fájlok letöltése)…');
      await run([...common, '--progress', '--filter=blob:none', repo.url, repo.dir], { cwd: path.dirname(repo.dir), onStderr: progressSink(log) });
    } catch (e) {
      console.warn('Partial clone nem sikerült, teljes clone következik:', e.message);
      log.step(`Partial clone nem támogatott (${e.message.split('\n').pop()}), teljes clone…`);
      await fs.rm(repo.dir, { recursive: true, force: true });
      await run([...common, '--progress', repo.url, repo.dir], { cwd: path.dirname(repo.dir), onStderr: progressSink(log) });
    }
  }

  /** Letölti/frissíti a repót: alap branch + a meglévő szerkesztési branchek. */
  async function sync(log = noop) {
    if (!cfg.serverUrl) throw new Error('A GIT_URL környezeti változó nincs beállítva.');
    if (caError) throw new Error(caError);
    if (caFile) log.step('Egyedi CA bundle használata.');
    if (!(await isRepo())) {
      log.step('Első szinkronizálás: repó klónozása…');
      await clone(log);
    } else {
      await run(['remote', 'set-url', 'origin', repo.url]);
    }

    log.step(`Sparse-checkout: /${repo.docsPath} → *.md (+ képek)`);
    await run(['sparse-checkout', 'set', '--no-cone', ...sparsePatterns()]);
    log.step(`Fetch: ${repo.branch} + ${cfg.editPrefix}* branchek…`);
    await run([
      'fetch', '--progress', '--prune', 'origin',
      `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`,
      `+refs/heads/${cfg.editPrefix}*:refs/remotes/origin/${cfg.editPrefix}*`,
    ], { onStderr: progressSink(log) });
    log.step(`Checkout: origin/${repo.branch} (markdown fájlok letöltése)…`);
    await run(['checkout', '--progress', '-f', '-B', repo.branch, `origin/${repo.branch}`], { onStderr: progressSink(log) });
    await run(['reset', '--hard', `origin/${repo.branch}`]);
    return headInfo();
  }

  async function headInfo() {
    if (!(await isRepo())) return null;
    try {
      const [commit, date, subject] = (await run(['log', '-1', '--format=%h%x00%cI%x00%s'])).split('\0');
      return { commit, date, subject };
    } catch {
      return null;
    }
  }

  /** Determinisztikus branch név fájlonként → egy fájl = egy branch, akárhány mentés után. */
  function branchName(relPath) {
    const s = relPath
      .replace(/\//g, '__')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+/, '')
      .replace(/\.lock$/i, '-lock');
    return cfg.editPrefix + s;
  }

  /** Szerkesztési branchek: Map<branch, fájl útvonal> (a commit "File:" trailere alapján). */
  async function listEditBranches() {
    if (!(await isRepo())) return new Map();
    const out = await run([
      'for-each-ref',
      '--format=%(refname)%00%(trailers:key=File,valueonly,separator=%x2C)',
      `refs/remotes/origin/${cfg.editPrefix}`,
    ]);
    const map = new Map();
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, file] = line.split('\0');
      map.set(ref.replace(/^refs\/remotes\/origin\//, ''), (file || '').split(',')[0].trim() || null);
    }
    return map;
  }

  async function refExists(ref) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Fájl tartalma egy adott ref-ből (pl. origin/md-edit/...). */
  function showFile(ref, relPath) {
    return run(['show', `${ref}:${relPath}`], { raw: true });
  }

  /**
   * Mentés: commit a fájl saját branch-ére (ha nincs, az alap branch-ből indul), majd push.
   * Munkakönyvtár érintése nélkül (ideiglenes index), így a megjelenített alap verzió érintetlen marad.
   */
  /** Bináris fájl tartalma egy adott ref-ből (pl. kép a szerkesztési branch-en). */
  function showBlob(ref, relPath) {
    return run(['cat-file', 'blob', `${ref}:${relPath}`], { binary: true });
  }

  /** A fájl branch-ének friss állapota: a távoli branch, ha létezik, különben a friss alap branch. */
  async function prepareBranch(relPath) {
    const branch = branchName(relPath);
    const remoteRef = `refs/remotes/origin/${branch}`;

    // Friss állapot lekérése a távoli szerverről
    const remoteHas = (await run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) !== '';
    if (remoteHas) {
      await run(['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`]);
    } else if (await refExists(remoteRef)) {
      // A branch törölve lett a szerveren (pl. merge után) → újrakezdjük az alap branch-ből
      await run(['update-ref', '-d', remoteRef]);
    }
    if (!remoteHas) {
      await run(['fetch', 'origin', `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`]);
    }
    const parent = await run(['rev-parse', remoteHas ? remoteRef : `origin/${repo.branch}`]);
    return { branch, remoteRef, parent };
  }

  /** Commit létrehozása temp indexszel (a munkakönyvtár érintése nélkül) és push a fájl branch-ére. */
  async function commitAndPush({ branch, remoteRef, parent }, relPath, message, indexOps) {
    const indexFile = path.join(cfg.dataDir, `tmp-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await run(['read-tree', parent], { env });
      for (const args of indexOps) await run(['update-index', ...args], { env });
      const tree = await run(['write-tree'], { env });
      const commit = await run(['commit-tree', tree, '-p', parent, '-F', '-'], { input: `${message}\n\nFile: ${relPath}\n` });
      await run(['push', 'origin', `${commit}:refs/heads/${branch}`]);
      await run(['update-ref', remoteRef, commit]);
      return commit;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  /**
   * Fájl törlése: törlő commit a fájl saját branch-ére (a main-ből a PR merge-e után törlődik).
   */
  async function deleteFile(relPath, message) {
    const ctx = await prepareBranch(relPath);
    if (!(await run(['ls-tree', ctx.parent, '--', relPath]))) return { branch: ctx.branch, commit: ctx.parent.slice(0, 7), unchanged: true };
    const msg = (message && message.trim()) || `Delete ${relPath}`;
    const commit = await commitAndPush(ctx, relPath, msg, [['--force-remove', relPath]]);
    return { branch: ctx.branch, commit: commit.slice(0, 7), unchanged: false };
  }

  /**
   * Mentés a fájl saját branch-ére. extraFiles: [{ path, data: Buffer }] – pl. feltöltött képek,
   * amelyek ugyanabba a commitba kerülnek, mint a markdown fájl.
   */
  async function saveFile(relPath, content, message, extraFiles = []) {
    const ctx = await prepareBranch(relPath);
    const { branch, parent } = ctx;

    // Sorvégek és záró újsor megőrzése az eredeti fájl szerint
    let original = null;
    try {
      original = await showFile(parent, relPath);
    } catch {
      /* új fájl */
    }
    let text = content.replace(/\r\n/g, '\n');
    if (original !== null) {
      if (original.endsWith('\n') && !text.endsWith('\n')) text += '\n';
      const crlf = (original.match(/\r\n/g) || []).length;
      const lf = (original.match(/\n/g) || []).length;
      if (crlf > 0 && crlf * 2 >= lf) text = text.replace(/\n/g, '\r\n');
    }

    const treeEntry = async (p) => {
      const ls = await run(['ls-tree', parent, '--', p]);
      if (!ls) return null;
      const [m, , oid] = ls.split(/\s+/);
      return { mode: m, oid };
    };
    const blob = await run(['hash-object', '-w', '--stdin'], { input: text });
    const entry = await treeEntry(relPath);
    const mode = entry?.mode || '100644';
    const mdChanged = entry?.oid !== blob;
    // Csak az új vagy megváltozott képek kerülnek a commitba
    const extras = [];
    for (const f of extraFiles) {
      const oid = await run(['hash-object', '-w', '--stdin'], { input: f.data });
      if ((await treeEntry(f.path))?.oid !== oid) extras.push({ path: f.path, oid });
    }
    if (!mdChanged && !extras.length) return { branch, commit: parent.slice(0, 7), unchanged: true };

    const msg = (message && message.trim()) || `Update ${relPath}`;
    const commit = await commitAndPush(ctx, relPath, msg, [
      ['--add', '--cacheinfo', `${mode},${blob},${relPath}`],
      ...extras.map((x) => ['--add', '--cacheinfo', `100644,${x.oid},${x.path}`]),
    ]);
    return { branch, commit: commit.slice(0, 7), unchanged: false, assets: extras.map((x) => x.path) };
  }

  /**
   * Egy fájl korábbi változatai: a szerkesztési branch saját commitjai (onBranch) + az alap branch előzményei.
   * --no-renames / --follow nélkül: partial clone-nál így nem kell blobokat letölteni.
   */
  async function fileHistory(relPath, editBranch, limit = 100) {
    const fmt = '--format=%H%x00%cI%x00%an%x00%s';
    const parse = (out, onBranch) => out.split('\n').filter(Boolean).map((l) => {
      const [hash, date, author, subject] = l.split('\0');
      return { hash, date, author, subject, onBranch };
    });
    const base = `origin/${repo.branch}`;
    const commits = [];
    if (editBranch && (await refExists(`origin/${editBranch}`))) {
      const range = (await refExists(base)) ? `${base}..origin/${editBranch}` : `origin/${editBranch}`;
      commits.push(...parse(await run(['log', '--no-renames', `-n${limit}`, fmt, range, '--', relPath]), true));
    }
    if (await refExists(base)) {
      commits.push(...parse(await run(['log', '--no-renames', `-n${limit}`, fmt, base, '--', relPath]), false));
    }
    return commits;
  }

  /** Diff egy korábbi változat (rev) és egy ref (az aktuális változat) között, + az azóta készült commitok. */
  async function revDiff(relPath, rev, toRef) {
    const diff = await run(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U5', rev, toRef, '--', relPath], { raw: true });
    const log = await run(['log', '--no-renames', '--format=%h%x00%an%x00%cI%x00%s', `${rev}..${toRef}`, '--', relPath]);
    const commits = log.split('\n').filter(Boolean).map((l) => {
      const [hash, author, date, subject] = l.split('\0');
      return { hash, author, date, subject };
    });
    return { diff, commits };
  }

  /** Diff a szerkesztési branch és az alap branch között (PR-szerűen: merge-base-től), + a branch commitjai. */
  async function diffFile(relPath) {
    const branch = branchName(relPath);
    const base = `origin/${repo.branch}`;
    const head = `origin/${branch}`;
    const diff = await run(['diff', '--no-color', '--no-ext-diff', '-U5', `${base}...${head}`, '--', relPath], { raw: true });
    const log = await run(['log', '--format=%h%x00%an%x00%cI%x00%s', `${base}..${head}`, '--', relPath]);
    const commits = log.split('\n').filter(Boolean).map((l) => {
      const [hash, author, date, subject] = l.split('\0');
      return { hash, author, date, subject };
    });
    return { branch, diff, commits };
  }

  /** Szerkesztési branch törlése a szerverről és helyben. */
  async function deleteBranch(relPath) {
    const branch = branchName(relPath);
    try {
      await run(['push', 'origin', '--delete', branch]);
    } catch (e) {
      // ha a szerveren már nincs meg (pl. merge után törölték), az nem hiba
      if (!/remote ref does not exist|unable to delete .*: remote ref/i.test(e.message)) throw e;
    }
    await run(['update-ref', '-d', `refs/remotes/origin/${branch}`]).catch(() => {});
    return { branch };
  }

  /**
   * Fájlonként az alap branch utolsó commitja: Map<path, {hash, date, author, subject}>.
   * Egyetlen `git log` a docs könyvtárra; --no-renames, hogy partial clone-nál ne kelljen blobot letölteni.
   */
  async function fileCommits() {
    const map = new Map();
    if (!(await isRepo())) return map;
    let out;
    try {
      out = await run(['log', '--no-renames', '--name-only', '--format=%x01%H%x00%cI%x00%an%x00%s', 'HEAD', '--', repo.docsPath || '.']);
    } catch (e) {
      console.warn('Commit adatok lekérése nem sikerült:', e.message);
      return map;
    }
    for (const block of out.split('\x01')) {
      if (!block.trim()) continue;
      const [head, ...names] = block.split('\n');
      const [hash, date, author, subject] = head.split('\0');
      for (const n of names) {
        if (n && /\.(md|markdown)$/i.test(n) && !map.has(n)) map.set(n, { hash, date, author, subject });
      }
    }
    return map;
  }

  /** Szerkesztési branchek utolsó commitja: Map<branch, {hash, date, author, subject}>. */
  async function editBranchCommits() {
    const map = new Map();
    if (!(await isRepo())) return map;
    const out = await run([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)',
      `refs/remotes/origin/${cfg.editPrefix}`,
    ]);
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, hash, date, author, subject] = line.split('\0');
      map.set(ref.replace(/^refs\/remotes\/origin\//, ''), { hash, date, author, subject });
    }
    return map;
  }

  /** A repó webes felülete (csak http/https GIT_URL esetén), token/felhasználónév nélkül. */
  function webBase() {
    let u;
    try {
      u = new URL(repo.url);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    return { web: `${u.protocol}//${u.host}${u.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`, host: u.host.toLowerCase() };
  }

  /** Commit oldal URL-je, pl. https://github.com/org/repo/commit/<hash>; a kliens a {hash} helyére teszi a hash-t. */
  function commitUrlTemplate() {
    const w = webBase();
    if (!w) return null;
    if (w.host.includes('gitlab')) return `${w.web}/-/commit/{hash}`;
    if (w.host.includes('bitbucket')) return `${w.web}/commits/{hash}`;
    return `${w.web}/commit/{hash}`;
  }

  /** Webes link a PR/MR létrehozásához (GitHub, GitLab, Gitea/Forgejo, Bitbucket). */
  function pullRequestUrl(branch) {
    const w = webBase();
    if (!w) return null;
    const { web, host: _h } = w;
    const b = encodeURIComponent(branch);
    const base = encodeURIComponent(repo.branch);
    const host = _h;
    if (host.includes('gitlab')) return `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}&merge_request%5Btarget_branch%5D=${base}`;
    if (host.includes('bitbucket')) return `${web}/pull-requests/new?source=${b}&dest=${base}`;
    return `${web}/compare/${base}...${b}`;
  }

  return { isRepo, sync, headInfo, branchName, listEditBranches, showFile, showBlob, deleteFile, saveFile, fileHistory, revDiff, diffFile, deleteBranch, fileCommits, editBranchCommits, commitUrlTemplate, pullRequestUrl };
}

module.exports = { setupCustomCA, run: runGit, redact, forRepo };

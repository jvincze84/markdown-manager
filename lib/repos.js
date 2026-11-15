// A felületen felvett repók: beolvasás / mentés (/data/repos.json), ellenőrzés, régi beállítás átvétele.
const fs = require('fs/promises');
const path = require('path');
const cfg = require('./config');

const trimSlashes = (s) => String(s ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const SEG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Repó azonosító (a fa legfelső szintje és az útvonalak első eleme): kisbetű, szám, - _ */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Azonosító javaslat a repó útvonalából: "csoport/Dokumentacio.git" → "dokumentacio" */
function idFromPath(repoPath) {
  const last = trimSlashes(repoPath).split('/').pop() || '';
  return last.replace(/\.git$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40);
}

/**
 * Repó útvonal a git szerveren (pl. "csoport/alcsoport/repo.git"): csak relatív útvonal lehet,
 * így a token nem kerülhet más hostra, és git kapcsolót sem lehet becsempészni.
 */
function checkRepoPath(input) {
  const p = trimSlashes(input);
  if (!p) throw new Error('Add meg a repó útvonalát (pl. csoport/repo.git).');
  if (p.length > 200) throw new Error('Túl hosszú repó útvonal.');
  if (!p.split('/').every((s) => SEG.test(s) && s !== '..' && !/^\.+$/.test(s))) {
    throw new Error(`Érvénytelen repó útvonal: ${input} (megengedett: betű, szám, . _ - és / elválasztó)`);
  }
  return p;
}

/** Repón belüli könyvtár (üres = a repó gyökere). */
function checkDir(input, label) {
  const p = trimSlashes(input);
  if (!p) return '';
  if (p.length > 200 || !p.split('/').every((s) => s && !s.startsWith('.') && !/[\x00-\x1f\\:*?"<>|]/.test(s))) {
    throw new Error(`Érvénytelen ${label}: ${input}`);
  }
  return p;
}

/** Branch név (git check-ref-format szabályok egyszerűsítve). */
function checkBranch(input) {
  const b = String(input ?? '').trim();
  if (!b) throw new Error('Add meg az alap branch nevét.');
  if (b.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith('-') || b.startsWith('/') || b.endsWith('/')
    || b.endsWith('.') || b.endsWith('.lock') || b.includes('..') || b.includes('//') || b.split('/').some((s) => s.startsWith('.'))) {
    throw new Error(`Érvénytelen branch név: ${input}`);
  }
  return b;
}

/** Bemenet → ellenőrzött repó beállítás. existing: a már felvett repók (egyediség ellenőrzéshez). */
function normalize(input, existing = [], { editing = null } = {}) {
  const repoPath = editing ? editing.path : checkRepoPath(input.path);
  const id = editing ? editing.id : String(input.id ?? '').trim() || idFromPath(repoPath);
  if (!ID_RE.test(id)) throw new Error(`Érvénytelen azonosító: „${id}” (kisbetű, szám, - és _, legfeljebb 40 karakter)`);
  if (!editing) {
    if (existing.some((r) => r.id === id)) throw new Error(`Már van ilyen azonosítójú repó: ${id}`);
    const key = (p) => p.toLowerCase().replace(/\.git$/, '');
    if (existing.some((r) => key(r.path) === key(repoPath))) throw new Error(`Ez a repó már fel van véve: ${repoPath}`);
  }
  const docsPath = checkDir(input.docsPath, 'könyvtár');
  const assetsPath = checkDir(input.assetsPath, 'képkönyvtár') || [docsPath, 'assets'].filter(Boolean).join('/');
  return { id, path: repoPath, branch: checkBranch(input.branch || cfg.defaultBranch), docsPath, assetsPath };
}

const repoUrl = (r) => `${cfg.serverUrl}/${r.path}`;
const repoDir = (id) => path.join(cfg.reposDir, id);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function load() {
  let list;
  try {
    list = JSON.parse(await fs.readFile(cfg.reposFile, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`A ${cfg.reposFile} nem olvasható: ${e.message}`);
  }
  return (Array.isArray(list) ? list : []).filter((r) => r && ID_RE.test(r.id));
}

async function save(list) {
  const tmp = `${cfg.reposFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2) + '\n');
  await fs.rename(tmp, cfg.reposFile);
}

/**
 * Első indítás: ha nincs repos.json, de a régi (egy-repós) GIT_URL be van állítva, abból lesz az első
 * repó; a meglévő klónt és a mentetlen feltöltéseket is átköltöztetjük (nem kell újra letölteni).
 */
async function loadOrMigrate(log = console.log) {
  const list = await load();
  if (list) return list;
  if (!cfg.legacy) return [];
  const r = normalize({ ...cfg.legacy, path: cfg.legacy.repoPath }, []);
  await fs.mkdir(cfg.reposDir, { recursive: true });
  if (await exists(path.join(cfg.legacyRepoDir, '.git')) && !(await exists(repoDir(r.id)))) {
    await fs.rename(cfg.legacyRepoDir, repoDir(r.id));
    log(`Régi klón átköltöztetve: ${cfg.legacyRepoDir} → ${repoDir(r.id)}`);
  }
  if (await exists(cfg.uploadsDir)) {
    const tmp = `${cfg.uploadsDir}.migrate`;
    await fs.rename(cfg.uploadsDir, tmp);
    await fs.mkdir(cfg.uploadsDir, { recursive: true });
    await fs.rename(tmp, path.join(cfg.uploadsDir, r.id));
  }
  await save([r]);
  log(`Régi GIT_URL beállítás átvéve: „${r.id}” repó (${r.path}).`);
  return [r];
}

module.exports = { ID_RE, idFromPath, checkRepoPath, checkDir, checkBranch, normalize, repoUrl, repoDir, load, save, loadOrMigrate };

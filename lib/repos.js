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
  if (!p) throw new Error('Enter the repository path (e.g. group/repo.git).');
  if (p.length > 200) throw new Error('Repository path is too long.');
  if (!p.split('/').every((s) => SEG.test(s) && s !== '..' && !/^\.+$/.test(s))) {
    throw new Error(`Invalid repository path: ${input} (allowed: letters, digits, . _ - and / as separator)`);
  }
  return p;
}

/** Repón belüli könyvtár (üres = a repó gyökere). */
function checkDir(input, label) {
  const p = trimSlashes(input);
  if (!p) return '';
  if (p.length > 200 || !p.split('/').every((s) => s && !s.startsWith('.') && !/[\x00-\x1f\\:*?"<>|]/.test(s))) {
    throw new Error(`Invalid ${label}: ${input}`);
  }
  return p;
}

/** Branch név (git check-ref-format szabályok egyszerűsítve). */
function checkBranch(input) {
  const b = String(input ?? '').trim();
  if (!b) throw new Error('Enter the base branch name.');
  if (b.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith('-') || b.startsWith('/') || b.endsWith('/')
    || b.endsWith('.') || b.endsWith('.lock') || b.includes('..') || b.includes('//') || b.split('/').some((s) => s.startsWith('.'))) {
    throw new Error(`Invalid branch name: ${input}`);
  }
  return b;
}

/** Bemenet → ellenőrzött repó beállítás. existing: a már felvett repók (egyediség ellenőrzéshez). */
function normalize(input, existing = [], { editing = null } = {}) {
  const repoPath = editing ? editing.path : checkRepoPath(input.path);
  const id = editing ? editing.id : String(input.id ?? '').trim() || idFromPath(repoPath);
  if (!ID_RE.test(id)) throw new Error(`Invalid ID: “${id}” (lowercase letters, digits, - and _, at most 40 characters)`);
  if (!editing && existing.some((r) => r.id === id)) throw new Error(`A repository with this ID already exists: ${id}`);
  const docsPath = checkDir(input.docsPath, 'folder');
  // Ugyanaz a repó többször is felvehető, de csak egymást nem átfedő könyvtárakkal (különben ugyanaz a fájl
  // két helyen jelenne meg, és az egyik helyen elavult állapot látszana): nem lehet azonos, és egyik sem
  // lehet a másik alkönyvtára (a gyökér = '' minden könyvtárat átfed).
  const key = (p) => p.toLowerCase().replace(/\.git$/, '');
  const overlaps = (a, b) => a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const clash = existing.find((r) => r.id !== id && key(r.path) === key(repoPath) && overlaps(docsPath, r.docsPath || ''));
  if (clash) {
    throw new Error(`This repository has already been added as “${clash.id}” with the folder /${clash.docsPath || ''}; `
      + `the same repository can only be added again with a separate folder (not the same, not nested): /${docsPath}`);
  }
  const assetsPath = checkDir(input.assetsPath, 'image folder') || [docsPath, 'assets'].filter(Boolean).join('/');
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
    throw new Error(`Cannot read ${cfg.reposFile}: ${e.message}`);
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
    log(`Old clone moved: ${cfg.legacyRepoDir} → ${repoDir(r.id)}`);
  }
  if (await exists(cfg.uploadsDir)) {
    const tmp = `${cfg.uploadsDir}.migrate`;
    await fs.rename(cfg.uploadsDir, tmp);
    await fs.mkdir(cfg.uploadsDir, { recursive: true });
    await fs.rename(tmp, path.join(cfg.uploadsDir, r.id));
  }
  await save([r]);
  log(`Old GIT_URL setting migrated: repository “${r.id}” (${r.path}).`);
  return [r];
}

module.exports = { ID_RE, idFromPath, checkRepoPath, checkDir, checkBranch, normalize, repoUrl, repoDir, load, save, loadOrMigrate };

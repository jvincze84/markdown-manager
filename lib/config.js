const path = require('path');

const trimSlashes = (s) => (s || '').trim().replace(/^\/+|\/+$/g, '');
const dataDir = process.env.DATA_DIR || '/data';

/**
 * GIT_URL: a git szerver alap URL-je (pl. https://git.myserver.hu); a repókat a felületen kell felvenni,
 * a repó URL-je = <GIT_URL>/<repó útvonal>.
 * Régi (egy-repós) formátum: ha a GIT_URL egy konkrét repóra mutat (.git végű), a szerver része lesz
 * az alap URL, a repó pedig az első indításkor automatikusan felvételre kerül (GIT_BRANCH, GIT_DOCS_PATH,
 * GIT_ASSETS_PATH alapján).
 */
function parseGitUrl(raw) {
  const s = (raw || '').trim().replace(/\/+$/, '');
  if (!s) return { serverUrl: '', legacyRepoPath: null };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { serverUrl: s, legacyRepoPath: null };
  }
  if (/\.git$/i.test(u.pathname)) {
    return { serverUrl: `${u.protocol}//${u.host}`, legacyRepoPath: trimSlashes(decodeURIComponent(u.pathname)) };
  }
  return { serverUrl: s, legacyRepoPath: null };
}

const { serverUrl, legacyRepoPath } = parseGitUrl(process.env.GIT_URL);

module.exports = {
  parseGitUrl,
  serverUrl,
  gitToken: process.env.GIT_TOKEN || '',
  gitUsername: process.env.GIT_USERNAME || 'oauth2',
  // Új repó felvételekor az alapértelmezett alap branch
  defaultBranch: (process.env.GIT_BRANCH || 'main').trim(),
  // Régi, egy-repós beállítás (csak az automatikus átálláshoz)
  legacy: legacyRepoPath ? {
    repoPath: legacyRepoPath,
    branch: (process.env.GIT_BRANCH || 'main').trim(),
    docsPath: trimSlashes(process.env.GIT_DOCS_PATH),
    assetsPath: trimSlashes(process.env.GIT_ASSETS_PATH),
  } : null,
  editPrefix: process.env.EDIT_BRANCH_PREFIX || 'md-edit/',
  authorName: process.env.GIT_AUTHOR_NAME || 'Markdown Manager',
  authorEmail: process.env.GIT_AUTHOR_EMAIL || 'markdown-manager@localhost',
  // Egyedi CA bundle (PEM) base64-ben, pl. belső GitLab self-signed / céges CA tanúsítványához
  caBundleBase64: (process.env.GIT_CA_BUNDLE_BASE64 || '').trim(),
  systemCaFile: process.env.SYSTEM_CA_FILE || '/etc/ssl/certs/ca-certificates.crt',
  dataDir,
  reposDir: path.join(dataDir, 'repos'), // klónok: /data/repos/<repó azonosító>
  reposFile: path.join(dataDir, 'repos.json'), // a felületen felvett repók
  legacyRepoDir: path.join(dataDir, 'repo'), // régi, egy-repós klón helye
  uploadsDir: path.join(dataDir, 'uploads'), // feltöltött, még nem mentett képek: /data/uploads/<repó>/<útvonal>
  port: parseInt(process.env.PORT || '8080', 10),
  appUser: process.env.APP_USERNAME || '',
  appPassword: process.env.APP_PASSWORD || '',
};

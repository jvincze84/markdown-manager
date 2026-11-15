const path = require('path');

const trimSlashes = (s) => (s || '').trim().replace(/^\/+|\/+$/g, '');
const dataDir = process.env.DATA_DIR || '/data';

module.exports = {
  gitUrl: (process.env.GIT_URL || '').trim(),
  gitToken: process.env.GIT_TOKEN || '',
  gitUsername: process.env.GIT_USERNAME || 'oauth2',
  baseBranch: process.env.GIT_BRANCH || 'main',
  // A repón belüli könyvtár, ahonnan a *.md fájlokat töltjük (üres = repo gyökér)
  docsPath: trimSlashes(process.env.GIT_DOCS_PATH),
  // Feltöltött képek helye a repóban (alapértelmezés: <GIT_DOCS_PATH>/assets)
  assetsPath: trimSlashes(process.env.GIT_ASSETS_PATH) || [trimSlashes(process.env.GIT_DOCS_PATH), 'assets'].filter(Boolean).join('/'),
  editPrefix: process.env.EDIT_BRANCH_PREFIX || 'md-edit/',
  authorName: process.env.GIT_AUTHOR_NAME || 'Markdown Manager',
  authorEmail: process.env.GIT_AUTHOR_EMAIL || 'markdown-manager@localhost',
  // Egyedi CA bundle (PEM) base64-ben, pl. belső GitLab self-signed / céges CA tanúsítványához
  caBundleBase64: (process.env.GIT_CA_BUNDLE_BASE64 || '').trim(),
  systemCaFile: process.env.SYSTEM_CA_FILE || '/etc/ssl/certs/ca-certificates.crt',
  dataDir,
  repoDir: path.join(dataDir, 'repo'),
  port: parseInt(process.env.PORT || '8080', 10),
  appUser: process.env.APP_USERNAME || '',
  appPassword: process.env.APP_PASSWORD || '',
};

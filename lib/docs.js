const fs = require('fs/promises');
const path = require('path');
const posix = path.posix;
const MarkdownIt = require('markdown-it');
const anchorMod = require('markdown-it-anchor');
const taskLists = require('markdown-it-task-lists');
const Prism = require('prismjs');
require('prismjs/components/')(); // az összes Prism nyelv (a szerveren nem számít a méret)
require('./prism-extend')(Prism);
const MiniSearchMod = require('minisearch');

const anchor = anchorMod.default || anchorMod;
const MiniSearch = MiniSearchMod.default || MiniSearchMod;

// ---------- Renderelés ----------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
    const key = (lang || '').toLowerCase();
    const grammar = key && Object.prototype.hasOwnProperty.call(Prism.languages, key) && typeof Prism.languages[key] === 'object'
      ? Prism.languages[key] : null;
    const attr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    if (grammar) {
      try {
        return `<pre class="code-hl language-${escapeHtml(key)}"${attr}><code>${Prism.highlight(code, grammar, key)}</code></pre>`;
      } catch { /* fallthrough */ }
    }
    return `<pre class="code-hl"${attr}><code>${escapeHtml(code)}</code></pre>`;
  },
})
  .use(anchor, {
    slugify: (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'),
    permalink: anchor.permalink ? anchor.permalink.headerLink() : undefined,
  })
  .use(taskLists, { enabled: false });

const isRelative = (href) => href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#');

/**
 * Relatív hivatkozás feloldása virtuális útvonallá (<repó>/<útvonal>). A "/" kezdetű hivatkozás a repó
 * gyökeréhez képest értendő; a repóból kivezető hivatkozás érvénytelen (null).
 */
function resolveRel(fromFile, target) {
  let t = target;
  try { t = decodeURIComponent(t); } catch { /* keep */ }
  const root = fromFile.split('/')[0];
  const p = t.startsWith('/') ? posix.normalize(`${root}/${t.slice(1)}`) : posix.normalize(posix.join(posix.dirname(fromFile), t));
  return p.startsWith(`${root}/`) ? p : null;
}

const assetUrl = (p) => '/assets/' + p.split('/').map(encodeURIComponent).join('/');

const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
const defaultLinkOpen = md.renderer.rules.link_open || renderToken;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  const href = t.attrGet('href') || '';
  if (isRelative(href) && env.path) {
    const [p, hash] = href.split('#');
    const resolved = resolveRel(env.path, p);
    if (resolved && /\.(md|markdown)$/i.test(resolved)) {
      t.attrSet('data-md-path', resolved);
      if (hash) t.attrSet('data-md-hash', hash);
    } else if (resolved) {
      t.attrSet('href', assetUrl(resolved));
      t.attrSet('target', '_blank');
    }
  } else if (/^https?:/i.test(href)) {
    t.attrSet('target', '_blank');
    t.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  const src = t.attrGet('src') || '';
  if (isRelative(src) && env.path) {
    const resolved = resolveRel(env.path, src.split(/[?#]/)[0]);
    if (resolved) t.attrSet('src', assetUrl(resolved));
  }
  return defaultImage(tokens, idx, options, env, self);
};

const render = (content, relPath) => md.render(content, { path: relPath });

// ---------- Index + keresés ----------

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Index-megőrző normalizálás (1 karakter → 1 karakter), a snippet kiemeléshez. */
function normChars(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const n = c.normalize('NFD')[0].toLowerCase();
    out += n.length === 1 ? n : c;
  }
  return out;
}

// Repónként: { repo, baseFiles: Map<repó-relatív útvonal, doc> (alap branch, lemezről),
//              files: baseFiles + új fájlok (csak szerkesztési branch-en léteznek) }
// A dokumentumok azonosítója (path) a virtuális útvonal: <repó azonosító>/<repó-relatív útvonal>.
const stores = new Map();
let search = null;

const vpath = (repoId, rel) => `${repoId}/${rel}`;
const allDocs = () => [...stores.values()].flatMap((s) => [...s.files.values()]);

async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

/** Markdown → nagyjából sima szöveg (kereséshez és snippethez). */
function plainText(content) {
  return content
    .replace(/^```.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*~`]+/g, '')
    .replace(/(^|[\s(])_{1,2}(?=\S)/g, '$1')
    .replace(/(\S)_{1,2}(?=[\s).,;:!?]|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeDoc(repo, relPath, content, isNew = false) {
  const name = path.posix.basename(relPath);
  const vp = vpath(repo.id, relPath);
  return {
    id: vp,
    path: vp, // virtuális útvonal
    rel: relPath, // repón belüli útvonal (git műveletekhez)
    repo: repo.id,
    docPath: vpath(repo.id, repo.docsPath ? relPath.slice(repo.docsPath.length + 1) : relPath), // megjelenített útvonal
    name,
    title: extractTitle(content, name.replace(/\.(md|markdown)$/i, '')),
    content,
    plain: plainText(content),
    nplain: null, // lustán számolt normalizált szöveg (pontos kereséshez)
    html: render(content, vp),
    isNew,
  };
}

function reindex() {
  const ms = new MiniSearch({
    fields: ['name', 'title', 'docPath', 'plain'],
    storeFields: ['path'],
    processTerm: (t) => norm(t),
    searchOptions: { boost: { name: 4, title: 3, docPath: 2 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  });
  ms.addAll(allDocs());
  search = ms;
}

/** Egy repó új (csak branch-en létező) fájljainak beállítása: [{ path (repó-relatív), content }] */
function setExtras(repoId, extras, branchContents = new Map()) {
  const st = stores.get(repoId);
  if (!st) return;
  const next = new Map(st.baseFiles);
  // módosított fájlok: a branch-verzió szövege is kereshető legyen
  for (const [p, content] of branchContents) {
    const d = next.get(p);
    if (d) next.set(p, { ...d, branchPlain: plainText(content), branchNplain: null });
  }
  for (const e of extras) if (!next.has(e.path)) next.set(e.path, makeDoc(st.repo, e.path, e.content, true));
  st.files = next;
  reindex();
}

function extractTitle(content, fallback) {
  const m = content.match(/^#\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].trim() : fallback;
}

/** Egy repó fájljainak beolvasása a klónból. repo: { id, dir, docsPath } */
async function rebuild(repo) {
  const list = await walk(path.join(repo.dir, repo.docsPath));
  const next = new Map();
  for (const full of list) {
    const relPath = path.relative(repo.dir, full).split(path.sep).join('/');
    next.set(relPath, makeDoc(repo, relPath, await fs.readFile(full, 'utf8')));
  }
  stores.set(repo.id, { repo, baseFiles: next, files: new Map(next) });
  reindex();
  return next.size;
}

function removeRepo(repoId) {
  stores.delete(repoId);
  reindex();
}

/** Dokumentum virtuális útvonal alapján. */
function get(p) {
  const s = String(p || '');
  const i = s.indexOf('/');
  return i > 0 ? stores.get(s.slice(0, i))?.files.get(s.slice(i + 1)) : undefined;
}

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * A `t` (normalizált) kifejezés előfordulásai a `hay` (normalizált) szövegben.
 * Számmal kezdődő/végződő kifejezésnél a szomszédos karakter nem lehet számjegy
 * (így "172.21.23.12" nem egyezik a "172.21.23.120"-szal). Ugyanez a logika fut a kliensen is.
 */
function findAll(hay, t, from = 0, to = Infinity) {
  const out = [];
  const sd = isDigit(t[0]);
  const ed = isDigit(t[t.length - 1]);
  let i = hay.indexOf(t, from);
  while (i !== -1 && i < to) {
    const ok = !(sd && i > 0 && isDigit(hay[i - 1])) && !(ed && isDigit(hay[i + t.length] || ''));
    if (ok) out.push(i);
    i = hay.indexOf(t, i + (ok ? t.length : 1));
  }
  return out;
}

function markRanges(text, n, terms, start, end) {
  const ranges = [];
  for (const t of terms) for (const i of findAll(n, t, start, end)) ranges.push([i, Math.min(i + t.length, end)]);
  ranges.sort((a, b) => a[0] - b[0]);
  let html = '';
  let pos = start;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    html += escapeHtml(text.slice(pos, a)) + '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
    pos = b;
  }
  return html + escapeHtml(text.slice(pos, end));
}

function snippet(text, terms, n = normChars(text)) {
  let first = -1;
  for (const t of terms) {
    const [i] = findAll(n, t);
    if (i !== undefined && (first === -1 || i < first)) first = i;
  }
  if (first === -1) return escapeHtml(text.slice(0, 180)) + (text.length > 180 ? '…' : '');
  const start = Math.max(0, first - 70);
  const end = Math.min(text.length, first + 170);
  return (start > 0 ? '…' : '') + markRanges(text, n, terms, start, end) + (end < text.length ? '…' : '');
}

/** Teljes szöveg kiemelése (fájlnév/útvonal találatokhoz). */
const highlightAll = (text, terms) => markRanges(text, normChars(text), terms, 0, text.length);

const termsOf = (q) => norm(q || '').split(/\s+/).filter(Boolean);

/**
 * Két független keresés, ha mindkettő meg van adva, ÉS kapcsolattal:
 *  - name:    fájlnév/útvonal, minden szórészletnek szerepelnie kell (ékezetfüggetlen)
 *  - content: tartalom (teljes szöveges index: prefix + enyhe elgépelés-tűrés)
 */
const countOcc = (hay, t) => findAll(hay, t).length;

const nplainOf = (d) => (d.nplain ??= normChars(d.plain));

/**
 * Két független keresés, ha mindkettő meg van adva, ÉS kapcsolattal:
 *  - name:    fájlnév/útvonal, minden szórészletnek szerepelnie kell (ékezetfüggetlen)
 *  - content: PONTOS részszöveg-egyezés (minden szónak szerepelnie kell, ékezetfüggetlen) –
 *             ugyanaz a logika, mint a dokumentumban a kijelölésé, így a találatszám mindig stimmel.
 *             Ha nincs pontos találat és csak sima szavak a keresőszavak, elgépelés-tűrő ("hasonló")
 *             keresés a tartalék.
 */
function query({ name = '', content = '', repos = null } = {}) {
  if (!search) return [];
  const nTerms = termsOf(name);
  const cTerms = termsOf(content);
  if (!nTerms.length && !cTerms.length) return [];

  // repos: csak ezekben a repókban keresünk (null = mindegyikben)
  let candidates = repos ? [...stores.values()].filter((s) => repos.has(s.repo.id)).flatMap((s) => [...s.files.values()]) : allDocs();
  if (nTerms.length) {
    candidates = candidates.filter((d) => {
      const p = norm(d.docPath);
      return nTerms.every((t) => p.includes(t));
    });
  }

  let hits;
  let approximate = false;
  if (cTerms.length) {
    hits = [];
    const scoreIn = (text, title) => {
      let score = 0;
      for (const t of cTerms) {
        const c = countOcc(text, t);
        if (!c) return 0;
        score += c + (countOcc(title, t) ? 10 : 0);
      }
      return score;
    };
    for (const d of candidates) {
      const title = norm(d.title);
      const base = scoreIn(nplainOf(d), title);
      const branch = d.branchPlain != null ? scoreIn((d.branchNplain ??= normChars(d.branchPlain)), title) : 0;
      if (!base && !branch) continue;
      // foundIn: melyik verzióban van a keresett szöveg (a kliens azt nyitja meg)
      const foundIn = branch ? (base ? 'both' : 'branch') : 'base';
      hits.push({ d, score: Math.max(base, branch), foundIn });
    }
    hits.sort((a, b) => b.score - a.score);

    const wordsOnly = cTerms.every((t) => /^\p{L}{4,}$/u.test(t));
    if (!hits.length && wordsOnly) {
      const allowed = new Set(candidates.map((d) => d.path));
      hits = search.search(content, { fields: ['plain'], prefix: false, fuzzy: 0.2, combineWith: 'AND' })
        .filter((r) => allowed.has(r.id))
        .map((r) => ({ d: get(r.id), score: r.score }))
        .filter((h) => h.d);
      approximate = hits.length > 0;
    }
  } else {
    // csak fájlnév: a fájlnévben (nem csak a könyvtárban) talált egyezés előrébb, rövidebb útvonal előrébb
    hits = candidates.map((d) => {
      const fname = norm(d.name);
      return { d, score: nTerms.filter((t) => fname.includes(t)).length * 100 - d.docPath.length };
    });
    hits.sort((a, b) => b.score - a.score);
  }

  return hits.slice(0, 200).map(({ d, score, foundIn = 'base' }) => ({
    path: d.path,
    repo: d.repo,
    docPath: d.docPath,
    pathHtml: nTerms.length ? highlightAll(d.docPath, nTerms) : escapeHtml(d.docPath),
    name: d.name,
    title: d.title,
    isNew: d.isNew,
    score,
    approximate,
    foundIn,
    snippet: !cTerms.length ? null
      : foundIn === 'branch' ? snippet(d.branchPlain, cTerms, d.branchNplain)
        : snippet(d.plain, cTerms, approximate ? undefined : nplainOf(d)),
  }));
}

module.exports = {
  rebuild,
  render,
  query,
  setExtras,
  makeDoc,
  removeRepo,
  get,
  hasBase: (repoId, rel) => Boolean(stores.get(repoId)?.baseFiles.has(rel)),
  list: (repoId) => (repoId ? [...(stores.get(repoId)?.files.values() || [])] : allDocs())
    .map(({ path: p, rel, repo, docPath, name, title, isNew }) => ({ path: p, rel, repo, docPath, name, title, isNew })),
  count: (repoId) => (repoId ? stores.get(repoId)?.files.size || 0 : allDocs().length),
};

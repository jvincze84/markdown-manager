/* global toastui */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Ékezet- és kisbetű-független normalizálás (ugyanaz, mint a szerveren)
  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function normChars(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      const n = c.normalize('NFD')[0].toLowerCase();
      out += n.length === 1 ? n : c;
    }
    return out;
  }
  // Ugyanaz, mint a szerveren: számmal kezdődő/végződő kifejezés mellett nem állhat számjegy
  const isDigit = (c) => c >= '0' && c <= '9';
  function findAll(hay, t) {
    const out = [];
    const sd = isDigit(t[0]);
    const ed = isDigit(t[t.length - 1]);
    let i = hay.indexOf(t);
    while (i !== -1) {
      const ok = !(sd && i > 0 && isDigit(hay[i - 1])) && !(ed && isDigit(hay[i + t.length] || ''));
      if (ok) out.push(i);
      i = hay.indexOf(t, i + (ok ? t.length : 1));
    }
    return out;
  }
  const termsOf = (q) => norm(q || '').split(/\s+/).filter(Boolean);
  const nameQuery = () => $('#search-name').value.trim();
  const contentQuery = () => $('#search-content').value.trim();
  const searchActive = () => Boolean(nameQuery() || contentQuery());

  async function api(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
    return data;
  }

  function toast(msg, type = 'info', ms = 4000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }

  // ---------- Téma (automatikus / világos / sötét) ----------

  const THEMES = { auto: ['🌓', 'automatikus (rendszer szerint)'], light: ['☀️', 'világos'], dark: ['🌙', 'sötét'] };
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const themePref = () => (THEMES[localStorage.getItem('theme')] ? localStorage.getItem('theme') : 'auto');
  const isDark = () => document.documentElement.dataset.theme === 'dark';

  function applyTheme() {
    const pref = themePref();
    const dark = pref === 'dark' || (pref === 'auto' && darkMq.matches);
    const changed = isDark() !== dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#md-css-light').disabled = dark;
    $('#md-css-dark').disabled = !dark;
    const [icon, label] = THEMES[pref];
    const btn = $('#theme-toggle');
    btn.textContent = icon;
    btn.title = `Téma: ${label} — kattintás: váltás`;
    if (changed) for (const l of layers) l.onThemeChange(dark);
  }
  $('#theme-toggle').addEventListener('click', () => {
    const order = Object.keys(THEMES);
    localStorage.setItem('theme', order[(order.indexOf(themePref()) + 1) % order.length]);
    applyTheme();
    toast(`Téma: ${THEMES[themePref()][1]}`, 'info', 1500);
  });
  darkMq.addEventListener('change', applyTheme);

  // ---------- Állapot, fájllista ----------

  let files = [];
  let status = null;

  function renderStatus() {
    const s = status;
    if (!s) return;
    const parts = [];
    if (!s.configured) parts.push('<span class="err">GIT_URL nincs beállítva</span>');
    else parts.push(`<b>${esc(s.repo)}</b>`);
    parts.push(`branch: <code>${esc(s.baseBranch)}</code>`);
    parts.push(`könyvtár: <code>/${esc(s.docsPath)}</code>`);
    if (s.head) parts.push(`commit: <code>${esc(s.head.commit)}</code>`);
    parts.push(`${s.fileCount} fájl`);
    if (s.lastSync) parts.push(`utolsó sync: ${new Date(s.lastSync).toLocaleString()}`);
    if (s.error) parts.push(`<span class="err">Hiba: ${esc(s.error)}</span>`);
    $('#status').innerHTML = parts.join(' · ');
  }

  async function loadAll() {
    [status, files] = await Promise.all([api('/api/status'), api('/api/files')]);
    renderStatus();
    renderView();
    $('#empty').hidden = files.length > 0;
  }

  // ---------- Szűrő: módosított / új fájlok ----------

  let filterChanged = false;
  const isChanged = (f) => Boolean(f.editBranch);

  const prButton = (f) => f.prUrl
    ? `<a class="btn sm pr-link" href="${esc(f.prUrl)}" target="_blank" rel="noopener" title="Pull request: ${esc(f.editBranch)} → ${esc(status?.baseBranch || '')}">↗ Pull request</a>`
    : '';

  const badgeOf = (f) => f.isNew
    ? '<span class="badge new">új</span>'
    : f.isDeleted ? '<span class="badge del">🗑 törölt</span>'
      : f.editBranch ? '<span class="badge">✎ módosított</span>' : '';

  // ---------- Fájl metaadatok: utolsó módosítás, commit hash, szerkesztés gomb ----------

  const rtf = new Intl.RelativeTimeFormat('hu', { numeric: 'auto' });
  function relTime(iso) {
    const sec = (new Date(iso) - Date.now()) / 1000;
    const abs = Math.abs(sec);
    if (abs < 60) return 'most';
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    return new Date(iso).toLocaleDateString('hu-HU');
  }
  const fullTime = (iso) => new Date(iso).toLocaleString('hu-HU');

  function commitTip(c, label) {
    return `${label}: ${fullTime(c.date)}\n${c.hash.slice(0, 10)} · ${c.author}\n${c.subject}`;
  }

  function hashLink(c, cls = '') {
    const short = esc(c.hash.slice(0, 7));
    const url = status?.commitUrl ? status.commitUrl.replace('{hash}', c.hash) : '';
    return url
      ? `<a class="fhash ${cls}" href="${esc(url)}" target="_blank" rel="noopener">${short}</a>`
      : `<code class="fhash ${cls}">${short}</code>`;
  }

  /** Jobb oldali oszlopok: utolsó módosítás, commit hash, szerkesztés gomb. */
  function fileMeta(f) {
    if (!f) return '';
    // módosított/új fájlnál a szerkesztési branch utolsó mentése a legfrissebb
    const c = f.branchCommit || f.commit;
    const onBranch = Boolean(f.branchCommit);
    let tip = '';
    if (f.branchCommit) tip += commitTip(f.branchCommit, `Utolsó mentés (${f.editBranch})`);
    if (f.commit) tip += `${tip ? '\n\n' : ''}${commitTip(f.commit, `Utolsó módosítás (${status?.baseBranch || 'alap'})`)}`;
    return `<span class="fmeta">
      ${c ? `<span class="fdate${onBranch ? ' on-branch' : ''}" title="${esc(tip)}">${onBranch ? '✎ ' : ''}${esc(relTime(c.date))}</span>${hashLink(c, onBranch ? 'on-branch' : '')}`
        : '<span class="fdate muted">—</span><span class="fhash"></span>'}
      <button type="button" class="fedit" data-path="${esc(f.path)}" title="Szerkesztés"${f.isDeleted ? ' style="visibility:hidden"' : ''}>✎</button>
    </span>`;
  }
  const fileByPath = (p) => files.find((f) => f.path === p);

  // módosított fájlnál jelezzük, ha a keresett szöveg csak az egyik verzióban van
  function foundNote(r) {
    if (!r.editBranch || r.isNew || !r.foundIn || r.foundIn === 'both') return '';
    return r.foundIn === 'branch'
      ? '<span class="found-note">csak a módosított verzióban</span>'
      : `<span class="found-note">csak a(z) ${esc(status?.baseBranch || 'alap')} verzióban</span>`;
  }

  function renderChanged() {
    const list = files.filter(isChanged).sort((a, b) => a.docPath.localeCompare(b.docPath));
    $('#changed').innerHTML = list.length
      ? list.map((f) => `
        <div class="crow" data-path="${esc(f.path)}">
          <div class="cmain">
            <div class="rhead"><span class="fname">${esc(f.title)}</span>${badgeOf(f)}</div>
            <div class="rpath">${esc(f.docPath)} · <span class="branch">${esc(f.editBranch)}</span></div>
          </div>
          ${prButton(f)}${fileMeta(f)}
        </div>`).join('')
      : '<div class="rcount">Nincs módosított vagy új fájl.</div>';
  }

  function renderView() {
    const n = files.filter(isChanged).length;
    $('#filter-count').textContent = n;
    $('#filter-changed').classList.toggle('active', filterChanged);
    const searching = searchActive();
    renderTree();
    if (filterChanged) renderChanged();
    $('#tree').hidden = searching || filterChanged;
    $('#clear-filters').hidden = !searching && !filterChanged;
    const hasDirs = files.some((f) => f.docPath.includes('/'));
    $('#expand-all').hidden = $('#collapse-all').hidden = searching || filterChanged || !hasDirs;
    $('#changed').hidden = searching || !filterChanged;
    $('#results').hidden = !searching;
    if (searching) doSearch();
  }

  $('#filter-changed').addEventListener('click', () => {
    filterChanged = !filterChanged;
    renderView();
  });

  function buildTree() {
    const root = { dirs: {}, files: [] };
    for (const f of files) {
      const parts = f.docPath.split('/');
      let node = root;
      for (const d of parts.slice(0, -1)) node = node.dirs[d] ||= { dirs: {}, files: [] };
      node.files.push(f);
    }
    return root;
  }

  function fileItem(f) {
    const badge = f.isNew
      ? `<span class="badge new" title="Új fájl, csak a(z) ${esc(f.editBranch || '')} branch-en létezik">új</span>`
      : f.isDeleted ? `<span class="badge del" title="Törlésre jelölve a(z) ${esc(f.editBranch)} branch-en">törölt</span>`
        : f.editBranch ? `<span class="badge" title="Szerkesztési branch: ${esc(f.editBranch)}">✎</span>` : '';
    return `<li class="frow"><a href="#" class="file${f.isDeleted ? ' deleted' : ''}" data-path="${esc(f.path)}" title="${esc(f.docPath)}">
      <span class="fname">${esc(f.name)}</span>${f.title && f.title !== f.name.replace(/\.md$/i, '') ? `<span class="ftitle">${esc(f.title)}</span>` : ''}${badge}</a>${fileMeta(f)}</li>`;
  }

  // Kibontott könyvtárak (localStorage); null = alapértelmezés (csak a legfelső szint nyitva)
  let openDirs = (() => {
    try { const v = JSON.parse(localStorage.getItem('openDirs')); return Array.isArray(v) ? new Set(v) : null; } catch { return null; }
  })();
  const saveOpenDirs = () => localStorage.setItem('openDirs', JSON.stringify([...openDirs]));

  function renderNode(node, depth, prefix = '') {
    const dirs = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
    const fs = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    let html = '<ul>';
    for (const d of dirs) {
      const key = prefix + d;
      const open = openDirs ? openDirs.has(key) : depth < 1;
      html += `<li><details data-dir="${esc(key)}" ${open ? 'open' : ''}><summary>📁 ${esc(d)}</summary>${renderNode(node.dirs[d], depth + 1, key + '/')}</details></li>`;
    }
    html += fs.map(fileItem).join('');
    return html + '</ul>';
  }

  function renderTree() {
    $('#tree').innerHTML = files.length ? renderNode(buildTree(), 0) : '';
  }

  // a 'toggle' esemény nem buborékol → capture
  $('#tree').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('details[data-dir]')) return;
    if (!openDirs) openDirs = new Set([...$('#tree').querySelectorAll('details[open]')].map((x) => x.dataset.dir));
    if (d.open) openDirs.add(d.dataset.dir);
    else openDirs.delete(d.dataset.dir);
    saveOpenDirs();
  }, true);

  function setAllDirs(open) {
    const all = [...$('#tree').querySelectorAll('details[data-dir]')];
    openDirs = new Set(open ? all.map((d) => d.dataset.dir) : []);
    saveOpenDirs();
    for (const d of all) d.open = open;
  }
  $('#expand-all').addEventListener('click', () => setAllDirs(true));
  $('#collapse-all').addEventListener('click', () => setAllDirs(false));

  $('#clear-filters').addEventListener('click', () => {
    $('#search-name').value = '';
    $('#search-content').value = '';
    filterChanged = false;
    renderView();
    $('#search-name').focus();
  });

  // ---------- Keresés ----------

  let searchTimer;
  let searchSeq = 0;
  async function doSearch() {
    const name = nameQuery();
    const q = contentQuery();
    const seq = ++searchSeq;
    if (!name && !q) {
      $('#results').hidden = true;
      $('#tree').hidden = filterChanged;
      $('#changed').hidden = !filterChanged;
      return;
    }
    let results = await api(`/api/search?name=${encodeURIComponent(name)}&q=${encodeURIComponent(q)}`).catch((e) => (toast(esc(e.message), 'error'), []));
    if (seq !== searchSeq) return;
    if (filterChanged) results = results.filter(isChanged);
    $('#tree').hidden = true;
    $('#changed').hidden = true;
    $('#results').hidden = false;
    const scope = [
      name && `fájlnév: „${esc(name)}”`,
      q && `tartalom: „${esc(q)}”`,
      filterChanged && 'csak módosított / új',
    ].filter(Boolean).join(' · ');
    $('#results').innerHTML = results.length
      ? `<div class="rcount">${results[0].approximate
        ? `Pontos egyezés nincs — ${results.length} hasonló találat (elgépelés-tűréssel)`
        : `${results.length} találat`} — ${scope}</div>` + results.map((r) => `
        <div class="result${r.approximate ? ' approx' : ''}" data-path="${esc(r.path)}" data-found="${esc(r.foundIn || '')}">
          <div class="rtop">
            <div class="cmain">
              <div class="rhead"><span class="fname">${esc(r.title)}</span>${badgeOf(r)}${foundNote(r)}</div>
              <div class="rpath">${r.pathHtml}</div>
            </div>
            ${prButton(r)}${fileMeta(fileByPath(r.path))}
          </div>
          ${r.snippet !== null ? `<div class="rsnip">${r.snippet}</div>` : ''}
        </div>`).join('')
      : `<div class="rcount">Nincs találat — ${scope}.</div>`;
  }
  for (const id of ['#search-name', '#search-content']) {
    $(id).addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderView, 180);
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('.pr-link, a.fhash') || e.target.closest('.layer')) return;
    const edit = e.target.closest('.fedit');
    if (edit) {
      e.preventDefault();
      openLayer(edit.dataset.path, null, { edit: true });
      return;
    }
    const el = e.target.closest('a.file, .result[data-path], .crow[data-path]');
    if (el) {
      e.preventDefault();
      // tartalomkeresés találatánál a megnyitott fájlban kijelöljük a keresett szöveget
      const highlight = el.classList.contains('result') && !el.classList.contains('approx') ? contentQuery() : '';
      // azt a verziót nyitjuk meg, amelyikben a keresett szöveg szerepel
      const source = el.dataset.found === 'base' ? 'base' : undefined;
      openLayer(el.dataset.path, null, { highlight, source });
    }
  });

  // ---------- Sync ----------

  const dlg = $('#sync-dialog');
  let following = false;
  let autoClose = null;

  function setSyncButton(running) {
    const btn = $('#sync');
    btn.classList.toggle('running', running);
    btn.textContent = running ? '⟳ Szinkronizálás…' : '⟳ Sync';
  }

  function openSyncDialog() {
    clearTimeout(autoClose);
    dlg.hidden = false;
  }
  function closeSyncDialog() {
    clearTimeout(autoClose);
    dlg.hidden = true;
  }
  $('.sync-close', dlg).addEventListener('click', closeSyncDialog);
  $('.sync-backdrop', dlg).addEventListener('click', closeSyncDialog);
  $('.sync-box', dlg).addEventListener('mouseenter', () => clearTimeout(autoClose)); // olvasás közben ne záródjon be

  function setSyncState(text, cls) {
    const el = $('.sync-state', dlg);
    el.textContent = text;
    el.className = `sync-state ${cls}`;
  }

  async function followSync() {
    if (following) return;
    following = true;
    setSyncButton(true);
    const logEl = $('.sync-log', dlg);
    const bar = $('.progress', dlg);
    logEl.textContent = '';
    setSyncState('folyamatban', 'running');
    let since = 0;
    let last;
    try {
      for (;;) {
        last = await api(`/api/sync/log?since=${since}`);
        if (last.lines.length) {
          const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
          logEl.textContent += last.lines.join('\n') + '\n';
          if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
        since = last.total;
        $('.sync-current', dlg).textContent = last.running ? (last.progress || '…') : '';
        const pct = last.progress.match(/(\d{1,3})%/);
        bar.classList.toggle('indeterminate', last.running && !pct);
        $('.bar', dlg).style.width = last.running ? (pct ? `${pct[1]}%` : '') : '100%';
        if (!last.running) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (e) {
      last = { ok: false, error: e.message };
    } finally {
      following = false;
      setSyncButton(false);
    }
    bar.classList.toggle('error', !last.ok);
    await loadAll().catch(() => {});
    if (last.ok) {
      setSyncState('kész', 'ok');
      toast(`Sync kész: ${status.fileCount} fájl`, 'success');
      autoClose = setTimeout(closeSyncDialog, 2500);
    } else {
      setSyncState('hiba', 'error');
      openSyncDialog();
      toast(`Sync hiba: ${esc(last.error || '')}`, 'error', 8000);
    }
  }

  $('#sync').addEventListener('click', async () => {
    openSyncDialog();
    if (following) return; // már fut → csak megmutatjuk a naplót
    $('.progress', dlg).classList.remove('error');
    try {
      await api('/api/sync', { method: 'POST' });
    } catch (e) {
      if (e.status !== 409) {
        setSyncState('hiba', 'error');
        $('.sync-log', dlg).textContent = e.message;
        return;
      }
    }
    followSync();
  });

  // ---------- Mermaid (lusta betöltés) ----------

  let mermaidLoading = null;
  function renderMermaid(root) {
    const nodes = root.querySelectorAll('pre.mermaid');
    if (!nodes.length) return;
    mermaidLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid/mermaid.min.js';
      s.onload = () => resolve(window.mermaid);
      s.onerror = reject;
      document.head.append(s);
    });
    mermaidLoading.then((m) => {
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
      return m.run({ nodes });
    }).catch(() => {});
  }

  // ---------- Layerek ----------

  const layers = [];

  class Layer {
    constructor(path, hash, opts = {}) {
      this.creating = Boolean(opts.create);
      this.path = path;
      this.hash = hash;
      this.highlight = opts.highlight || '';
      this.hits = [];
      this.hitIndex = -1;
      this.data = null;
      this.editor = null;
      this.editing = false;
      this.el = $('#layer-tpl').content.firstElementChild.cloneNode(true);
      this.el.style.setProperty('--depth', layers.length);
      document.body.append(this.el);
      document.body.classList.add('has-layer');
      this.bind();
      if (this.creating) this.initCreate(opts.dir || '');
      else this.load(opts.source).then(() => { if (opts.edit && this.data?.content !== undefined) this.startEdit(); });
    }

    initCreate(dir) {
      const prefix = status?.docsPath ? `${status.docsPath}/` : '';
      this.q('.title').textContent = 'Új fájl';
      this.q('.path').textContent = `${prefix}…`;
      this.q('.edit').hidden = true;
      const wrap = this.q('.new-path');
      wrap.hidden = false;
      this.q('.new-path-prefix').textContent = prefix || '/';
      const input = this.q('.new-path-input');
      input.value = dir ? `${dir}/` : '';
      const dirs = [...new Set(files.flatMap((f) => {
        const parts = f.docPath.split('/').slice(0, -1);
        return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
      }))].sort();
      const dl = this.q('.new-path-dirs');
      dl.id = `dirs-${Date.now()}`;
      input.setAttribute('list', dl.id);
      dl.innerHTML = dirs.map((d) => `<option value="${esc(d)}">`).join('');
      input.addEventListener('input', () => {
        this.q('.path').textContent = prefix + (input.value || '…');
      });
      this.data = { content: '# Új dokumentum\n\n' };
      this.startEdit().then(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }

    q(s) { return $(s, this.el); }

    bind() {
      this.q('.layer-backdrop').addEventListener('click', () => this.close());
      this.q('.close').addEventListener('click', () => this.close());
      this.q('.hit-prev').addEventListener('click', () => this.gotoHit(this.hitIndex - 1));
      this.q('.hit-next').addEventListener('click', () => this.gotoHit(this.hitIndex + 1));
      this.q('.hit-clear').addEventListener('click', () => this.clearHighlight());
      this.q('.discard').addEventListener('click', () => this.discard());
      this.q('.delete').addEventListener('click', () => this.deleteFile());
      this.q('.diff-format').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-fmt]');
        if (!b) return;
        localStorage.setItem('diffFormat', b.dataset.fmt);
        this.renderDiff();
      });
      this.el.classList.toggle('narrow', localStorage.getItem('readWidth') === 'narrow');
      this.q('.history').addEventListener('change', (e) => {
        const rev = e.target.value;
        this.load(rev ? undefined : (this.data?.editBranch ? 'branch' : 'base'), rev || undefined);
      });
      this.q('.rev-diff').addEventListener('click', () => this.data?.rev && this.loadDiff(this.data.rev));
      this.q('.diff-back').addEventListener('click', () => this.diffRev && this.load(undefined, this.diffRev));
      this.q('.rev-back').addEventListener('click', () => this.load(this.data?.editBranch ? 'branch' : 'base'));
      this.q('.width').addEventListener('click', () => {
        const narrow = !this.el.classList.contains('narrow');
        localStorage.setItem('readWidth', narrow ? 'narrow' : 'wide');
        layers.forEach((l) => l.el.classList.toggle('narrow', narrow));
      });
      this.q('.edit').addEventListener('click', () => this.startEdit());
      this.q('.cancel').addEventListener('click', () => (this.creating ? this.close() : this.stopEdit()));
      this.q('.new-path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.save(); });
      this.q('.save').addEventListener('click', () => this.save());
      this.q('.layout').addEventListener('click', () => {
        const next = this.editor.getCurrentPreviewStyle() === 'vertical' ? 'tab' : 'vertical';
        this.editor.changePreviewStyle(next);
        localStorage.setItem('previewStyle', next);
      });
      this.q('.commit-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.save(); });
      this.q('.source-toggle').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-src]');
        if (b && !this.editing) this.load(b.dataset.src);
      });
      this.q('.markdown-body').addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;
        if (a.dataset.mdPath) {
          e.preventDefault();
          openLayer(a.dataset.mdPath, a.dataset.mdHash);
        } else if ((a.getAttribute('href') || '').startsWith('#')) {
          e.preventDefault();
          this.scrollTo(a.getAttribute('href').slice(1));
        }
      });
    }

    // ---------- Keresett szöveg kijelölése ----------

    applyHighlight() {
      const terms = termsOf(this.highlight);
      const nav = this.q('.hit-nav');
      this.hits = terms.length ? highlightTerms(this.q('.markdown-body'), terms) : [];
      nav.hidden = !terms.length;
      if (!terms.length) return;
      this.q('.hit-term').textContent = this.highlight;
      this.hitIndex = -1;
      if (this.hits.length) this.gotoHit(0);
      else this.q('.hit-count').textContent = '0 / 0';
    }

    gotoHit(i) {
      if (!this.hits.length) return;
      const n = this.hits.length;
      this.hits[this.hitIndex]?.forEach((m) => m.classList.remove('current'));
      this.hitIndex = ((i % n) + n) % n;
      const group = this.hits[this.hitIndex];
      group.forEach((m) => m.classList.add('current'));
      group[0].scrollIntoView({ block: 'center', behavior: this.hitIndex === 0 && i === 0 ? 'auto' : 'smooth' });
      this.q('.hit-count').textContent = `${this.hitIndex + 1} / ${n}`;
    }

    // Táblázat rendezése után a találatok sorrendje kövesse a dokumentum sorrendjét
    reorderHits() {
      if (this.hits.length < 2) return;
      const cur = this.hits[this.hitIndex];
      this.hits.sort((a, b) => (a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      this.hitIndex = Math.max(0, this.hits.indexOf(cur));
      this.q('.hit-count').textContent = `${this.hitIndex + 1} / ${this.hits.length}`;
    }

    clearHighlight() {
      for (const group of this.hits) for (const m of group) m.replaceWith(document.createTextNode(m.textContent));
      this.q('.markdown-body').normalize();
      this.hits = [];
      this.highlight = '';
      this.q('.hit-nav').hidden = true;
    }

    scrollTo(id) {
      let target = null;
      try { target = this.q(`[id="${CSS.escape(decodeURIComponent(id))}"]`); } catch { /* ignore */ }
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async load(source, rev) {
      if (source === 'diff') return this.loadDiff();
      this.q('.diff-view').hidden = true;
      this.q('.view').hidden = this.editing;
      this.q('.width').hidden = this.editing;
      try {
        // alapértelmezés: a módosított (branch) verzió, ha létezik – a szerver visszaesik az alapra
        const src = source || 'branch';
        this.data = await api(`/api/file?path=${encodeURIComponent(this.path)}&source=${src}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`);
      } catch (e) {
        this.q('.markdown-body').innerHTML = `<p class="err">${esc(e.message)}</p>`;
        return;
      }
      const d = this.data;
      this.q('.title').textContent = d.title;
      this.q('.path').textContent = d.path;
      const toggle = this.q('.source-toggle');
      toggle.hidden = !d.editBranch || d.isNew;
      // törlésre jelölt fájlnál nincs „módosított” változat; szerkeszteni sem lehet (előbb Eldobás)
      toggle.querySelector('[data-src="branch"]').hidden = Boolean(d.isDeleted);
      this.q('.edit').hidden = this.editing || this.creating || Boolean(d.isDeleted);
      this.q('.delete').hidden = this.editing || Boolean(d.isNew) || Boolean(d.isDeleted);
      this.q('.del-banner').hidden = !d.isDeleted || Boolean(d.rev);
      this.q('.del-branch').textContent = d.editBranch || '';
      this.q('.new-badge').hidden = !d.isNew;
      this.q('.base-label').textContent = d.baseBranch;
      toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.src === d.source));
      toggle.title = d.editBranch ? `Branch: ${d.editBranch}` : '';
      const pr = this.q('.pr');
      pr.hidden = !d.prUrl;
      if (d.prUrl) pr.href = d.prUrl;
      this.q('.discard').hidden = !d.editBranch || this.editing;
      this.renderRevBanner();
      if (!this.history) this.loadHistory();
      else this.renderHistory();
      const body = this.q('.markdown-body');
      body.innerHTML = d.html;
      addCopyButtons(body);
      makeTablesSortable(body, () => this.reorderHits());
      this.applyHighlight();
      renderMermaid(body);
      if (this.hash) {
        this.scrollTo(this.hash);
        this.hash = null;
      }
    }

    /** Téma váltás: szerkesztő, diff és (a Mermaid miatt) a renderelt nézet frissítése. */
    onThemeChange(dark) {
      this.q('.toastui-editor-defaultUI')?.classList.toggle('toastui-editor-dark', dark);
      if (!this.q('.diff-view').hidden && this.diffData) this.renderDiff();
      // a Mermaid diagramok SVG-be vannak „égetve” → újrarajzolás a forrásból
      if (!this.editing && this.data && this.q('.view').hidden === false && this.q('.markdown-body .mermaid, .markdown-body [data-processed]')) {
        this.load(this.data.rev ? undefined : this.data.source, this.data.rev || undefined);
      }
    }

    // ---------- Előzmények (korábbi változatok) ----------

    async loadHistory() {
      try {
        this.history = (await api(`/api/history?path=${encodeURIComponent(this.path)}`)).commits;
      } catch {
        this.history = [];
      }
      this.renderHistory();
    }

    renderHistory() {
      const sel = this.q('.history');
      const list = this.history || [];
      sel.hidden = this.editing || !list.length || !this.q('.diff-view').hidden;
      if (!list.length) return;
      const d = this.data || {};
      const fmt = (iso) => new Date(iso).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const opt = (c, i) => {
        const subj = c.subject.length > 60 ? `${c.subject.slice(0, 57)}…` : c.subject;
        // a csoport legfrissebb commitja = a branch / alap aktuális változata
        return `<option value="${esc(c.hash)}" title="${esc(`${c.hash.slice(0, 10)} · ${c.author}\n${c.subject}`)}">${c.onBranch ? '✎ ' : ''}${esc(fmt(c.date))} · ${esc(c.hash.slice(0, 7))} · ${esc(subj)}${i === 0 ? ' (aktuális)' : ''}</option>`;
      };
      const branch = list.filter((c) => c.onBranch);
      const base = list.filter((c) => !c.onBranch);
      sel.innerHTML = `<option value="">🕘 Előzmények (${list.length})</option>`
        + (branch.length ? `<optgroup label="Szerkesztési branch (${esc(d.editBranch || '')})">${branch.map(opt).join('')}</optgroup>` : '')
        + (base.length ? `<optgroup label="${esc(d.baseBranch || 'alap')}">${base.map(opt).join('')}</optgroup>` : '');
      sel.value = d.rev && list.some((c) => c.hash === d.rev) ? d.rev : '';
      sel.classList.toggle('active', Boolean(d.rev));
    }

    renderRevBanner() {
      const d = this.data;
      const banner = this.q('.rev-banner');
      banner.hidden = !d?.rev;
      if (!d?.rev) return;
      const c = (this.history || []).find((x) => x.hash === d.rev);
      this.q('.rev-info').innerHTML = `🕘 Korábbi változat: <code>${esc(d.rev.slice(0, 7))}</code>`
        + (c ? ` · ${esc(new Date(c.date).toLocaleString('hu-HU'))} · ${esc(c.author)} — „${esc(c.subject)}”` : '')
        + (c?.onBranch ? ' <span class="badge">✎ branch</span>' : '');
    }

    // ---------- Diff nézet ----------

    async loadDiff(rev) {
      let r;
      try {
        const q = `/api/diff?path=${encodeURIComponent(this.path)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`;
        [r] = await Promise.all([api(q), loadDiff2Html()]);
      } catch (e) {
        toast(`Diff hiba: ${esc(e.message)}`, 'error');
        return;
      }
      this.diffData = r;
      this.diffRev = rev || null;
      this.q('.source-toggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', !rev && b.dataset.src === 'diff'));
      this.q('.diff-back').hidden = !rev;
      this.q('.view').hidden = true;
      this.q('.width').hidden = true;
      this.q('.hit-nav').hidden = true;
      this.q('.diff-view').hidden = false;
      this.q('.history').hidden = true;
      const added = (r.diff.match(/^\+(?!\+\+)/gm) || []).length;
      const removed = (r.diff.match(/^-(?!--)/gm) || []).length;
      const stat = `<span class="diff-stat"><span class="add">+${added}</span> <span class="del">−${removed}</span></span>`;
      this.q('.diff-info').innerHTML = rev
        ? `<code>${esc(rev.slice(0, 7))}</code> → <code class="${r.onBranch ? 'branch' : ''}">aktuális (${esc(r.target)})</code> ${stat}`
        : `<code>${esc(r.baseBranch)}</code> ← <code class="branch">${esc(r.branch)}</code> ${stat}`;
      this.q('.diff-commits').innerHTML = r.commits.length
        ? `<details><summary>${r.commits.length} commit ${rev ? 'azóta' : 'a branch-en'}</summary><ul>${r.commits.map((c) =>
          `<li><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">— ${esc(c.author)}, ${new Date(c.date).toLocaleString()}</span></li>`).join('')}</ul></details>`
        : '';
      this.renderDiff();
    }

    renderDiff() {
      const fmt = localStorage.getItem('diffFormat') || 'side-by-side';
      this.q('.diff-format').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
      const body = this.q('.diff-body');
      if (!this.diffData.diff.trim()) {
        body.innerHTML = `<p class="muted diff-empty">Nincs eltérés az ${this.diffRev ? 'aktuális változathoz' : 'alap branch-hez'} képest.</p>`;
        return;
      }
      body.innerHTML = window.Diff2Html.html(this.diffData.diff, {
        drawFileList: false, matching: 'lines', outputFormat: fmt, diffStyle: 'word', colorScheme: isDark() ? 'dark' : 'light',
      });
    }

    async deleteFile() {
      const d = this.data;
      if (!d || d.isNew || d.isDeleted) return;
      const pending = d.editBranch && d.source === 'branch'
        ? '\n\nA branch-en lévő módosítások helyett a törlés kerül a PR-be (a korábbi commitok megmaradnak a branch-en).' : '';
      if (!confirm(`Biztosan törlöd a(z) „${d.path}” fájlt?\n\nA törlés egy commit lesz a fájl saját branch-én; a(z) ${d.baseBranch} branch-ből a pull request merge-e után törlődik. Addig az „↺ Eldobás” gombbal visszavonható.${pending}`)) return;
      const btn = this.q('.delete');
      btn.disabled = true;
      try {
        const r = await api(`/api/file?path=${encodeURIComponent(this.path)}`, { method: 'DELETE' });
        const link = r.prUrl ? ` · <a href="${esc(r.prUrl)}" target="_blank" rel="noopener">PR nyitása ↗</a>` : '';
        toast(`Törlésre jelölve: <code>${esc(r.branch)}</code> (${esc(r.commit)})${link}`, 'success', 8000);
        files = await api('/api/files');
        renderView();
        this.history = null;
        await this.load('base');
      } catch (e) {
        toast(`Törlési hiba: ${esc(e.message)}`, 'error', 10000);
      } finally {
        btn.disabled = false;
      }
    }

    async discard() {
      const d = this.data;
      const what = d.isNew
        ? `Az új fájl (${d.path}) még nincs az alap branch-en, így a branch törlésével a fájl is elveszik.`
        : d.isDeleted
          ? 'A törlés visszavonódik, a fájl megmarad.'
          : `A módosítások elvesznek, a fájl az alap (${d.baseBranch}) verzióra áll vissza.`;
      if (!confirm(`Biztosan eldobod a(z) „${d.editBranch}” branch-et?\n\n${what}\n\nEz nem vonható vissza.`)) return;
      try {
        const r = await api(`/api/branch?path=${encodeURIComponent(this.path)}`, { method: 'DELETE' });
        toast(`Branch eldobva: <code>${esc(r.branch)}</code>`, 'success');
        files = await api('/api/files');
        renderView();
        this.history = null;
        if (r.removed) this.close(true);
        else await this.load('base');
      } catch (e) {
        toast(`Eldobási hiba: ${esc(e.message)}`, 'error', 10000);
      }
    }

    setEditing(on) {
      this.editing = on;
      if (on) this.q('.diff-view').hidden = true;
      this.q('.discard').hidden = on || !this.data?.editBranch;
      this.q('.view').hidden = on;
      this.q('.editor').hidden = !on;
      for (const s of ['.commit-msg', '.layout', '.save', '.cancel']) this.q(s).hidden = !on;
      this.q('.width').hidden = on;
      this.q('.history').hidden = on || !this.history?.length;
      if (this.highlight) this.q('.hit-nav').hidden = on;
      this.q('.edit').hidden = on || this.creating || Boolean(this.data?.isDeleted);
      this.q('.delete').hidden = on || this.creating || !this.data || Boolean(this.data.isNew || this.data.isDeleted);
      this.q('.source-toggle').classList.toggle('disabled', on);
      this.el.classList.toggle('editing', on);
    }

    async startEdit() {
      if (this.data?.isDeleted) {
        toast('A fájl törlésre van jelölve. Szerkesztés előtt vond vissza a törlést (↺ Eldobás).', 'info', 6000);
        return;
      }
      // Mindig a legfrissebb verziót szerkesztjük: ha van szerkesztési branch, abból
      if (this.data?.rev) await this.load(); // korábbi változat nézegetése közben az aktuálisat szerkesztjük
      if (this.data?.editBranch && this.data.source !== 'branch') await this.load('branch');
      this.setEditing(true);
      const content = this.data.content;
      if (!this.editor) {
        this.editor = new toastui.Editor({
          el: this.q('.editor'),
          height: '100%',
          initialEditType: 'markdown',
          previewStyle: localStorage.getItem('previewStyle') || 'vertical',
          initialValue: content,
          usageStatistics: false,
          autofocus: true,
          theme: isDark() ? 'dark' : 'light',
          plugins: [[toastui.plugins.codeSyntaxHighlight, { highlighter: toastui.Prism }]],
          // Kép beszúrása fájlból / beillesztés / behúzás: base64 helyett feltöltés az assets könyvtárba
          hooks: { addImageBlobHook: (blob, callback) => { this.uploadImage(blob, callback); return false; } },
          // Előnézet: a relatív képútvonalakat a dokumentum helyéhez képest oldjuk fel (/assets/...)
          customHTMLRenderer: {
            image: (node, { getChildrenText, skipChildren }) => {
              const alt = getChildrenText(node);
              skipChildren();
              return {
                type: 'openTag', tagName: 'img', selfClose: true,
                attributes: { src: resolveAssetUrl(this.docPath(), node.destination), alt, ...(node.title ? { title: node.title } : {}) },
              };
            },
          },
        });
        this.addTableFormatButton();
        this.addEmojiButton();
      } else {
        this.editor.setMarkdown(content, false);
      }
      resetEditorHistory(this.editor);
      this.original = this.editor.getMarkdown();
      this.q('.commit-msg').value = '';
    }

    addTableFormatButton() {
      // Beépített gombtípus + saját parancs (az egyedi `el` elem a destroy-nál DOM hibát okoz)
      const run = () => { this.formatTables(); return true; };
      this.editor.addCommand('markdown', 'formatTables', run);
      this.editor.addCommand('wysiwyg', 'formatTables', run);
      this.editor.insertToolbarItem({ groupIndex: 3, itemIndex: 1 }, {
        name: 'formatTables',
        tooltip: 'Táblázatok rendezése (oszlopok igazítása az egész dokumentumban)',
        className: 'toastui-editor-toolbar-icons tbl-format',
        text: '⊞⇥',
        command: 'formatTables',
      });
    }

    addEmojiButton() {
      const picker = createEmojiPicker((emoji, keepOpen) => {
        this.editor.insertText(emoji);
        if (!keepOpen) {
          this.editor.eventEmitter.emit('closePopup');
          this.editor.focus();
        }
      });
      this.editor.insertToolbarItem({ groupIndex: 3, itemIndex: 4 }, {
        name: 'emoji',
        tooltip: 'Emoji beszúrása',
        className: 'toastui-editor-toolbar-icons emoji-btn',
        text: '😀',
        popup: { className: 'emoji-popup', body: picker.el, style: { width: 'auto' } },
      });
      // megnyitáskor: adat betöltése (első alkalommal) és fókusz a keresőbe
      this.q('.emoji-btn')?.addEventListener('click', () => setTimeout(() => picker.open(), 0));
    }

    formatTables() {
      const ed = this.editor;
      const before = ed.getMarkdown();
      const { text, count } = window.MdTable.formatTables(before);
      if (!count) return toast('Nincs táblázat a dokumentumban.', 'info');
      if (text === before) return toast(`${count} táblázat — már rendezett.`, 'info');
      const md = ed.isMarkdownMode();
      const sel = md ? ed.getSelection() : null;
      const scroller = md ? this.q('.toastui-editor-md-container .ProseMirror') : null;
      const top = scroller?.scrollTop;
      if (md) {
        // Kijelölés-csere: így Ctrl+Z-vel visszavonható (a setMarkdown törölné az előzményt)
        const old = before.split(/\r?\n/);
        ed.setSelection([1, 1], [old.length, old[old.length - 1].length + 1]);
        ed.replaceSelection(text);
      } else {
        ed.setMarkdown(text, false);
      }
      if (sel) {
        // A sorok száma nem változik, így a kurzor ugyanabban a sorban marad
        const lines = text.split(/\r?\n/);
        const fix = ([l, c]) => [l, Math.min(c, (lines[l - 1] ?? '').length + 1)];
        try { ed.setSelection(fix(sel[0]), fix(sel[1])); } catch { /* nem kritikus */ }
        ed.focus();
        if (scroller) scroller.scrollTop = top;
      }
      toast(`${count} táblázat rendezve.`, 'success');
    }

    /** A szerkesztett dokumentum repo-relatív útvonala (új fájlnál a beírt útvonalból). */
    docPath() {
      if (!this.creating) return this.path;
      let p = this.q('.new-path-input').value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (!p || p.endsWith('/')) p += 'uj.md';
      if (!/\.(md|markdown)$/i.test(p)) p += '.md';
      return (status?.docsPath ? `${status.docsPath}/` : '') + p;
    }

    async uploadImage(blob, callback) {
      const name = blob.name || `kep.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
      const doc = this.docPath();
      const t = toast(`Kép feltöltése: ${esc(name)}…`, 'info', 30000);
      try {
        const res = await fetch(`/api/upload?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(name)}`, {
          method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
        });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r.error || res.statusText);
        (this.uploads ||= []).push({ path: r.path, url: r.url, doc });
        callback(r.url, name.replace(/\.[^.]+$/, ''));
        t?.remove?.();
        toast(`Kép feltöltve: <code>${esc(r.path)}</code> — mentéskor a commit része lesz.`, 'success');
      } catch (e) {
        t?.remove?.();
        toast(`Képfeltöltési hiba: ${esc(e.message)}`, 'error', 10000);
      }
    }

    /** Új fájlnál a feltöltéskor számolt relatív képútvonalakat a végleges helyhez igazítjuk. */
    fixUploadLinks(content) {
      const doc = this.docPath();
      for (const u of this.uploads || []) {
        if (u.doc === doc) continue;
        const rel = relativePath(dirOf(doc), u.path).split('/').map(encodeURIComponent).join('/');
        content = content.split(`](${u.url})`).join(`](${rel})`);
      }
      return content;
    }

    dirty() {
      return this.editing && this.editor && this.editor.getMarkdown() !== this.original;
    }

    stopEdit(force) {
      if (!force && (this.dirty() || (this.creating && this.q('.new-path-input').value.trim())) && !confirm('Elveted a mentetlen módosításokat?')) return false;
      this.setEditing(false);
      return true;
    }

    async save() {
      if (this.saving) return;
      this.saving = true;
      const btn = this.q('.save');
      btn.disabled = true;
      btn.textContent = '💾 Mentés…';
      try {
        const md = this.editor.getMarkdown();
        const payload = { content: this.creating ? this.fixUploadLinks(md) : md, message: this.q('.commit-msg').value };
        const r = this.creating
          ? await api('/api/file', { method: 'POST', body: JSON.stringify({ ...payload, path: this.q('.new-path-input').value }) })
          : await api('/api/file', { method: 'PUT', body: JSON.stringify({ ...payload, path: this.path }) });
        if (this.creating) {
          this.creating = false;
          this.path = r.path;
          this.q('.new-path').hidden = true;
          this.q('.edit').hidden = false;
        }
        if (r.unchanged) {
          toast('Nincs változás, nem történt commit.', 'info');
        } else {
          const link = r.prUrl ? ` · <a href="${esc(r.prUrl)}" target="_blank" rel="noopener">PR nyitása ↗</a>` : '';
          toast(`Mentve és push-olva: <code>${esc(r.branch)}</code> (${esc(r.commit)})${link}`, 'success', 8000);
        }
        this.stopEdit(true);
        this.history = null; // új commit → előzmények újratöltése
        await this.load('branch');
        files = await api('/api/files');
        renderView();
      } catch (e) {
        toast(`Mentési hiba: ${esc(e.message)}`, 'error', 10000);
      } finally {
        this.saving = false;
        btn.disabled = false;
        btn.textContent = '💾 Mentés';
      }
    }

    close(force) {
      if (!force && this.editing && !this.stopEdit()) return;
      this.el.remove();
      if (this.editor) {
        // A Toast UI a szerkesztő elrejtése után késleltetve rajzolja újra az eszköztárat; ha előbb
        // szüntetnénk meg, az újrarajzolás DOM hibát dobna → a destroy a függő frissítések után fut.
        const ed = this.editor;
        setTimeout(() => { try { ed.destroy(); } catch { /* már leválasztva */ } }, 1000);
      }
      layers.splice(layers.indexOf(this), 1);
      if (!layers.length) document.body.classList.remove('has-layer');
    }
  }

  function openLayer(path, hash, opts) {
    layers.push(new Layer(path, hash, opts));
  }

  $('#new-file').addEventListener('click', () => {
    if (!status?.head) return toast('Előbb futtasd a Sync-et.', 'error');
    openLayer(null, null, { create: true });
  });

  // ---------- Kódblokk másolás ----------

  async function copyText(text) {
    // a Clipboard API csak HTTPS-en / localhoston érhető el → tartalék megoldás sima HTTP-re
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('A böngésző nem engedte a vágólapra másolást.');
  }

  function addCopyButtons(root) {
    for (const pre of root.querySelectorAll('pre:not(.mermaid)')) {
      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      pre.replaceWith(wrap);
      wrap.append(pre);
      if (pre.dataset.lang) {
        const lang = document.createElement('span');
        lang.className = 'code-lang';
        lang.textContent = pre.dataset.lang;
        wrap.append(lang);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.title = 'Másolás a vágólapra';
      btn.textContent = '⧉ Másolás';
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code') || pre;
        try {
          await copyText(code.textContent.replace(/\n$/, ''));
          btn.textContent = '✓ Másolva';
          btn.classList.add('done');
        } catch (e) {
          btn.textContent = '✕ Hiba';
          toast(esc(e.message), 'error');
        }
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.textContent = '⧉ Másolás';
          btn.classList.remove('done');
        }, 1500);
      });
      wrap.append(btn);
    }
  }

  // A betöltött tartalom ne legyen visszavonható lépés (különben a Ctrl+Z kiüríti a dokumentumot).
  // A Toast UI erre nem ad API-t, ezért a ProseMirror állapotot újra létrehozzuk friss előzménnyel.
  function resetEditorHistory(editor) {
    for (const sub of [editor.mdEditor, editor.wwEditor]) {
      const view = sub?.view;
      if (!view) continue;
      try {
        const st = view.state;
        view.updateState(st.constructor.create({ doc: st.doc, selection: st.selection, plugins: st.plugins }));
      } catch { /* nem kritikus */ }
    }
  }

  // ---------- Képútvonalak ----------

  const dirOf = (p) => p.split('/').slice(0, -1).join('/');
  function normalizePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
    }
    return out.join('/');
  }
  function relativePath(fromDir, to) {
    const a = fromDir ? fromDir.split('/') : [];
    const b = to.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  }
  /** Markdown képhivatkozás → böngészőben megjeleníthető URL (relatív útvonal a dokumentumhoz képest). */
  function resolveAssetUrl(docPath, src) {
    if (!src || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(src)) return src;
    let s = src.split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch { /* marad */ }
    const p = normalizePath(s.startsWith('/') ? s : `${dirOf(docPath)}/${s}`);
    return p === null ? src : '/assets/' + p.split('/').map(encodeURIComponent).join('/');
  }

  // ---------- Emoji választó ----------

  let emojiData = null;
  const loadEmojis = () => (emojiData ||= fetch('/vendor-built/emoji.json').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).catch((e) => { emojiData = null; throw e; }));

  const EMOJI_GROUPS = [
    [0, '😀', 'Hangulatjelek'], [1, '👋', 'Emberek, testrészek'], [3, '🐶', 'Állatok, természet'],
    [4, '🍔', 'Étel, ital'], [5, '✈️', 'Utazás, helyek'], [6, '⚽', 'Tevékenységek'],
    [7, '💡', 'Tárgyak'], [8, '❤️', 'Szimbólumok'], [9, '🏁', 'Zászlók'],
  ];
  const RECENT_KEY = 'recentEmojis';
  const recentEmojis = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
  const normSearch = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /** Emoji választó (kereső + kategóriák + legutóbbiak). onPick(emoji, keepOpen) */
  function createEmojiPicker(onPick) {
    const el = document.createElement('div');
    el.className = 'emoji-picker';
    el.innerHTML = `
      <input class="emoji-search" type="search" placeholder="Keresés… (pl. szív, pipa, rakéta, tada)" autocomplete="off" spellcheck="false">
      <div class="emoji-tabs"><button type="button" data-tab="recent" title="Legutóbb használt">🕘</button>${EMOJI_GROUPS.map(([g, icon, name]) =>
        `<button type="button" data-tab="${g}" title="${esc(name)}">${icon}</button>`).join('')}</div>
      <div class="emoji-grid"><div class="emoji-loading">Betöltés…</div></div>
      <div class="emoji-foot"><span class="emoji-preview"></span><span class="emoji-name">Shift+kattintás: több emoji beszúrása</span></div>`;
    const search = el.querySelector('.emoji-search');
    const grid = el.querySelector('.emoji-grid');
    let data = null;
    const btn = (e) => `<button type="button" class="emoji" data-e="${esc(e[0])}" title="${esc(e[2])}">${e[0]}</button>`;
    const byEmoji = new Map();

    function renderAll() {
      const recent = recentEmojis().map((u) => byEmoji.get(u)).filter(Boolean);
      grid.innerHTML = (recent.length ? `<h4 data-sec="recent">Legutóbb használt</h4><div class="emoji-set">${recent.map(btn).join('')}</div>` : '')
        + EMOJI_GROUPS.map(([g, , name]) => `<h4 data-sec="${g}">${esc(name)}</h4><div class="emoji-set">${data.filter((e) => e[1] === g).map(btn).join('')}</div>`).join('');
      el.querySelector('[data-tab="recent"]').disabled = !recent.length;
    }
    function renderSearch(q) {
      const terms = normSearch(q).split(/\s+/).filter(Boolean);
      // rangsor: pontos név < a név egész szóként tartalmazza < a név tartalmazza < csak kulcsszóban
      const score = (e) => {
        const name = e.n ||= normSearch(e[2]);
        const words = name.split(/[\s:,-]+/);
        let sc = 0;
        for (const t of terms) {
          sc += name === t ? 0 : words.includes(t) ? 1 : words.some((w) => w.startsWith(t)) ? 2 : name.includes(t) ? 3 : 4;
        }
        return sc;
      };
      const hits = data.filter((e) => terms.every((t) => e[3].includes(t)))
        .map((e, i) => ({ e, i, sc: score(e) }))
        .sort((x, y) => x.sc - y.sc || x.e.n.length - y.e.n.length || x.i - y.i)
        .map((x) => x.e);
      grid.innerHTML = hits.length
        ? `<div class="emoji-set">${hits.slice(0, 400).map(btn).join('')}</div>`
        : '<div class="emoji-loading">Nincs találat.</div>';
    }
    const refresh = () => { if (!data) return; grid.scrollTop = 0; if (search.value.trim()) renderSearch(search.value); else renderAll(); };

    function pick(u, keepOpen) {
      const list = [u, ...recentEmojis().filter((x) => x !== u)].slice(0, 32);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      onPick(u, keepOpen);
    }
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('button.emoji');
      if (b) pick(b.dataset.e, e.shiftKey);
    });
    grid.addEventListener('mouseover', (e) => {
      const b = e.target.closest('button.emoji');
      if (!b) return;
      el.querySelector('.emoji-preview').textContent = b.dataset.e;
      el.querySelector('.emoji-name').textContent = b.title;
    });
    search.addEventListener('input', refresh);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = grid.querySelector('button.emoji');
        if (first) pick(first.dataset.e, e.shiftKey);
      }
    });
    el.querySelector('.emoji-tabs').addEventListener('click', (e) => {
      const t = e.target.closest('button[data-tab]');
      if (!t) return;
      if (search.value) { search.value = ''; refresh(); }
      const h = grid.querySelector(`h4[data-sec="${t.dataset.tab}"]`);
      if (h) grid.scrollTop = h.offsetTop - grid.offsetTop;
    });

    async function open() {
      search.focus();
      if (!data) {
        try {
          data = await loadEmojis();
          for (const e of data) byEmoji.set(e[0], e);
        } catch (err) {
          grid.innerHTML = `<div class="emoji-loading err">Nem sikerült betölteni: ${esc(err.message)}</div>`;
          return;
        }
      }
      refresh();
    }
    return { el, open };
  }

  // ---------- Rendezhető táblázatok ----------

  const collator = new Intl.Collator('hu', { numeric: true, sensitivity: 'base' });
  // Szám felismerése: "1 234,5", "-3.2", "42%", "10 GB" → szám; egyébként null
  function numOf(s) {
    const m = s.replace(/[\s\u00a0]/g, '').match(/^([-+−]?)(\d+(?:[.,]\d+)?)([%a-zA-Z€$£]*)$/);
    if (!m) return null;
    const v = parseFloat(m[2].replace(',', '.'));
    return m[1] && m[1] !== '+' ? -v : v;
  }

  function makeTablesSortable(root, onSort) {
    for (const table of root.querySelectorAll('table')) {
      const tbody = table.tBodies[0];
      const ths = table.tHead?.rows[0]?.cells;
      if (!tbody || !ths || tbody.rows.length < 2) continue;
      const original = [...tbody.rows];
      let state = { col: -1, dir: 0 };
      [...ths].forEach((th, col) => {
        th.classList.add('sortable');
        th.tabIndex = 0;
        th.title = 'Rendezés (kattintás: növekvő → csökkenő → eredeti)';
        const sort = () => {
          const dir = state.col === col ? (state.dir === 1 ? -1 : state.dir === -1 ? 0 : 1) : 1;
          state = { col, dir };
          let rows = original;
          if (dir) {
            const key = (tr) => (tr.cells[col]?.textContent || '').trim();
            const vals = original.map((tr) => ({ tr, t: key(tr) }));
            const numeric = vals.every((v) => !v.t || numOf(v.t) !== null);
            vals.sort((a, b) => {
              // Üres cellák mindig a végére
              if (!a.t || !b.t) return (!a.t) - (!b.t);
              const r = numeric ? numOf(a.t) - numOf(b.t) : collator.compare(a.t, b.t);
              return r * dir;
            });
            rows = vals.map((v) => v.tr);
          }
          tbody.append(...rows);
          for (const h of ths) h.removeAttribute('aria-sort');
          th.setAttribute('aria-sort', dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none');
          onSort?.();
        };
        th.addEventListener('click', (e) => { if (!e.target.closest('a')) sort(); });
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
      });
    }
  }

  let diff2htmlLoading = null;
  function loadDiff2Html() {
    diff2htmlLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/diff2html/js/diff2html.min.js';
      s.onload = resolve;
      s.onerror = () => { diff2htmlLoading = null; reject(new Error('diff2html betöltése sikertelen')); };
      document.head.append(s);
    });
    return diff2htmlLoading;
  }

  const BLOCKS = 'p, li, td, th, pre, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, div, article, summary';

  /**
   * A keresett kifejezések <mark>-kal jelölése (ékezetfüggetlen). Egy blokkon belül több
   * szövegcsomóponton átívelő egyezést is megtalál (pl. szintaxis-kiemelt kódban az IP-cím).
   * Visszatérés: találatonként a hozzá tartozó <mark> elemek tömbje.
   */
  function highlightTerms(root, terms) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('script, style, pre.mermaid, svg, button, .code-lang')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const segs = [];
    let text = '';
    let prevBlock;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const block = node.parentElement.closest(BLOCKS);
      if (segs.length && block !== prevBlock) text += '\u0000'; // blokkhatáron nem lehet egyezés
      prevBlock = block;
      segs.push({ node, start: text.length, end: text.length + node.nodeValue.length, pieces: [] });
      text += node.nodeValue;
    }
    const n = normChars(text);
    const ranges = [];
    for (const t of terms) for (const i of findAll(n, t)) ranges.push([i, i + t.length]);
    ranges.sort((a, b) => a[0] - b[0]);
    const hits = [];
    let last = -1;
    for (const [a, b] of ranges) {
      if (a < last) continue;
      last = b;
      const hit = hits.length;
      hits.push([]);
      for (const seg of segs) {
        if (seg.end <= a || seg.start >= b) continue;
        seg.pieces.push({ from: Math.max(a, seg.start) - seg.start, to: Math.min(b, seg.end) - seg.start, hit });
      }
    }
    for (const seg of segs) {
      if (!seg.pieces.length) continue;
      const value = seg.node.nodeValue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const { from, to, hit } of seg.pieces) {
        frag.append(value.slice(pos, from));
        const m = document.createElement('mark');
        m.className = 'search-hit';
        m.textContent = value.slice(from, to);
        frag.append(m);
        hits[hit].push(m);
        pos = to;
      }
      frag.append(value.slice(pos));
      seg.node.replaceWith(frag);
    }
    return hits;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && layers.length) {
      e.preventDefault();
      layers[layers.length - 1].close();
    } else if (e.key === '/' && !layers.length && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      $('#search-name').focus();
    } else if (e.key === 'F3' && layers.length) {
      const top = layers[layers.length - 1];
      if (top.hits.length && !top.editing) {
        e.preventDefault();
        top.gotoHit(top.hitIndex + (e.shiftKey ? -1 : 1));
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's' && layers.length) {
      const top = layers[layers.length - 1];
      if (top.editing) {
        e.preventDefault();
        top.save();
      }
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (layers.some((l) => l.dirty())) e.preventDefault();
  });

  applyTheme();
  loadAll()
    .then(() => { if (status?.syncing) followSync(); })
    .catch((e) => toast(esc(e.message), 'error'));
})();

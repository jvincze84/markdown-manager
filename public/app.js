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
  /**
   * Keresőkifejezés (ugyanaz, mint a szerveren) → normalizált keresőszavak. Idézőjelek közti rész ("…", „…”, “…”) egy kifejezés:
   * pontos egyezés, a szavak sorrendjében (a szóközök száma nem számít). Lezáratlan idézőjel: a sor végéig.
   */
  function termsOf(q) {
    const out = [];
    const s = norm(q || '').replace(/[„“”]/g, '"');
    for (const m of s.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
      const t = (m[1] ?? m[2]).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }
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

  const THEMES = { auto: ['🌓', 'auto (follows the system)'], light: ['☀️', 'light'], dark: ['🌙', 'dark'] };
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
    $('meta[name="theme-color"]').content = dark ? '#161b22' : '#24292f'; // a fejléc színe (PWA ablak / mobil címsor)
    const [icon, label] = THEMES[pref];
    const btn = $('#theme-toggle');
    btn.textContent = icon;
    btn.title = `Theme: ${label} — click to switch`;
    if (changed) for (const l of layers) l.onThemeChange(dark);
  }
  $('#theme-toggle').addEventListener('click', () => {
    const order = Object.keys(THEMES);
    localStorage.setItem('theme', order[(order.indexOf(themePref()) + 1) % order.length]);
    applyTheme();
    toast(`Theme: ${THEMES[themePref()][1]}`, 'info', 1500);
  });
  darkMq.addEventListener('change', applyTheme);

  // ---------- Állapot, fájllista ----------

  let files = [];
  let status = null;

  const repoList = () => status?.repos || [];
  const repoInfo = (id) => repoList().find((r) => r.id === id) || null;
  const baseOf = (f) => repoInfo(f?.repo)?.branch || 'base';

  function renderStatus() {
    const s = status;
    if (!s) return;
    const parts = [];
    if (!s.configured) parts.push('<span class="err">GIT_URL is not set</span>');
    else parts.push(`<b>${esc(s.server)}</b>`);
    parts.push(`${s.repos.length} ${s.repos.length === 1 ? 'repository' : 'repositories'}`);
    parts.push(`${s.totalFiles} ${s.totalFiles === 1 ? 'file' : 'files'}`);
    if (s.lastSync) parts.push(`last sync: ${fullTime(s.lastSync)}`);
    if (s.error) parts.push(`<span class="err">Error: ${esc(s.error)}</span>`);
    for (const r of s.repos) if (r.error) parts.push(`<span class="err" title="${esc(r.error)}">${esc(r.id)}: error</span>`);
    $('#status').innerHTML = parts.join(' · ');
    $('#status').title = s.repos.map((r) => `${r.id}: ${r.url} (${r.branch}${r.docsPath ? `, /${r.docsPath}` : ''})`
      + `${r.head ? ` @ ${r.head.commit}` : ' – not downloaded yet'}`).join('\n');
  }

  async function loadAll() {
    [status, files] = await Promise.all([api('/api/status'), api('/api/files')]);
    pruneRepoFilter();
    renderStatus();
    renderRepoFilter();
    renderView();
    const empty = $('#empty');
    empty.hidden = files.length > 0;
    empty.innerHTML = repoList().length
      ? 'No content downloaded yet. Click <b>⟳ Sync</b> to download the repositories.'
      : 'No repositories yet. Add one with the <b>⚙ Repos</b> button.';
  }

  // ---------- Szűrő: repók (több is kiválasztható; üres = mind) ----------

  let repoFilter = (() => {
    try { const v = JSON.parse(localStorage.getItem('repoFilter')); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  })();
  const saveRepoFilter = () => localStorage.setItem('repoFilter', JSON.stringify([...repoFilter]));
  // nincs kiválasztva egy sem, vagy mind ki van választva = nincs szűrés
  const repoFilterActive = () => repoFilter.size > 0 && repoFilter.size < repoList().length;
  const inRepoFilter = (f) => !repoFilterActive() || repoFilter.has(f.repo);
  /** A repó-szűrőnek megfelelő fájlok (a fa, a módosított lista és a számláló ezekből dolgozik). */
  const visibleFiles = () => files.filter(inRepoFilter);

  /** Már nem létező repók kivétele a szűrőből. */
  function pruneRepoFilter() {
    const ids = new Set(repoList().map((r) => r.id));
    const before = repoFilter.size;
    repoFilter = new Set([...repoFilter].filter((id) => ids.has(id)));
    if (repoFilter.size !== before) saveRepoFilter();
  }

  function renderRepoFilter() {
    const list = repoList();
    const btn = $('#repo-filter');
    btn.hidden = list.length < 2;
    btn.classList.toggle('active', repoFilterActive());
    $('#repo-filter-label').textContent = repoFilterActive()
      ? (repoFilter.size === 1 ? [...repoFilter][0] : `${repoFilter.size} / ${list.length}`) : 'all';
    $('#repo-menu-list').innerHTML = list.map((r) => `
      <label class="repo-opt" title="${esc(r.url)}">
        <input type="checkbox" value="${esc(r.id)}" ${repoFilter.has(r.id) ? 'checked' : ''}>
        <span class="repo-id">${esc(r.id)}</span>
        <span class="muted">${esc(r.path)}</span>
        <span class="count">${r.fileCount}</span>
      </label>`).join('');
  }

  $('#repo-filter').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#repo-menu').hidden = !$('#repo-menu').hidden;
  });
  $('#repo-menu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { $('#repo-menu').hidden = true; });
  $('#repo-menu-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) repoFilter.add(cb.value);
    else repoFilter.delete(cb.value);
    saveRepoFilter();
    renderRepoFilter();
    renderView();
  });
  $('#repo-menu-all').addEventListener('click', () => {
    repoFilter.clear();
    saveRepoFilter();
    renderRepoFilter();
    renderView();
  });

  // ---------- Szűrő: módosított / új fájlok ----------

  let filterChanged = false;
  const isChanged = (f) => Boolean(f.editBranch);

  const prButton = (f) => f.prUrl
    ? `<a class="btn sm pr-link" href="${esc(f.prUrl)}" target="_blank" rel="noopener" title="Pull request: ${esc(f.editBranch)} → ${esc(baseOf(f))}">↗ Pull request</a>`
    : '';

  const badgeOf = (f) => f.isNew
    ? '<span class="badge new">new</span>'
    : f.isDeleted ? '<span class="badge del">🗑 deleted</span>'
      : f.editBranch ? '<span class="badge">✎ modified</span>' : '';

  // ---------- Fájl metaadatok: utolsó módosítás, commit hash, szerkesztés gomb ----------

  // A felület angol; a dátumok brit formátumban (nap/hónap/év, 24 órás)
  const LOCALE = 'en-GB';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function relTime(iso) {
    const sec = (new Date(iso) - Date.now()) / 1000;
    const abs = Math.abs(sec);
    if (abs < 60) return 'now';
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    return new Date(iso).toLocaleDateString(LOCALE);
  }
  const fullTime = (iso) => new Date(iso).toLocaleString(LOCALE);

  function commitTip(c, label) {
    return `${label}: ${fullTime(c.date)}\n${c.hash.slice(0, 10)} · ${c.author}\n${c.subject}`;
  }

  function hashLink(c, repo, cls = '') {
    const short = esc(c.hash.slice(0, 7));
    const tpl = repoInfo(repo)?.commitUrl;
    const url = tpl ? tpl.replace('{hash}', c.hash) : '';
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
    if (f.branchCommit) tip += commitTip(f.branchCommit, `Last save (${f.editBranch})`);
    if (f.commit) tip += `${tip ? '\n\n' : ''}${commitTip(f.commit, `Last change (${baseOf(f)})`)}`;
    return `<span class="fmeta">
      ${c ? `<span class="fdate${onBranch ? ' on-branch' : ''}" title="${esc(tip)}">${onBranch ? '✎ ' : ''}${esc(relTime(c.date))}</span>${hashLink(c, f.repo, onBranch ? 'on-branch' : '')}`
        : '<span class="fdate muted">—</span><span class="fhash"></span>'}
      <button type="button" class="fedit" data-path="${esc(f.path)}" title="Edit"${f.isDeleted ? ' style="visibility:hidden"' : ''}>✎</button>
    </span>`;
  }
  const fileByPath = (p) => files.find((f) => f.path === p);

  // módosított fájlnál jelezzük, ha a keresett szöveg csak az egyik verzióban van
  function foundNote(r) {
    if (!r.editBranch || r.isNew || !r.foundIn || r.foundIn === 'both') return '';
    return r.foundIn === 'branch'
      ? '<span class="found-note">only in the modified version</span>'
      : `<span class="found-note">only in the ${esc(baseOf(r))} version</span>`;
  }

  function renderChanged() {
    const list = visibleFiles().filter(isChanged).sort((a, b) => a.docPath.localeCompare(b.docPath));
    $('#changed').innerHTML = list.length
      ? list.map((f) => `
        <div class="crow" data-path="${esc(f.path)}">
          <div class="cmain">
            <div class="rhead"><span class="fname">${esc(f.title)}</span>${badgeOf(f)}</div>
            <div class="rpath">${esc(f.docPath)} · <span class="branch">${esc(f.editBranch)}</span></div>
          </div>
          ${prButton(f)}${fileMeta(f)}
        </div>`).join('')
      : '<div class="rcount">No modified or new files.</div>';
  }

  function renderView() {
    const n = visibleFiles().filter(isChanged).length;
    $('#filter-count').textContent = n;
    $('#filter-changed').classList.toggle('active', filterChanged);
    const searching = searchActive();
    renderTree();
    if (filterChanged) renderChanged();
    $('#tree').hidden = searching || filterChanged;
    $('#clear-filters').hidden = !searching && !filterChanged && !repoFilterActive();
    const hasDirs = visibleFiles().length > 0;
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
    for (const f of visibleFiles()) {
      const parts = f.docPath.split('/');
      let node = root;
      for (const d of parts.slice(0, -1)) node = node.dirs[d] ||= { dirs: {}, files: [] };
      node.files.push(f);
    }
    return root;
  }

  function fileItem(f) {
    const badge = f.isNew
      ? `<span class="badge new" title="New file, exists only on the ${esc(f.editBranch || '')} branch">new</span>`
      : f.isDeleted ? `<span class="badge del" title="Marked for deletion on the ${esc(f.editBranch)} branch">deleted</span>`
        : f.editBranch ? `<span class="badge" title="Edit branch: ${esc(f.editBranch)}">✎</span>` : '';
    return `<li class="frow"><a href="#" class="file${f.isDeleted ? ' deleted' : ''}" data-path="${esc(f.path)}" title="${esc(f.docPath)}">
      <span class="fname">${esc(f.name)}</span>${f.title && f.title !== f.name.replace(/\.md$/i, '') ? `<span class="ftitle">${esc(f.title)}</span>` : ''}${badge}</a>${fileMeta(f)}</li>`;
  }

  // Kibontott könyvtárak (localStorage); null = alapértelmezés (a repók és a bennük lévő legfelső szint nyitva)
  let openDirs = (() => {
    try { const v = JSON.parse(localStorage.getItem('openDirs2')); return Array.isArray(v) ? new Set(v) : null; } catch { return null; }
  })();
  // 'openDirs2': a repó-szintű fa kulcsai (<repó>/<könyvtár>); a régi 'openDirs' kulcsai már nem érvényesek
  const saveOpenDirs = () => localStorage.setItem('openDirs2', JSON.stringify([...openDirs]));
  // A repók (legfelső szint) fordítva: az összecsukottakat jegyezzük meg → egy újonnan felvett repó nyitva jelenik meg
  let closedRepos = (() => {
    try { const v = JSON.parse(localStorage.getItem('closedRepos')); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  })();
  const saveClosedRepos = () => localStorage.setItem('closedRepos', JSON.stringify([...closedRepos]));

  function renderNode(node, depth, prefix = '') {
    const dirs = Object.keys(node.dirs).sort((a, b) => collator.compare(a, b));
    const fs = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    let html = '<ul>';
    for (const d of dirs) {
      const key = prefix + d;
      const open = depth === 0 ? !closedRepos.has(key) : openDirs ? openDirs.has(key) : depth < 2;
      const repo = depth === 0 ? repoInfo(d) : null;
      const summary = repo
        ? `<span class="repo-node" title="${esc(repo.url)} · ${esc(repo.branch)}${repo.docsPath ? ` · /${esc(repo.docsPath)}` : ''}">📦 ${esc(d)}</span>`
          + `<span class="muted repo-path">${esc(repo.path)}</span>${repo.error ? '<span class="badge del" title="' + esc(repo.error) + '">error</span>' : ''}`
        : `📁 ${esc(d)}`;
      html += `<li><details data-dir="${esc(key)}"${depth === 0 ? ' data-repo' : ''} ${open ? 'open' : ''}><summary>${summary}</summary>${renderNode(node.dirs[d], depth + 1, key + '/')}</details></li>`;
    }
    html += fs.map(fileItem).join('');
    return html + '</ul>';
  }

  function renderTree() {
    $('#tree').innerHTML = files.length ? renderNode(buildTree(), 0) : '';
    if (files.length && !visibleFiles().length) $('#tree').innerHTML = '<div class="rcount">There are no files in the selected repositories.</div>';
  }

  // a 'toggle' esemény nem buborékol → capture
  $('#tree').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('details[data-dir]')) return;
    if (d.hasAttribute('data-repo')) {
      if (d.open) closedRepos.delete(d.dataset.dir);
      else closedRepos.add(d.dataset.dir);
      saveClosedRepos();
      return;
    }
    if (!openDirs) openDirs = new Set([...$('#tree').querySelectorAll('details[open]')].map((x) => x.dataset.dir));
    if (d.open) openDirs.add(d.dataset.dir);
    else openDirs.delete(d.dataset.dir);
    saveOpenDirs();
  }, true);

  function setAllDirs(open) {
    const all = [...$('#tree').querySelectorAll('details[data-dir]')];
    openDirs = new Set(open ? all.map((d) => d.dataset.dir) : []);
    closedRepos = new Set(open ? [] : all.filter((d) => d.hasAttribute('data-repo')).map((d) => d.dataset.dir));
    saveOpenDirs();
    saveClosedRepos();
    for (const d of all) d.open = open;
  }
  $('#expand-all').addEventListener('click', () => setAllDirs(true));
  $('#collapse-all').addEventListener('click', () => setAllDirs(false));

  $('#clear-filters').addEventListener('click', () => {
    $('#search-name').value = '';
    $('#search-content').value = '';
    filterChanged = false;
    repoFilter.clear();
    saveRepoFilter();
    renderRepoFilter();
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
    const repos = repoFilterActive() ? `&repos=${encodeURIComponent([...repoFilter].join(','))}` : '';
    let results = await api(`/api/search?name=${encodeURIComponent(name)}&q=${encodeURIComponent(q)}${repos}`).catch((e) => (toast(esc(e.message), 'error'), []));
    if (seq !== searchSeq) return;
    if (filterChanged) results = results.filter(isChanged);
    $('#tree').hidden = true;
    $('#changed').hidden = true;
    $('#results').hidden = false;
    const scope = [
      name && `file name: “${esc(name)}”`,
      q && `content: “${esc(q)}”`,
      filterChanged && 'modified / new only',
      repoFilterActive() && `repo: ${[...repoFilter].map(esc).join(', ')}`,
    ].filter(Boolean).join(' · ');
    $('#results').innerHTML = results.length
      ? `<div class="rcount">${results[0].approximate
        ? `No exact match — ${results.length} similar ${results.length === 1 ? 'result' : 'results'} (typo-tolerant)`
        : `${results.length} ${results.length === 1 ? 'result' : 'results'}`} — ${scope}</div>` + results.map((r) => `
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
      : `<div class="rcount">No results — ${scope}.</div>`;
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
    btn.textContent = running ? '⟳ Syncing…' : '⟳ Sync ▾';
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
    setSyncState('running', 'running');
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
      setSyncState('done', 'ok');
      toast(`Sync done: ${status.totalFiles} ${status.totalFiles === 1 ? 'file' : 'files'}`, 'success');
      autoClose = setTimeout(closeSyncDialog, 2500);
    } else {
      setSyncState('error', 'error');
      openSyncDialog();
      toast(`Sync error: ${esc(last.error || '')}`, 'error', 8000);
    }
  }

  /** Sync indítása (ids: csak ezek a repók; alapértelmezés: mind) és a napló követése. */
  async function startSyncFor(ids) {
    openSyncDialog();
    if (following) return; // már fut → csak megmutatjuk a naplót
    $('.progress', dlg).classList.remove('error');
    try {
      await api('/api/sync', { method: 'POST', body: JSON.stringify(ids ? { repos: ids } : {}) });
    } catch (e) {
      if (e.status !== 409) {
        setSyncState('error', 'error');
        $('.sync-log', dlg).textContent = e.message;
        return;
      }
    }
    followSync();
  }

  // Sync gomb: lenyíló („All repositories” + repónként); futó sync alatt csak a naplót nyitja meg.
  const syncMenu = $('#sync-menu');
  function renderSyncMenu() {
    syncMenu.innerHTML = `<button class="repo-opt sync-opt all" data-repo="">⟳ All repositories</button>`
      + repoList().map((r) => `
      <button class="repo-opt sync-opt" data-repo="${esc(r.id)}" title="${esc(r.url || r.path)}">
        <span class="repo-id">${esc(r.id)}</span>
        <span class="muted">${esc(r.path)}${r.docsPath ? ` /${esc(r.docsPath)}` : ''}</span>
        ${r.error ? `<span class="err" title="${esc(r.error)}">error</span>`
          : `<span class="muted sync-when">${r.lastSync ? esc(relTime(r.lastSync)) : 'never'}</span>`}
      </button>`).join('');
  }
  $('#sync').addEventListener('click', (e) => {
    e.stopPropagation();
    if (following || !repoList().length) { syncMenu.hidden = true; startSyncFor(null); return; }
    if (syncMenu.hidden) renderSyncMenu();
    syncMenu.hidden = !syncMenu.hidden;
  });
  syncMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('.sync-opt');
    if (!opt) return;
    syncMenu.hidden = true;
    startSyncFor(opt.dataset.repo ? [opt.dataset.repo] : null);
  });
  document.addEventListener('click', () => { syncMenu.hidden = true; });

  // ---------- Repók kezelése ----------

  const repoDlg = $('#repo-dialog');
  const repoForm = $('.repo-form', repoDlg);
  let editingRepo = null; // szerkesztett repó azonosítója (null = új felvétele)

  function renderRepoTable() {
    const list = repoList();
    $('.repo-server', repoDlg).textContent = status?.server || 'GIT_URL is not set';
    $('.repo-url-prefix', repoForm).textContent = `${status?.server || ''}/`;
    $('tbody', repoDlg).innerHTML = list.length ? list.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td><b>${esc(r.id)}</b></td>
        <td><code title="${esc(r.url)}">${esc(r.path)}</code></td>
        <td><code>${esc(r.branch)}</code></td>
        <td><code>/${esc(r.docsPath)}</code></td>
        <td><code>/${esc(r.assetsPath)}</code></td>
        <td>${r.error ? `<span class="err" title="${esc(r.error)}">error</span>`
          : r.head ? `${r.fileCount} ${r.fileCount === 1 ? 'file' : 'files'} · <code>${esc(r.head.commit)}</code>` : '<span class="muted">not downloaded</span>'}</td>
        <td class="actions">
          <button type="button" class="btn sm repo-sync" title="Download / update this repository only">⟳</button>
          <button type="button" class="btn sm repo-edit" title="Edit settings">✎</button>
          <button type="button" class="btn sm danger repo-remove" title="Remove from the app">🗑</button>
        </td>
      </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No repositories yet.</td></tr>';
  }

  function resetRepoForm() {
    editingRepo = null;
    repoForm.reset();
    repoForm.elements.branch.value = status?.defaultBranch || 'main';
    repoForm.elements.path.disabled = false;
    repoForm.elements.id.disabled = false;
    $('.repo-form-title', repoForm).textContent = 'Add a repository';
    $('.repo-submit', repoForm).textContent = '＋ Add and download';
    $('.repo-cancel', repoForm).hidden = true;
  }

  function openRepoDialog() {
    renderRepoTable();
    resetRepoForm();
    repoDlg.hidden = false;
    repoForm.elements.path.focus();
  }
  const closeRepoDialog = () => { repoDlg.hidden = true; };
  $('#manage-repos').addEventListener('click', openRepoDialog);
  $('.repo-close', repoDlg).addEventListener('click', closeRepoDialog);
  $('.sync-backdrop', repoDlg).addEventListener('click', closeRepoDialog);
  $('.repo-cancel', repoForm).addEventListener('click', resetRepoForm);

  // azonosító javaslat a repó útvonalából (ugyanaz a szabály, mint a szerveren)
  repoForm.elements.path.addEventListener('input', () => {
    const last = repoForm.elements.path.value.trim().replace(/\/+$/, '').split('/').pop() || '';
    repoForm.elements.id.placeholder = last.replace(/\.git$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40) || 'automatikus';
  });

  $('tbody', repoDlg).addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const r = repoInfo(row.dataset.id);
    if (!r) return;
    if (e.target.closest('.repo-edit')) {
      editingRepo = r.id;
      const f = repoForm.elements;
      f.path.value = r.path;
      f.id.value = r.id;
      f.branch.value = r.branch;
      f.docsPath.value = r.docsPath;
      f.assetsPath.value = r.assetsPath;
      f.path.disabled = true;
      f.id.disabled = true;
      $('.repo-form-title', repoForm).textContent = `Edit “${r.id}”`;
      $('.repo-submit', repoForm).textContent = '💾 Save and reload';
      $('.repo-cancel', repoForm).hidden = false;
      f.branch.focus();
    } else if (e.target.closest('.repo-remove')) {
      if (!confirm(`Remove the “${r.id}” repository from the app?\n\nThe local copy and any unsaved image uploads will be deleted. Nothing changes on the git server (edit branches are kept as well); the repository can be added again later.`)) return;
      try {
        await api(`/api/repos/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        toast(`Repository removed: <b>${esc(r.id)}</b>`, 'success');
        await loadAll();
        renderRepoTable();
        if (editingRepo === r.id) resetRepoForm();
      } catch (err) {
        toast(`Error: ${esc(err.message)}`, 'error', 8000);
      }
    } else if (e.target.closest('.repo-sync')) {
      closeRepoDialog();
      startSyncFor([r.id]);
    }
  });

  repoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = repoForm.elements;
    const body = { path: f.path.value, id: f.id.value, branch: f.branch.value, docsPath: f.docsPath.value, assetsPath: f.assetsPath.value };
    const btn = $('.repo-submit', repoForm);
    btn.disabled = true;
    try {
      const r = editingRepo
        ? await api(`/api/repos/${encodeURIComponent(editingRepo)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/repos', { method: 'POST', body: JSON.stringify(body) });
      toast(`${editingRepo ? 'Repository updated' : 'Repository added'}: <b>${esc(r.repo.id)}</b> — downloading…`, 'success');
      await loadAll();
      renderRepoTable();
      resetRepoForm();
      closeRepoDialog();
      openSyncDialog();
      followSync();
    } catch (err) {
      toast(`Error: ${esc(err.message)}`, 'error', 8000);
    } finally {
      btn.disabled = false;
    }
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
      if (this.creating) this.initCreate(opts.dir || '', opts.repo);
      else this.load(opts.source).then(() => { if (opts.edit && this.data?.content !== undefined) this.startEdit(); });
    }

    initCreate(dir, repoId) {
      this.q('.title').textContent = 'New file';
      this.q('.edit').hidden = true;
      const wrap = this.q('.new-path');
      wrap.hidden = false;
      const input = this.q('.new-path-input');
      input.value = dir ? `${dir}/` : '';
      const sel = this.q('.new-path-repo');
      const list = repoList().filter((r) => r.head);
      sel.innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('');
      sel.hidden = list.length < 2;
      sel.value = list.some((r) => r.id === repoId) ? repoId : list[0].id;
      const dl = this.q('.new-path-dirs');
      dl.id = `dirs-${Date.now()}`;
      input.setAttribute('list', dl.id);
      const update = () => {
        const repo = sel.value;
        const docsPath = repoInfo(repo)?.docsPath || '';
        this.q('.new-path-prefix').textContent = `/${docsPath ? `${docsPath}/` : ''}`;
        this.q('.path').textContent = `${repo}/${docsPath ? `${docsPath}/` : ''}${input.value || '…'}`;
        // könyvtár javaslatok a kiválasztott repóból (a repó azonosító nélkül)
        const dirs = [...new Set(files.filter((f) => f.repo === repo).flatMap((f) => {
          const parts = f.docPath.split('/').slice(1, -1);
          return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
        }))].sort();
        dl.innerHTML = dirs.map((d) => `<option value="${esc(d)}">`).join('');
      };
      update();
      input.addEventListener('input', update);
      sel.addEventListener('change', () => {
        localStorage.setItem('newFileRepo', sel.value);
        update();
      });
      this.data = { content: '# New document\n\n' };
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
      const fmt = (iso) => new Date(iso).toLocaleString(LOCALE, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const opt = (c, i) => {
        const subj = c.subject.length > 60 ? `${c.subject.slice(0, 57)}…` : c.subject;
        // a csoport legfrissebb commitja = a branch / alap aktuális változata
        return `<option value="${esc(c.hash)}" title="${esc(`${c.hash.slice(0, 10)} · ${c.author}\n${c.subject}`)}">${c.onBranch ? '✎ ' : ''}${esc(fmt(c.date))} · ${esc(c.hash.slice(0, 7))} · ${esc(subj)}${i === 0 ? ' (current)' : ''}</option>`;
      };
      const branch = list.filter((c) => c.onBranch);
      const base = list.filter((c) => !c.onBranch);
      sel.innerHTML = `<option value="">🕘 History (${list.length})</option>`
        + (branch.length ? `<optgroup label="Edit branch (${esc(d.editBranch || '')})">${branch.map(opt).join('')}</optgroup>` : '')
        + (base.length ? `<optgroup label="${esc(d.baseBranch || 'base')}">${base.map(opt).join('')}</optgroup>` : '');
      sel.value = d.rev && list.some((c) => c.hash === d.rev) ? d.rev : '';
      sel.classList.toggle('active', Boolean(d.rev));
    }

    renderRevBanner() {
      const d = this.data;
      const banner = this.q('.rev-banner');
      banner.hidden = !d?.rev;
      if (!d?.rev) return;
      const c = (this.history || []).find((x) => x.hash === d.rev);
      this.q('.rev-info').innerHTML = `🕘 Earlier version: <code>${esc(d.rev.slice(0, 7))}</code>`
        + (c ? ` · ${esc(fullTime(c.date))} · ${esc(c.author)} — “${esc(c.subject)}”` : '')
        + (c?.onBranch ? ' <span class="badge">✎ branch</span>' : '');
    }

    // ---------- Diff nézet ----------

    async loadDiff(rev) {
      let r;
      try {
        const q = `/api/diff?path=${encodeURIComponent(this.path)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`;
        [r] = await Promise.all([api(q), loadDiff2Html()]);
      } catch (e) {
        toast(`Diff error: ${esc(e.message)}`, 'error');
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
        ? `<code>${esc(rev.slice(0, 7))}</code> → <code class="${r.onBranch ? 'branch' : ''}">current (${esc(r.target)})</code> ${stat}`
        : `<code>${esc(r.baseBranch)}</code> ← <code class="branch">${esc(r.branch)}</code> ${stat}`;
      this.q('.diff-commits').innerHTML = r.commits.length
        ? `<details><summary>${r.commits.length} ${r.commits.length === 1 ? 'commit' : 'commits'} ${rev ? 'since then' : 'on the branch'}</summary><ul>${r.commits.map((c) =>
          `<li><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">— ${esc(c.author)}, ${esc(fullTime(c.date))}</span></li>`).join('')}</ul></details>`
        : '';
      this.renderDiff();
    }

    renderDiff() {
      const fmt = localStorage.getItem('diffFormat') || 'side-by-side';
      this.q('.diff-format').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
      const body = this.q('.diff-body');
      if (!this.diffData.diff.trim()) {
        body.innerHTML = `<p class="muted diff-empty">No differences compared to the ${this.diffRev ? 'current version' : 'base branch'}.</p>`;
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
        ? '\n\nThe PR will contain the deletion instead of the changes on the branch (earlier commits remain on the branch).' : '';
      if (!confirm(`Delete “${d.path}”?\n\nThe deletion will be a commit on the file's own branch; the file is removed from ${d.baseBranch} when the pull request is merged. Until then it can be undone with “↺ Discard”.${pending}`)) return;
      const btn = this.q('.delete');
      btn.disabled = true;
      try {
        const r = await api(`/api/file?path=${encodeURIComponent(this.path)}`, { method: 'DELETE' });
        const link = r.prUrl ? ` · <a href="${esc(r.prUrl)}" target="_blank" rel="noopener">Open PR ↗</a>` : '';
        toast(`Marked for deletion: <code>${esc(r.branch)}</code> (${esc(r.commit)})${link}`, 'success', 8000);
        files = await api('/api/files');
        renderView();
        this.history = null;
        await this.load('base');
      } catch (e) {
        toast(`Delete error: ${esc(e.message)}`, 'error', 10000);
      } finally {
        btn.disabled = false;
      }
    }

    async discard() {
      const d = this.data;
      const what = d.isNew
        ? `The new file (${d.path}) is not on the base branch yet, so deleting the branch also deletes the file.`
        : d.isDeleted
          ? 'The deletion is undone, the file is kept.'
          : `The changes will be lost; the file reverts to the base (${d.baseBranch}) version.`;
      if (!confirm(`Discard the “${d.editBranch}” branch?\n\n${what}\n\nThis cannot be undone.`)) return;
      try {
        const r = await api(`/api/branch?path=${encodeURIComponent(this.path)}`, { method: 'DELETE' });
        toast(`Branch eldobva: <code>${esc(r.branch)}</code>`, 'success');
        files = await api('/api/files');
        renderView();
        this.history = null;
        if (r.removed) this.close(true);
        else await this.load('base');
      } catch (e) {
        toast(`Discard error: ${esc(e.message)}`, 'error', 10000);
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
        toast('This file is marked for deletion. Undo the deletion (↺ Discard) before editing.', 'info', 6000);
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
          frontMatter: true, // a fájl eleji YAML metaadat-blokk (--- ... ---) érintetlen marad
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
            // Relatív, nem markdown hivatkozás (pl. csatolt fájl) → /assets, új lapon (mint a nézetben)
            link: (node, { entering, origin }) => {
              const tok = origin();
              const href = node.destination || '';
              if (entering && href && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href) && !/\.(md|markdown)(#|$)/i.test(href)) {
                tok.attributes = { ...tok.attributes, href: resolveAssetUrl(this.docPath(), href), target: '_blank' };
              }
              return tok;
            },
          },
        });
        this.addTableFormatButton();
        // Az emoji gomb utolsóként: utána beszúrt eszköztár elem újrarajzolná, és elveszne a kattintás-kezelője
        this.addAttachButton();
        this.addEmojiButton();
        // Módváltáskor a Toast UI a teljes dokumentumot egy visszavonható lépéssel cseréli le; Ctrl+Z-re ez
        // visszaállna a másik mód elavult állapotára (WYSIWYG → Markdown után elvesznének a WYSIWYG
        // módosítások, Markdown → WYSIWYG után üres lenne a dokumentum) → az előzmény a váltásnál indul.
        this.editor.on('changeMode', () => resetEditorHistory(this.editor));
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
        tooltip: 'Format tables (align columns in the whole document)',
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
      this.editor.insertToolbarItem({ groupIndex: 3, itemIndex: 5 }, {
        name: 'emoji',
        tooltip: 'Insert emoji',
        className: 'toastui-editor-toolbar-icons emoji-btn',
        text: '😀',
        popup: { className: 'emoji-popup', body: picker.el, style: { width: 'auto' } },
      });
      // megnyitáskor: adat betöltése (első alkalommal) és fókusz a keresőbe
      this.q('.emoji-btn')?.addEventListener('click', () => setTimeout(() => picker.open(), 0));
    }

    /** „📎 Attach file” gomb + nem kép fájlok behúzása / beillesztése: feltöltés az assets könyvtárba, link beszúrása. */
    addAttachButton() {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.hidden = true;
      input.className = 'attach-input';
      this.q('.editor').after(input);
      input.addEventListener('change', () => {
        const list = [...input.files];
        input.value = '';
        this.attachFiles(list);
      });
      const run = () => { input.click(); return true; };
      this.editor.addCommand('markdown', 'attachFile', run);
      this.editor.addCommand('wysiwyg', 'attachFile', run);
      this.editor.insertToolbarItem({ groupIndex: 3, itemIndex: 3 }, {
        name: 'attachFile',
        tooltip: 'Attach file (uploaded to the assets folder, committed on save)',
        className: 'toastui-editor-toolbar-icons attach-btn',
        text: '📎',
        command: 'attachFile',
      });
      // A képeket a Toast UI kezeli (addImageBlobHook); ha nem kép fájl is van köztük, mindet mi töltjük fel
      const isImage = (f) => /^image\//.test(f.type);
      const takeOver = (e, files) => {
        if (!files.length || files.every(isImage)) return;
        e.preventDefault();
        e.stopPropagation();
        this.attachFiles(files);
      };
      const root = this.q('.editor');
      root.addEventListener('drop', (e) => takeOver(e, [...(e.dataTransfer?.files || [])]), true);
      root.addEventListener('paste', (e) => takeOver(e, [...(e.clipboardData?.files || [])]), true);
    }

    async attachFiles(list) {
      for (const f of list) {
        const image = /^image\//.test(f.type);
        const r = await this.uploadFile(f, image ? 'image' : 'file');
        if (!r) continue;
        const text = f.name.replace(/[[\]]/g, '');
        if (image) this.editor.exec('addImage', { imageUrl: r.url, altText: text.replace(/\.[^.]+$/, '') });
        else this.editor.exec('addLink', { linkUrl: r.url, linkText: text || 'file' });
      }
      this.editor.focus();
    }

    formatTables() {
      const ed = this.editor;
      const before = ed.getMarkdown();
      const { text, count } = window.MdTable.formatTables(before);
      if (!count) return toast('There are no tables in the document.', 'info');
      if (text === before) return toast(`${count} ${count === 1 ? 'table' : 'tables'} — already formatted.`, 'info');
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
      toast(`${count} ${count === 1 ? 'table' : 'tables'} formatted.`, 'success');
    }

    /** A szerkesztett dokumentum virtuális útvonala (<repó>/<útvonal>; új fájlnál a beírt útvonalból). */
    docPath() {
      if (!this.creating) return this.path;
      let p = this.q('.new-path-input').value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (!p || p.endsWith('/')) p += 'new.md';
      if (!/\.(md|markdown)$/i.test(p)) p += '.md';
      const repo = this.q('.new-path-repo').value;
      const docsPath = repoInfo(repo)?.docsPath || '';
      return `${repo}/${docsPath ? `${docsPath}/` : ''}${p}`;
    }

    async uploadImage(blob, callback) {
      const r = await this.uploadFile(blob, 'image');
      if (r) callback(r.url, r.name.replace(/\.[^.]+$/, ''));
    }

    /** Feltöltés az assets könyvtárba (kind: image | file) → { path, url, name } vagy null (hiba: toast). */
    async uploadFile(blob, kind) {
      const name = blob.name || (kind === 'image'
        ? `image.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}` : 'file');
      const label = kind === 'image' ? 'Image' : 'File';
      const doc = this.docPath();
      const t = toast(`Uploading ${label.toLowerCase()}: ${esc(name)}…`, 'info', 30000);
      try {
        const q = `doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(name)}${kind === 'file' ? '&kind=file' : ''}`;
        const res = await fetch(`/api/upload?${q}`, {
          method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
        });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r.error || (res.status === 413 ? 'File is too large (max. 20 MB).' : res.statusText));
        (this.uploads ||= []).push({ path: r.path, url: r.url, doc });
        t?.remove?.();
        toast(`${label} uploaded: <code>${esc(r.path)}</code> — it will be part of the commit when you save.`, 'success');
        return { ...r, name };
      } catch (e) {
        t?.remove?.();
        toast(`${label} upload error: ${esc(e.message)}`, 'error', 10000);
        return null;
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
      if (!force && (this.dirty() || (this.creating && this.q('.new-path-input').value.trim())) && !confirm('Discard unsaved changes?')) return false;
      this.setEditing(false);
      return true;
    }

    async save() {
      if (this.saving) return;
      this.saving = true;
      const btn = this.q('.save');
      btn.disabled = true;
      btn.textContent = '💾 Saving…';
      try {
        const md = this.editor.getMarkdown();
        const payload = { content: this.creating ? this.fixUploadLinks(md) : md, message: this.q('.commit-msg').value };
        const r = this.creating
          ? await api('/api/file', { method: 'POST', body: JSON.stringify({ ...payload, repo: this.q('.new-path-repo').value, path: this.q('.new-path-input').value }) })
          : await api('/api/file', { method: 'PUT', body: JSON.stringify({ ...payload, path: this.path }) });
        if (this.creating) {
          this.creating = false;
          this.path = r.path;
          this.q('.new-path').hidden = true;
          this.q('.edit').hidden = false;
        }
        if (r.unchanged) {
          toast('No changes, nothing was committed.', 'info');
        } else {
          const link = r.prUrl ? ` · <a href="${esc(r.prUrl)}" target="_blank" rel="noopener">Open PR ↗</a>` : '';
          toast(`Saved and pushed: <code>${esc(r.branch)}</code> (${esc(r.commit)})${link}`, 'success', 8000);
        }
        this.stopEdit(true);
        this.history = null; // új commit → előzmények újratöltése
        await this.load('branch');
        files = await api('/api/files');
        renderView();
      } catch (e) {
        toast(`Save error: ${esc(e.message)}`, 'error', 10000);
      } finally {
        this.saving = false;
        btn.disabled = false;
        btn.textContent = '💾 Save';
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
    if (!repoList().length) return toast('Add a repository first (⚙ Repos).', 'error');
    if (!repoList().some((r) => r.head)) return toast('Run Sync first.', 'error');
    // alapértelmezett repó: ha a szűrőben pontosan egy van kiválasztva, az; különben a legutóbb használt
    const repo = repoFilterActive() && repoFilter.size === 1 ? [...repoFilter][0] : localStorage.getItem('newFileRepo');
    openLayer(null, null, { create: true, repo });
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
    if (!ok) throw new Error('The browser did not allow copying to the clipboard.');
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
      btn.title = 'Copy to clipboard';
      btn.textContent = '⧉ Copy';
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code') || pre;
        try {
          await copyText(code.textContent.replace(/\n$/, ''));
          btn.textContent = '✓ Copied';
          btn.classList.add('done');
        } catch (e) {
          btn.textContent = '✕ Hiba';
          toast(esc(e.message), 'error');
        }
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.textContent = '⧉ Copy';
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
  /**
   * Markdown képhivatkozás → böngészőben megjeleníthető URL (relatív útvonal a dokumentumhoz képest).
   * docPath virtuális útvonal (<repó>/…): a "/" kezdetű hivatkozás a repó gyökeréhez képest értendő,
   * a repóból kivezető hivatkozás változatlan marad.
   */
  function resolveAssetUrl(docPath, src) {
    if (!src || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(src)) return src;
    let s = src.split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch { /* marad */ }
    const root = docPath.split('/')[0];
    const p = normalizePath(s.startsWith('/') ? `${root}/${s}` : `${dirOf(docPath)}/${s}`);
    return p === null || !p.startsWith(`${root}/`) ? src : '/assets/' + p.split('/').map(encodeURIComponent).join('/');
  }

  // ---------- Emoji választó ----------

  let emojiData = null;
  const loadEmojis = () => (emojiData ||= fetch('/vendor-built/emoji.json').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).catch((e) => { emojiData = null; throw e; }));

  const EMOJI_GROUPS = [
    [0, '😀', 'Smileys & emotion'], [1, '👋', 'People & body'], [3, '🐶', 'Animals & nature'],
    [4, '🍔', 'Food & drink'], [5, '✈️', 'Travel & places'], [6, '⚽', 'Activities'],
    [7, '💡', 'Objects'], [8, '❤️', 'Symbols'], [9, '🏁', 'Flags'],
  ];
  const RECENT_KEY = 'recentEmojis';
  const recentEmojis = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
  const normSearch = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /** Emoji választó (kereső + kategóriák + legutóbbiak). onPick(emoji, keepOpen) */
  function createEmojiPicker(onPick) {
    const el = document.createElement('div');
    el.className = 'emoji-picker';
    el.innerHTML = `
      <input class="emoji-search" type="search" placeholder="Search… (e.g. heart, check, rocket, tada)" autocomplete="off" spellcheck="false">
      <div class="emoji-tabs"><button type="button" data-tab="recent" title="Recently used">🕘</button>${EMOJI_GROUPS.map(([g, icon, name]) =>
        `<button type="button" data-tab="${g}" title="${esc(name)}">${icon}</button>`).join('')}</div>
      <div class="emoji-grid"><div class="emoji-loading">Loading…</div></div>
      <div class="emoji-foot"><span class="emoji-preview"></span><span class="emoji-name">Shift+click: insert several emojis</span></div>`;
    const search = el.querySelector('.emoji-search');
    const grid = el.querySelector('.emoji-grid');
    let data = null;
    const btn = (e) => `<button type="button" class="emoji" data-e="${esc(e[0])}" title="${esc(e[2])}">${e[0]}</button>`;
    const byEmoji = new Map();

    function renderAll() {
      const recent = recentEmojis().map((u) => byEmoji.get(u)).filter(Boolean);
      grid.innerHTML = (recent.length ? `<h4 data-sec="recent">Recently used</h4><div class="emoji-set">${recent.map(btn).join('')}</div>` : '')
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
        : '<div class="emoji-loading">No results.</div>';
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
          grid.innerHTML = `<div class="emoji-loading err">Failed to load: ${esc(err.message)}</div>`;
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
        th.title = 'Sort (click: ascending → descending → original)';
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
      s.onerror = () => { diff2htmlLoading = null; reject(new Error('Failed to load diff2html')); };
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
    // Normalizált szöveg, a szóközök (sortörés, több szóköz, nbsp) egy szóközzé vonva, hogy a több szavas
    // kifejezések is egyezzenek; map: a normalizált pozíció → eredeti pozíció
    const raw = normChars(text);
    let n = '';
    const map = [];
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (n.endsWith(' ')) continue;
        n += ' ';
      } else n += raw[i];
      map.push(i);
    }
    const ranges = [];
    for (const t of terms) for (const i of findAll(n, t)) ranges.push([map[i], map[i + t.length - 1] + 1]);
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
    if (e.key === 'Escape' && !syncMenu.hidden) {
      e.preventDefault();
      syncMenu.hidden = true;
    } else if (e.key === 'Escape' && !repoDlg.hidden) {
      e.preventDefault();
      closeRepoDialog();
    } else if (e.key === 'Escape' && layers.length) {
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

  // ---------- PWA: service worker ----------
  // Csak biztonságos környezetben (https vagy localhost) érhető el. Új verzió aktiválásakor (új build) szólunk,
  // de nem töltünk újra magától (elveszne a nem mentett szerkesztés).
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const el = toast('A new version of Markdown Manager is available. <button type="button" class="btn">⟳ Reload</button>', 'info', 30000);
      el.querySelector('button').addEventListener('click', () => location.reload());
    });
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed:', e));
  }

  applyTheme();
  loadAll()
    .then(() => { if (status?.syncing) followSync(); })
    .catch((e) => toast(esc(e.message), 'error'));
})();

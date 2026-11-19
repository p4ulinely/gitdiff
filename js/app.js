/* Interface do visualizador. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    pickBtn: $('pickBtn'), reopenBtn: $('reopenBtn'), dirInput: $('dirInput'),
    repoInfo: $('repoInfo'), repoName: $('repoName'), reloadBtn: $('reloadBtn'),
    branch: $('branchSelect'), hashForm: $('hashForm'), hashInput: $('hashInput'), hashBtn: $('hashBtn'),
    status: $('status'), viewToggle: $('viewToggle'),
    commitCount: $('commitCount'), commitFilter: $('commitFilter'), commitScroll: $('commitScroll'),
    commitList: $('commitList'), loadMore: $('loadMore'),
    fileCount: $('fileCount'), fileFilter: $('fileFilter'), fileModeToggle: $('fileModeToggle'), fileList: $('fileList'),
    diffPane: $('diffPane'), commitHeader: $('commitHeader'), diffs: $('diffs'), toast: $('toast'),
    supportNote: $('supportNote'),
  };

  const esc = Diff.escapeHtml;
  const td = new TextDecoder('utf-8');
  const EMPTY = new Uint8Array(0);
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const IMAGE_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  const STATUS_LABEL = { A: 'Adicionado', M: 'Modificado', D: 'Removido', R: 'Renomeado' };

  const LS = {
    get(k, d) {
      try { const v = localStorage.getItem('gitdiff:' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('gitdiff:' + k, JSON.stringify(v)); } catch { /* sem storage */ }
    },
  };

  const state = {
    repo: null,
    refs: new Map(),
    head: null,
    walker: null,
    commits: [],
    current: null,
    changes: [],
    gen: 0,
    view: LS.get('view', 'unified'),
    fileMode: LS.get('fileMode', 'list'),
    observer: null,
    loadingMore: false,
    activeFile: -1,
    urls: [],
  };

  /* ---------- utilitários ---------- */

  const short = (sha) => (sha ? sha.slice(0, 7) : '');
  const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const fmtDate = (sec) => dateFmt.format(new Date(sec * 1000));
  function relTime(sec) {
    const diff = sec - Date.now() / 1000, abs = Math.abs(diff);
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, s] of units) if (abs >= s) return rtf.format(Math.round(diff / s), u);
    return 'agora';
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function busy(msg) {
    el.status.innerHTML = msg ? `<span class="spinner"></span>${esc(msg)}` : '';
  }

  let toastTimer = 0;
  function toast(msg, kind = '') {
    el.toast.textContent = msg;
    el.toast.className = 'toast ' + kind;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), kind === 'error' ? 6000 : 2000);
  }

  const run = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(e);
      busy(null);
      toast(e && e.message ? e.message : String(e), 'error');
    }
  };

  /* ---------- IndexedDB: lembrar a última pasta ---------- */

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gitdiff', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', mode);
        const r = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const idbGet = (k) => idb('readonly', (s) => s.get(k));
  const idbSet = (k, v) => idb('readwrite', (s) => s.put(v, k));

  /* ---------- abrir repositório ---------- */

  async function pickFolder() {
    if (!window.showDirectoryPicker) {
      el.dirInput.click();
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'gitdiff', mode: 'read' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }
    await openFS(new GitFS.HandleFS(handle));
    idbSet('lastDir', handle).catch(() => {});
  }

  async function openFS(fs) {
    busy('Lendo repositório…');
    try {
      const repo = await Git.Repo.open(fs);
      state.repo = repo;
      el.repoName.textContent = fs.name;
      el.repoName.title = fs.name;
      el.repoInfo.hidden = false;
      el.reopenBtn.hidden = true;
      el.hashInput.disabled = el.hashBtn.disabled = false;
      await loadRefs();
    } finally {
      busy(null);
    }
  }

  async function reloadRepo() {
    if (!state.repo) return;
    const keep = el.branch.value;
    const current = state.current && state.current.sha;
    busy('Recarregando…');
    try {
      state.repo = await Git.Repo.open(state.repo.fs);
      await loadRefs(keep, current);
      toast('Repositório recarregado');
    } finally {
      busy(null);
    }
  }

  async function loadRefs(preferred, keepCommit) {
    const repo = state.repo;
    const [refs, head] = await Promise.all([repo.listRefs(), repo.readHead()]);
    state.refs = refs;
    state.head = head;

    const groups = [['Locais', 'refs/heads/'], ['Remotas', 'refs/remotes/'], ['Tags', 'refs/tags/'], ['Outras', 'refs/']];
    const buckets = groups.map(() => []);
    for (const name of [...refs.keys()].sort((a, b) => a.localeCompare(b))) {
      const g = groups.findIndex(([, p]) => name.startsWith(p));
      buckets[g].push([name, name.slice(groups[g][1].length)]);
    }

    let html = '';
    if (head.sha) html += `<option value="HEAD">HEAD destacado (${short(head.sha)})</option>`;
    groups.forEach(([label], g) => {
      if (!buckets[g].length) return;
      html += `<optgroup label="${label}">` +
        buckets[g].map(([v, t]) => `<option value="${esc(v)}">${esc(t)}${v === head.ref ? ' ●' : ''}</option>`).join('') +
        '</optgroup>';
    });
    el.branch.innerHTML = html;
    el.branch.disabled = !html;

    if (!html) {
      el.commitList.innerHTML = '<li class="list-empty">Este repositório ainda não tem commits.</li>';
      return;
    }
    const has = (v) => v && (v === 'HEAD' ? !!head.sha : refs.has(v));
    el.branch.value = has(preferred) ? preferred : has(head.ref) ? head.ref : el.branch.options[0].value;
    await loadBranch(keepCommit);
  }

  function refSha(value) {
    return value === 'HEAD' ? state.head.sha : state.refs.get(value);
  }

  async function loadBranch(keepCommit) {
    const tip = await state.repo.peelToCommit(refSha(el.branch.value));
    state.walker = new Git.LogWalker(state.repo, [tip]);
    state.commits = [];
    el.commitList.innerHTML = '';
    el.commitCount.textContent = '';
    busy('Carregando commits…');
    await loadMoreCommits();
    busy(null);
    const target = keepCommit || (state.commits[0] && state.commits[0].sha);
    if (target) await selectCommit(target);
  }

  /* ---------- lista de commits ---------- */

  async function loadMoreCommits() {
    const walker = state.walker;
    if (state.loadingMore || !walker || walker.done) return;
    state.loadingMore = true;
    try {
      const batch = await walker.next(100);
      if (walker !== state.walker) return;
      state.commits.push(...batch);
      appendCommits(batch);
      el.loadMore.hidden = walker.done;
      el.commitCount.textContent = state.commits.length + (walker.done ? '' : '+');
    } finally {
      state.loadingMore = false;
    }
  }

  function appendCommits(batch) {
    const q = el.commitFilter.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    for (const c of batch) {
      const subject = c.message.split('\n')[0].trim();
      const li = document.createElement('li');
      li.className = 'commit';
      li.dataset.sha = c.sha;
      li.dataset.search = (subject + ' ' + c.author.name + ' ' + c.author.email + ' ' + c.sha).toLowerCase();
      li.title = `${subject}\n\n${c.author.name} <${c.author.email}>\n${fmtDate(c.author.time)}\n${c.sha}`;
      li.innerHTML =
        `<div class="c-subject">${c.parents.length > 1 ? '<span class="tag-merge">merge</span>' : ''}${subject ? esc(subject) : '<em>(sem mensagem)</em>'}</div>` +
        `<div class="c-meta"><code>${short(c.sha)}</code><span class="c-author">${esc(c.author.name)}</span>` +
        `<time>${relTime(c.author.time)}</time></div>`;
      if (state.current && state.current.sha === c.sha) li.classList.add('active');
      if (q && !li.dataset.search.includes(q)) li.hidden = true;
      frag.appendChild(li);
    }
    el.commitList.appendChild(frag);
  }

  function filterCommits() {
    const q = el.commitFilter.value.trim().toLowerCase();
    for (const li of el.commitList.children) {
      if (li.dataset.search) li.hidden = !!q && !li.dataset.search.includes(q);
    }
  }

  function markActiveCommit(sha) {
    for (const li of el.commitList.querySelectorAll('.commit.active')) li.classList.remove('active');
    const li = el.commitList.querySelector(`.commit[data-sha="${sha}"]`);
    if (li) {
      li.classList.add('active');
      li.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------- seleção de commit ---------- */

  async function selectCommit(sha) {
    const gen = ++state.gen;
    markActiveCommit(sha);
    el.hashInput.value = sha;
    busy('Calculando diferenças…');
    try {
      const commit = await state.repo.readCommit(sha);
      const changes = await state.repo.diffCommit(commit);
      if (gen !== state.gen) return;
      state.current = commit;
      state.changes = changes;
      state.activeFile = -1;
      renderCommitHeader(commit);
      renderFiles();
      renderDiffs();
      el.diffPane.scrollTop = 0;
      computeAllStats(gen);
    } finally {
      if (gen === state.gen) busy(null);
    }
  }

  function renderCommitHeader(c) {
    const lines = c.message.replace(/\s+$/, '').split('\n');
    const subject = lines[0] || '(sem mensagem)';
    const body = lines.slice(1).join('\n').replace(/^\n+/, '');
    const a = c.author, cm = c.committer;
    const committerInfo = cm.name !== a.name || cm.email !== a.email
      ? `<span>commitado por <strong>${esc(cm.name)}</strong> · ${fmtDate(cm.time)}</span>` : '';
    const parents = c.parents.length
      ? `<span>${c.parents.length > 1 ? 'Pais' : 'Pai'}: ${c.parents.map((p, i) => `<a href="#" data-goto="${p}" title="${p}">${short(p)}</a>${c.parents.length > 1 && i === 0 ? ' (comparado)' : ''}`).join(' ')}</span>`
      : '<span>Commit inicial</span>';
    el.commitHeader.hidden = false;
    el.commitHeader.innerHTML = `
      <div class="ch-subject">${esc(subject)}</div>
      ${body ? `<pre class="ch-body">${esc(body)}</pre>` : ''}
      <div class="ch-meta">
        <span><strong>${esc(a.name)}</strong> &lt;${esc(a.email)}&gt; · <time title="${esc(a.tz)}">${fmtDate(a.time)}</time></span>
        ${committerInfo}
        <span class="ch-sha"><code>${c.sha}</code><button class="btn copy-btn" data-copy="${c.sha}">Copiar</button></span>
        ${parents}
        <span class="ch-stats" id="commitStats"></span>
      </div>`;
    updateTotals();
  }

  /* ---------- cálculo do diff de cada arquivo ---------- */

  const isGitlink = (m) => m === '160000';
  const isBinary = (bytes) => {
    const n = Math.min(bytes.length, 8000);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  };
  const extOf = (p) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');

  function computeFileDiff(ch) {
    if (!ch.promise) {
      ch.promise = doCompute(ch).catch((e) => {
        ch.promise = null;
        throw e;
      });
    }
    return ch.promise;
  }

  async function doCompute(ch) {
    if (isGitlink(ch.oldMode) || isGitlink(ch.newMode)) return (ch.diff = { kind: 'submodule' });
    const repo = state.repo;
    const [a, b] = await Promise.all([
      ch.oldSha ? repo.readBlob(ch.oldSha) : EMPTY,
      ch.newSha ? repo.readBlob(ch.newSha) : EMPTY,
    ]);
    if (isBinary(a) || isBinary(b)) {
      const type = IMAGE_TYPES[extOf(ch.path)];
      return (ch.diff = { kind: 'binary', oldSize: a.length, newSize: b.length, type, a: type ? a : null, b: type ? b : null });
    }
    if (!ch.force && a.length + b.length > MAX_TEXT_BYTES) {
      return (ch.diff = { kind: 'large', size: a.length + b.length });
    }
    const A = Diff.splitLines(td.decode(a)), B = Diff.splitLines(td.decode(b));
    // A ausência de \n final faz parte da comparação.
    const aKeys = A.lines.slice(), bKeys = B.lines.slice();
    if (A.noEol && aKeys.length) aKeys[aKeys.length - 1] += '\u0000';
    if (B.noEol && bKeys.length) bKeys[bKeys.length - 1] += '\u0000';
    const ops = Diff.diffLines(aKeys, bKeys);
    const hunks = Diff.buildHunks(ops, A.lines, B.lines, 3);
    let adds = 0, dels = 0;
    for (const o of ops) {
      if (o === 1) dels++;
      else if (o === 2) adds++;
    }
    return (ch.diff = {
      kind: 'text', hunks, adds, dels,
      oldCount: A.lines.length, newCount: B.lines.length,
      noEolOld: A.noEol, noEolNew: B.noEol,
    });
  }

  async function computeAllStats(gen) {
    for (let i = 0; i < state.changes.length; i++) {
      if (gen !== state.gen) return;
      try {
        await computeFileDiff(state.changes[i]);
      } catch {
        continue;
      }
      if (gen !== state.gen) return;
      updateFileStats(i);
      estimatePlaceholder(i);
      if (i % 8 === 7) await new Promise((r) => setTimeout(r));
    }
  }

  function statHTML(d) {
    if (!d) return '';
    if (d.kind === 'text') return `<span class="add">+${d.adds}</span> <span class="del">−${d.dels}</span>`;
    if (d.kind === 'binary') return '<span class="muted">bin</span>';
    if (d.kind === 'submodule') return '<span class="muted">sub</span>';
    return '';
  }

  function updateFileStats(i) {
    const html = statHTML(state.changes[i].diff);
    for (const n of document.querySelectorAll(`[data-stat="${i}"]`)) n.innerHTML = html;
    updateTotals();
  }

  function updateTotals() {
    const node = document.getElementById('commitStats');
    if (!node) return;
    const n = state.changes.length;
    let adds = 0, dels = 0, done = 0;
    for (const ch of state.changes) {
      if (!ch.diff) continue;
      done++;
      if (ch.diff.kind === 'text') { adds += ch.diff.adds; dels += ch.diff.dels; }
    }
    node.innerHTML = `${n} arquivo${n === 1 ? '' : 's'} · <span class="add">+${adds}</span> <span class="del">−${dels}</span>${done < n ? ' <span class="muted">…</span>' : ''}`;
  }

  function estimatePlaceholder(i) {
    const body = el.diffs.querySelector(`.file[data-index="${i}"] .file-body.placeholder`);
    const d = state.changes[i].diff;
    if (!body || !d || d.kind !== 'text') return;
    let rows = 0;
    for (const h of d.hunks) rows += h.lines.length + 1;
    body.style.minHeight = Math.max(60, rows * 20) + 'px';
  }

  /* ---------- lista de arquivos (lateral) ---------- */

  function fileItemHTML(ch, i, name, dir, depth) {
    const title = (ch.oldPath ? ch.oldPath + ' → ' : '') + ch.path + ' (' + STATUS_LABEL[ch.status] + ')';
    return `<li class="file-item${i === state.activeFile ? ' active' : ''}" data-index="${i}" style="--depth:${depth}" title="${esc(title)}">` +
      `<span class="badge s-${ch.status}">${ch.status}</span>` +
      `<span class="fi-text">${esc(name)}${dir ? `<span class="fi-dir">${esc(dir)}</span>` : ''}</span>` +
      `<span class="fi-stat" data-stat="${i}">${statHTML(ch.diff)}</span></li>`;
  }

  function listHTML(items) {
    return items.map(([ch, i]) => fileItemHTML(ch, i, basename(ch.path), dirname(ch.path), 0)).join('');
  }

  function treeHTML(items) {
    const root = { dirs: new Map(), files: [] };
    for (const [ch, i] of items) {
      const parts = ch.path.split('/');
      let node = root;
      for (let p = 0; p < parts.length - 1; p++) {
        let next = node.dirs.get(parts[p]);
        if (!next) node.dirs.set(parts[p], (next = { dirs: new Map(), files: [] }));
        node = next;
      }
      node.files.push([ch, i, parts[parts.length - 1]]);
    }
    const out = [];
    const walk = (node, depth) => {
      for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        let child = node.dirs.get(name), label = name;
        while (!child.files.length && child.dirs.size === 1) {
          const [n2, c2] = child.dirs.entries().next().value;
          label += '/' + n2;
          child = c2;
        }
        out.push(`<li class="dir-item" style="--depth:${depth}"><span class="caret">▾</span><span class="dir-name">${esc(label)}</span></li><li class="dir-children"><ul>`);
        walk(child, depth + 1);
        out.push('</ul></li>');
      }
      for (const [ch, i, name] of node.files) out.push(fileItemHTML(ch, i, name, '', depth));
    };
    walk(root, 0);
    return out.join('');
  }

  function renderFiles() {
    const q = el.fileFilter.value.trim().toLowerCase();
    const items = state.changes
      .map((ch, i) => [ch, i])
      .filter(([ch]) => !q || ch.path.toLowerCase().includes(q) || (ch.oldPath || '').toLowerCase().includes(q));
    el.fileCount.textContent = state.changes.length ? String(state.changes.length) : '';
    el.fileList.innerHTML = items.length
      ? (state.fileMode === 'tree' ? treeHTML(items) : listHTML(items))
      : `<li class="list-empty">${state.changes.length ? 'Nenhum arquivo corresponde ao filtro.' : 'Nenhum arquivo alterado.'}</li>`;
  }

  function setActiveFile(i) {
    if (i === state.activeFile) return;
    state.activeFile = i;
    for (const n of el.fileList.querySelectorAll('.file-item.active')) n.classList.remove('active');
    if (i < 0) return;
    const item = el.fileList.querySelector(`.file-item[data-index="${i}"]`);
    if (item) {
      item.classList.add('active');
      item.scrollIntoView({ block: 'nearest' });
    }
  }

  function jumpToFile(i) {
    const s = el.diffs.querySelector(`.file[data-index="${i}"]`);
    if (!s) return;
    s.classList.remove('collapsed');
    s.scrollIntoView({ block: 'start' });
    setActiveFile(i);
  }

  /* ---------- painel de diffs ---------- */

  function pathHTML(p) {
    const d = dirname(p);
    return (d ? `<span class="dim">${esc(d)}/</span>` : '') + esc(basename(p));
  }

  function renderDiffs() {
    if (state.observer) state.observer.disconnect();
    for (const u of state.urls) URL.revokeObjectURL(u);
    state.urls = [];
    el.diffs.innerHTML = '';
    if (!state.changes.length) {
      el.diffs.innerHTML = '<div class="notice">Nenhuma alteração de arquivo neste commit.</div>';
      return;
    }
    const gen = state.gen;
    const observer = (state.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          renderFileBody(+e.target.dataset.index, gen);
        }
      },
      { root: el.diffPane, rootMargin: '800px 0px' }
    ));
    const frag = document.createDocumentFragment();
    state.changes.forEach((ch, i) => {
      const s = document.createElement('section');
      s.className = 'file';
      s.dataset.index = i;
      const path = ch.oldPath ? `${pathHTML(ch.oldPath)} <span class="dim">→</span> ${pathHTML(ch.path)}` : pathHTML(ch.path);
      s.innerHTML =
        `<header class="file-head">` +
        `<button class="icon-btn fh-toggle" title="Recolher / expandir">▾</button>` +
        `<span class="badge s-${ch.status}" title="${STATUS_LABEL[ch.status]}">${ch.status}</span>` +
        `<span class="fh-path" title="${esc(ch.path)}">${path}</span>` +
        `<span class="fh-stat" data-stat="${i}">${statHTML(ch.diff)}</span>` +
        `<button class="icon-btn fh-copy" data-copy="${esc(ch.path)}" title="Copiar caminho">⧉</button>` +
        `</header><div class="file-body placeholder">Carregando…</div>`;
      frag.appendChild(s);
      observer.observe(s);
    });
    el.diffs.appendChild(frag);
    state.changes.forEach((_, i) => estimatePlaceholder(i));
  }

  async function renderFileBody(i, gen) {
    const ch = state.changes[i];
    const body = el.diffs.querySelector(`.file[data-index="${i}"] .file-body`);
    if (!body) return;
    try {
      await computeFileDiff(ch);
    } catch (e) {
      if (gen !== state.gen) return;
      body.className = 'file-body';
      body.innerHTML = `<div class="notice error">Erro ao ler o arquivo: ${esc(e.message)}</div>`;
      return;
    }
    if (gen !== state.gen) return;
    body.className = 'file-body';
    body.style.minHeight = '';
    body.innerHTML = diffBodyHTML(ch);
    if (ch.diff.kind === 'binary' && ch.diff.type) {
      for (const img of body.querySelectorAll('img[data-side]')) {
        const bytes = ch.diff[img.dataset.side];
        const url = URL.createObjectURL(new Blob([bytes], { type: ch.diff.type }));
        state.urls.push(url);
        img.src = url;
      }
    }
    updateFileStats(i);
  }

  function diffBodyHTML(ch) {
    const d = ch.diff;
    const notice = (html) => `<div class="notice">${html}</div>`;
    if (d.kind === 'submodule') {
      return notice(`Submódulo: <code>${short(ch.oldSha) || '—'}</code> → <code>${short(ch.newSha) || '—'}</code>`);
    }
    if (d.kind === 'large') {
      return notice(`Arquivo grande (${fmtSize(d.size)}). <button class="btn" data-force="1">Mostrar diff mesmo assim</button>`);
    }
    if (d.kind === 'binary') {
      if (d.type) {
        const fig = (side, cls, label, size) =>
          `<figure class="${cls}"><figcaption>${label} · ${fmtSize(size)}</figcaption><img data-side="${side}" alt="${label}"></figure>`;
        return '<div class="img-diff">' +
          (ch.oldSha ? fig('a', 'old', 'Antes', d.oldSize) : '') +
          (ch.newSha ? fig('b', 'new', 'Depois', d.newSize) : '') + '</div>';
      }
      return notice(`Arquivo binário${ch.oldSha && ch.newSha ? ` (${fmtSize(d.oldSize)} → ${fmtSize(d.newSize)})` : ` (${fmtSize(d.oldSize || d.newSize)})`}`);
    }
    const modeNote = ch.oldMode && ch.newMode && ch.oldMode !== ch.newMode
      ? notice(`Modo alterado: <code>${ch.oldMode}</code> → <code>${ch.newMode}</code>`) : '';
    if (!d.hunks.length) {
      return modeNote || notice(ch.status === 'R' ? 'Arquivo renomeado, sem alterações de conteúdo.' : 'Arquivo vazio.');
    }
    return modeNote + (state.view === 'split' ? splitHTML(d) : unifiedHTML(d));
  }

  function lineHTML(text, t) {
    if (text.endsWith('\r')) return esc(text.slice(0, -1)) + (t ? '<span class="cr" title="CR (\\r)">␍</span>' : '');
    return esc(text);
  }

  // Prepara o HTML de cada linha, com destaque de palavras entre pares removido/adicionado.
  function prepareHunk(h) {
    if (h.ready) return;
    h.ready = true;
    const L = h.lines;
    for (const l of L) l.html = lineHTML(l.text, l.t);
    for (let i = 0; i < L.length;) {
      if (L[i].t !== 1) { i++; continue; }
      let j = i;
      while (j < L.length && L[j].t === 1) j++;
      let k = j;
      while (k < L.length && L[k].t === 2) k++;
      const pairs = Math.min(j - i, k - j);
      for (let p = 0; p < pairs; p++) {
        const a = L[i + p], b = L[j + p];
        const r = Diff.intraline(a.text.replace(/\r$/, ''), b.text.replace(/\r$/, ''));
        if (r) {
          a.html = r[0] + (a.text.endsWith('\r') ? '<span class="cr">␍</span>' : '');
          b.html = r[1] + (b.text.endsWith('\r') ? '<span class="cr">␍</span>' : '');
        }
      }
      i = k;
    }
  }

  const CLS = ['ctx', 'del', 'add'];
  const SIGN = [' ', '-', '+'];
  const hunkLabel = (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  const EOL_TEXT = 'Sem quebra de linha no final do arquivo';

  function eolFlags(l, d) {
    return {
      a: l.t !== 2 && d.noEolOld && l.o === d.oldCount,
      b: l.t !== 1 && d.noEolNew && l.n === d.newCount,
    };
  }

  function unifiedHTML(d) {
    let h = '<table class="diff unified"><colgroup><col class="c-ln"><col class="c-ln"><col></colgroup><tbody>';
    for (const hunk of d.hunks) {
      prepareHunk(hunk);
      h += `<tr class="hunk"><td class="ln" colspan="2"></td><td class="code">${hunkLabel(hunk)}</td></tr>`;
      for (const l of hunk.lines) {
        const c = CLS[l.t];
        h += `<tr><td class="ln ${c}" data-ln="${l.o || ''}"></td><td class="ln ${c}" data-ln="${l.n || ''}"></td>` +
          `<td class="code ${c}" data-sign="${SIGN[l.t]}">${l.html}</td></tr>`;
        const e = eolFlags(l, d);
        if (e.a || e.b) h += `<tr class="eol"><td class="ln" colspan="2"></td><td class="code">\\ ${EOL_TEXT}</td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  function splitHTML(d) {
    const side = (l, which, last) => {
      if (!l) return `<td class="ln empty"></td><td class="code empty${last ? '' : ' l'}"></td>`;
      const c = l.t === 0 ? 'ctx' : CLS[l.t];
      const no = which === 'a' ? l.o : l.n;
      return `<td class="ln ${c}" data-ln="${no}"></td><td class="code ${c}${last ? '' : ' l'}" data-sign="${SIGN[l.t]}">${l.html}</td>`;
    };
    const eolRow = (ea, eb) =>
      `<tr class="eol"><td class="ln"></td><td class="code l">${ea ? '\\ ' + EOL_TEXT : ''}</td><td class="ln"></td><td class="code">${eb ? '\\ ' + EOL_TEXT : ''}</td></tr>`;

    let h = '<table class="diff split"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup><tbody>';
    for (const hunk of d.hunks) {
      prepareHunk(hunk);
      h += `<tr class="hunk"><td class="code" colspan="4">${hunkLabel(hunk)}</td></tr>`;
      const L = hunk.lines;
      for (let i = 0; i < L.length;) {
        if (L[i].t === 0) {
          const l = L[i++];
          h += `<tr>${side(l, 'a', false)}${side(l, 'b', true)}</tr>`;
          const e = eolFlags(l, d);
          if (e.a || e.b) h += eolRow(e.a, e.b);
          continue;
        }
        let j = i;
        while (j < L.length && L[j].t === 1) j++;
        let k = j;
        while (k < L.length && L[k].t === 2) k++;
        const dels = L.slice(i, j), adds = L.slice(j, k);
        for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
          h += `<tr>${side(dels[p], 'a', false)}${side(adds[p], 'b', true)}</tr>`;
          const ea = dels[p] && eolFlags(dels[p], d).a, eb = adds[p] && eolFlags(adds[p], d).b;
          if (ea || eb) h += eolRow(ea, eb);
        }
        i = k;
      }
    }
    return h + '</tbody></table>';
  }

  /* ---------- modos de exibição ---------- */

  function setView(view, rerender = true) {
    state.view = view;
    LS.set('view', view);
    for (const b of el.viewToggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === view);
    if (rerender && state.changes.length) {
      const active = state.activeFile;
      renderDiffs();
      if (active >= 0) {
        state.activeFile = -1;
        jumpToFile(active);
      }
    }
  }

  function setFileMode(mode, rerender = true) {
    state.fileMode = mode;
    LS.set('fileMode', mode);
    for (const b of el.fileModeToggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    if (rerender) renderFiles();
  }

  /* ---------- painéis recolhíveis e redimensionáveis ---------- */

  function togglePanel(id, force) {
    const p = $(id);
    const collapsed = p.classList.toggle('collapsed', force);
    LS.set('collapsed:' + id, collapsed);
  }

  function setupPanels() {
    for (const id of ['commitsPanel', 'filesPanel']) {
      const p = $(id);
      if (LS.get('collapsed:' + id, false)) p.classList.add('collapsed');
      const w = LS.get('width:' + id, 0);
      if (w) p.style.width = w + 'px';
      p.querySelector('.panel-head').addEventListener('click', (e) => {
        if (p.classList.contains('collapsed') || e.target.closest('[data-collapse]')) togglePanel(id);
      });
    }
    for (const r of document.querySelectorAll('.resizer')) {
      r.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const panel = $(r.dataset.target);
        const startX = e.clientX, startW = panel.getBoundingClientRect().width;
        r.classList.add('dragging');
        document.body.classList.add('resizing');
        const move = (ev) => {
          panel.style.width = Math.max(180, Math.min(720, startW + ev.clientX - startX)) + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          r.classList.remove('dragging');
          document.body.classList.remove('resizing');
          LS.set('width:' + panel.id, Math.round(panel.getBoundingClientRect().width));
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
  }

  /* ---------- navegação por teclado ---------- */

  function navigateCommit(dir) {
    const items = [...el.commitList.querySelectorAll('.commit:not([hidden])')];
    if (!items.length) return;
    let idx = items.findIndex((li) => li.classList.contains('active'));
    idx = idx < 0 ? 0 : idx + dir;
    if (idx < 0 || idx >= items.length) return;
    run(selectCommit)(items[idx].dataset.sha);
    if (dir > 0 && idx >= items.length - 5) run(loadMoreCommits)();
  }

  function navigateFile(dir) {
    const n = state.changes.length;
    if (!n) return;
    const next = state.activeFile < 0 ? (dir > 0 ? 0 : n - 1) : state.activeFile + dir;
    if (next >= 0 && next < n) jumpToFile(next);
  }

  /* ---------- eventos ---------- */

  function bindEvents() {
    el.pickBtn.addEventListener('click', run(pickFolder));
    el.dirInput.addEventListener('change', run(async () => {
      const files = el.dirInput.files;
      if (files && files.length) await openFS(new GitFS.FileListFS(files));
      el.dirInput.value = '';
    }));
    el.reloadBtn.addEventListener('click', run(reloadRepo));
    el.branch.addEventListener('change', run(() => loadBranch()));

    el.hashForm.addEventListener('submit', (e) => {
      e.preventDefault();
      run(async () => {
        if (!state.repo) return;
        const sha = await state.repo.resolve(el.hashInput.value);
        await selectCommit(sha);
      })();
    });

    el.commitList.addEventListener('click', (e) => {
      const li = e.target.closest('.commit');
      if (li) run(selectCommit)(li.dataset.sha);
    });
    el.commitScroll.addEventListener('scroll', () => {
      const s = el.commitScroll;
      if (s.scrollTop + s.clientHeight > s.scrollHeight - 200) run(loadMoreCommits)();
    });
    el.loadMore.addEventListener('click', run(loadMoreCommits));
    el.commitFilter.addEventListener('input', filterCommits);

    el.fileFilter.addEventListener('input', renderFiles);
    el.fileModeToggle.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (b) setFileMode(b.dataset.mode);
    });
    el.viewToggle.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b && b.dataset.view !== state.view) setView(b.dataset.view);
    });

    el.fileList.addEventListener('click', (e) => {
      const dir = e.target.closest('.dir-item');
      if (dir) return dir.classList.toggle('closed');
      const item = e.target.closest('.file-item');
      if (item) jumpToFile(+item.dataset.index);
    });

    for (const btn of document.querySelectorAll('[data-collapse]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel(btn.dataset.collapse);
      });
    }

    document.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        e.stopPropagation();
        navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Copiado!'), () => toast('Não foi possível copiar', 'error'));
        return;
      }
      const go = e.target.closest('[data-goto]');
      if (go) {
        e.preventDefault();
        run(selectCommit)(go.dataset.goto);
        return;
      }
      const force = e.target.closest('[data-force]');
      if (force) {
        const s = force.closest('.file');
        const i = +s.dataset.index;
        const ch = state.changes[i];
        ch.force = true;
        ch.promise = null;
        ch.diff = null;
        s.querySelector('.file-body').innerHTML = 'Calculando…';
        renderFileBody(i, state.gen);
        return;
      }
      const head = e.target.closest('.file-head');
      if (head) head.parentElement.classList.toggle('collapsed');
    });

    // Destaca na lateral o arquivo visível no topo do painel de diff.
    let raf = 0;
    el.diffPane.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const top = el.diffPane.getBoundingClientRect().top + 48;
        let cur = -1;
        for (const s of el.diffs.children) {
          if (!s.classList.contains('file')) continue;
          if (s.getBoundingClientRect().top <= top) cur = +s.dataset.index;
          else break;
        }
        setActiveFile(cur);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea')) return;
      const map = { j: () => navigateCommit(1), k: () => navigateCommit(-1), n: () => navigateFile(1), p: () => navigateFile(-1) };
      if (map[e.key]) {
        e.preventDefault();
        map[e.key]();
      }
    });
  }

  /* ---------- inicialização ---------- */

  async function init() {
    setupPanels();
    setView(state.view, false);
    setFileMode(state.fileMode, false);
    bindEvents();

    if (!('DecompressionStream' in window)) {
      el.supportNote.textContent = 'Seu navegador não suporta DecompressionStream; use uma versão recente do Chrome, Edge, Firefox ou Safari.';
      el.pickBtn.disabled = true;
      return;
    }
    if (!window.showDirectoryPicker) {
      el.supportNote.textContent = 'Seu navegador não suporta a File System Access API; será usado o seletor de pasta padrão (pode ser mais lento em projetos grandes). Chrome ou Edge recomendados.';
      return;
    }
    try {
      const h = await idbGet('lastDir');
      if (h && h.kind === 'directory') {
        el.reopenBtn.textContent = `Reabrir “${h.name}”`;
        el.reopenBtn.hidden = false;
        el.reopenBtn.addEventListener('click', run(async () => {
          const perm = await h.requestPermission({ mode: 'read' });
          if (perm !== 'granted') throw new Error('Permissão de leitura negada.');
          await openFS(new GitFS.HandleFS(h));
        }));
      }
    } catch { /* sem IndexedDB: ignora */ }
  }

  init();
})();

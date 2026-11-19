/* Interface do visualizador. Todo texto visível vem de I18n (js/locales/*.js). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    pickBtn: $('pickBtn'), reopenBtn: $('reopenBtn'), dirInput: $('dirInput'),
    repoInfo: $('repoInfo'), repoName: $('repoName'), reloadBtn: $('reloadBtn'),
    branch: $('branchSelect'), hashForm: $('hashForm'), hashInput: $('hashInput'), hashBtn: $('hashBtn'),
    status: $('status'), viewToggle: $('viewToggle'), hlToggle: $('hlToggle'), localeSelect: $('localeSelect'),
    appModeToggle: $('appModeToggle'), commitControls: $('commitControls'), compareControls: $('compareControls'),
    baseSelect: $('baseSelect'), headSelect: $('headSelect'), swapBtn: $('swapBtn'),
    commitCount: $('commitCount'), commitFilter: $('commitFilter'), commitScroll: $('commitScroll'),
    commitList: $('commitList'), loadMore: $('loadMore'),
    fileCount: $('fileCount'), fileFilter: $('fileFilter'), fileModeToggle: $('fileModeToggle'), fileList: $('fileList'),
    diffPane: $('diffPane'), commitHeader: $('commitHeader'), diffs: $('diffs'), toast: $('toast'),
    supportNote: $('supportNote'),
  };

  const { t, html: th } = I18n;
  const esc = Diff.escapeHtml;
  const td = new TextDecoder('utf-8');
  const EMPTY = new Uint8Array(0);
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const IMAGE_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };

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
    highlight: LS.get('highlight', true),
    appMode: LS.get('appMode', 'commit'), // 'commit' | 'compare'
    subject: null, // o que o painel mostra: 'commit' (state.current) | 'compare' (state.compare)
    compare: null, // resultado do modo Comparar (loadCompare)
    fileMode: LS.get('fileMode', 'list'),
    observer: null,
    loadingMore: false,
    activeFile: -1,
    collapsed: new Set(), // índices dos arquivos recolhidos no commit atual
    urls: [],
    busyKey: null,
    supportKey: null,
    lastHandle: null,
  };

  /* ---------- formatação dependente do idioma ---------- */

  const fmt = (() => {
    let locale = null, date, rel, num;
    const sync = () => {
      if (locale === I18n.locale) return;
      locale = I18n.locale;
      date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
      rel = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      num = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    };
    const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    return {
      date(sec) { sync(); return date.format(new Date(sec * 1000)); },
      relative(sec) {
        sync();
        const diff = sec - Date.now() / 1000, abs = Math.abs(diff);
        for (const [u, s] of UNITS) if (abs >= s) return rel.format(Math.round(diff / s), u);
        return rel.format(0, 'second');
      },
      size(n) {
        sync();
        if (n < 1024) return num.format(n) + ' B';
        if (n < 1048576) return num.format(n / 1024) + ' KB';
        return num.format(n / 1048576) + ' MB';
      },
    };
  })();

  /* ---------- utilitários ---------- */

  const short = (sha) => (sha ? sha.slice(0, 7) : '');
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const statusLabel = (s) => t('files.status.' + s);

  function busy(key) {
    state.busyKey = key;
    el.status.innerHTML = key ? `<span class="spinner"></span>${esc(t(key))}` : '';
  }

  let toastTimer = 0;
  function toast(msg, kind = '') {
    el.toast.textContent = msg;
    el.toast.className = 'toast ' + kind;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), kind === 'error' ? 6000 : 2000);
  }

  const errorMessage = (e) => (e && e.code ? t('errors.' + e.code, e.params) : e && e.message ? e.message : String(e));

  const run = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(e);
      busy(null);
      toast(errorMessage(e), 'error');
    }
  };

  /* ---------- IndexedDB: lembrar a última pasta ---------- */

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gitdiff', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        // Exceções aqui (ex.: DataCloneError, quota) viram rejeição em vez de erro não tratado.
        try {
          const tx = req.result.transaction('kv', mode);
          const r = fn(tx.objectStore('kv'));
          tx.oncomplete = () => resolve(r && r.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        } catch (e) {
          reject(e);
        }
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
    busy('status.reading');
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
    busy('status.reloading');
    try {
      state.repo = await Git.Repo.open(state.repo.fs);
      await loadRefs(keep, current);
      toast(t('toast.reloaded'));
    } finally {
      busy(null);
    }
  }

  const REF_GROUPS = [['branches.local', 'refs/heads/'], ['branches.remote', 'refs/remotes/'], ['branches.tags', 'refs/tags/'], ['branches.other', 'refs/']];

  // Preenche os seletores de ref (branch do modo Commit, base e compare), mantendo as escolhas.
  function renderBranchOptions() {
    const { refs, head } = state;
    if (!head) return;
    const buckets = REF_GROUPS.map(() => []);
    for (const name of [...refs.keys()].sort((a, b) => a.localeCompare(b))) {
      const g = REF_GROUPS.findIndex(([, p]) => name.startsWith(p));
      buckets[g].push([name, name.slice(REF_GROUPS[g][1].length)]);
    }
    let h = '';
    if (head.sha) h += `<option value="HEAD">${esc(t('branches.detached', { sha: short(head.sha) }))}</option>`;
    REF_GROUPS.forEach(([label], g) => {
      if (!buckets[g].length) return;
      h += `<optgroup label="${esc(t(label))}">` +
        buckets[g].map(([v, name]) => `<option value="${esc(v)}">${esc(name)}${v === head.ref ? ' ●' : ''}</option>`).join('') +
        '</optgroup>';
    });
    for (const sel of [el.branch, el.baseSelect, el.headSelect]) {
      const keep = sel.value;
      sel.innerHTML = h;
      sel.disabled = !h;
      if (keep) sel.value = keep;
    }
    el.swapBtn.disabled = !h;
  }

  // Nome curto de uma ref para exibição: refs/heads/main → main, refs/remotes/origin/x → origin/x.
  function refLabel(ref) {
    const g = REF_GROUPS.find(([, p]) => ref.startsWith(p));
    return g ? ref.slice(g[1].length) : ref;
  }

  /* Base e compare iniciais: a última escolha (se ainda existir); senão a base é a branch padrão
   * do remoto (origin/HEAD) ou main/master/develop, e o compare é a branch atual. */
  async function chooseCompareDefaults() {
    const { refs, head } = state;
    const has = (v) => !!v && (v === 'HEAD' ? !!head.sha : refs.has(v));
    let base = LS.get('cmp:base', null), cmp = LS.get('cmp:head', null);
    if (!has(base)) {
      const originHead = await state.repo.readSymbolicRef('refs/remotes/origin/HEAD');
      const candidates = [];
      if (originHead) candidates.push('refs/heads/' + originHead.replace(/^refs\/remotes\/origin\//, ''), originHead);
      candidates.push('refs/heads/main', 'refs/heads/master', 'refs/heads/develop', 'refs/remotes/origin/main', 'refs/remotes/origin/master');
      base = candidates.find(has) || (el.baseSelect.options[0] && el.baseSelect.options[0].value);
    }
    if (!has(cmp) || cmp === base) {
      cmp = has(head.ref) && head.ref !== base ? head.ref
        : [...refs.keys()].find((r) => r.startsWith('refs/heads/') && r !== base) || base;
    }
    el.baseSelect.value = base;
    el.headSelect.value = cmp;
  }

  async function loadRefs(preferred, keepCommit) {
    const repo = state.repo;
    const [refs, head] = await Promise.all([repo.listRefs(), repo.readHead()]);
    state.refs = refs;
    state.head = head;
    el.branch.innerHTML = '';
    renderBranchOptions();

    if (!el.branch.options.length) {
      state.commits = [];
      el.commitList.innerHTML = `<li class="list-empty">${esc(t('commits.none'))}</li>`;
      return;
    }
    const has = (v) => v && (v === 'HEAD' ? !!head.sha : refs.has(v));
    el.branch.value = has(preferred) ? preferred : has(head.ref) ? head.ref : el.branch.options[0].value;
    await chooseCompareDefaults();
    if (state.appMode === 'compare') await loadCompare();
    else await loadBranch(keepCommit);
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
    busy('status.loadingCommits');
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
      li.title = `${subject}\n\n${c.author.name} <${c.author.email}>\n${fmt.date(c.author.time)}\n${c.sha}`;
      li.innerHTML =
        `<div class="c-subject">${c.parents.length > 1 ? `<span class="tag-merge">${esc(t('commits.merge'))}</span>` : ''}` +
        `${subject ? esc(subject) : `<em>${esc(t('commits.noMessage'))}</em>`}</div>` +
        `<div class="c-meta"><code>${short(c.sha)}</code><span class="c-author">${esc(c.author.name)}</span>` +
        `<time>${esc(fmt.relative(c.author.time))}</time></div>`;
      if (state.current && state.current.sha === c.sha) li.classList.add('active');
      if (q && !li.dataset.search.includes(q)) li.hidden = true;
      frag.appendChild(li);
    }
    el.commitList.appendChild(frag);
  }

  // Modo Comparar: "Todas as alterações" no topo, seguido dos commits que o PR traria.
  function renderCompareCommitList() {
    const top = el.commitScroll.scrollTop;
    const n = state.commits.length;
    el.commitList.innerHTML =
      `<li class="commit commit-all${state.subject === 'compare' ? ' active' : ''}" data-all="1">` +
      `<div class="c-subject">${esc(t('compare.all'))}</div>` +
      `<div class="c-meta"><span>${esc(t('compare.commits', { count: n }))}</span></div></li>` +
      (n ? '' : `<li class="list-empty">${esc(t('compare.noCommits'))}</li>`);
    appendCommits(state.commits);
    el.commitCount.textContent = n ? String(n) : '';
    el.loadMore.hidden = true;
    el.commitScroll.scrollTop = top;
  }

  function rerenderCommitList() {
    if (state.appMode === 'compare' && state.compare) return renderCompareCommitList();
    if (!state.commits.length) {
      if (state.head && !el.branch.options.length) el.commitList.innerHTML = `<li class="list-empty">${esc(t('commits.none'))}</li>`;
      return;
    }
    const top = el.commitScroll.scrollTop;
    el.commitList.innerHTML = '';
    appendCommits(state.commits);
    el.commitScroll.scrollTop = top;
  }

  function filterCommits() {
    const q = el.commitFilter.value.trim().toLowerCase();
    for (const li of el.commitList.children) {
      if (li.dataset.search) li.hidden = !!q && !li.dataset.search.includes(q);
    }
  }

  // sha null = item "Todas as alterações" do modo Comparar.
  function markActiveCommit(sha) {
    for (const li of el.commitList.querySelectorAll('.commit.active')) li.classList.remove('active');
    const li = el.commitList.querySelector(sha ? `.commit[data-sha="${sha}"]` : '.commit[data-all]');
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
    busy('status.computing');
    try {
      const commit = await state.repo.readCommit(sha);
      const changes = await state.repo.diffCommit(commit);
      if (gen !== state.gen) return;
      state.current = commit;
      showChanges('commit', changes, gen);
    } finally {
      if (gen === state.gen) busy(null);
    }
  }

  // Mostra uma lista de alterações no painel (de um commit ou de uma comparação).
  function showChanges(subject, changes, gen) {
    state.subject = subject;
    state.changes = changes;
    state.activeFile = -1;
    state.collapsed = new Set();
    renderHeader();
    renderFiles();
    renderDiffs();
    el.diffPane.scrollTop = 0;
    computeAllStats(gen);
  }

  function renderHeader() {
    if (state.subject === 'compare') renderCompareHeader();
    else if (state.subject === 'commit') renderCommitHeader(state.current);
  }

  /* ---------- modo Comparar (pull request) ---------- */

  /* Compara base ← compare como um PR: commits só do compare, alterações do ancestral comum
   * até o compare (diff de 3 pontos) e, em segundo plano, a previsão de conflitos com a base. */
  async function loadCompare() {
    const repo = state.repo;
    const baseRef = el.baseSelect.value, headRef = el.headSelect.value;
    if (!repo || !baseRef || !headRef) return;
    LS.set('cmp:base', baseRef);
    LS.set('cmp:head', headRef);
    const gen = ++state.gen;
    busy('status.comparing');
    try {
      const [baseSha, headSha] = await Promise.all([repo.peelToCommit(refSha(baseRef)), repo.peelToCommit(refSha(headRef))]);
      const res = await repo.compareTips(baseSha, headSha);
      const [baseC, headC] = await Promise.all([repo.readCommit(baseSha), repo.readCommit(headSha)]);
      const mb = res.mergeBase ? await repo.readCommit(res.mergeBase) : null;
      // Sem ancestral comum (históricos independentes): diferença direta entre as pontas.
      const changes = await repo.diffTreesWithRenames(mb ? mb.tree : baseC.tree, headC.tree);
      if (gen !== state.gen) return;
      const cmp = (state.compare = { baseRef, headRef, baseSha, headSha, res, mb, baseC, headC, changes, analysis: null, error: null });
      state.walker = null;
      state.current = null;
      state.commits = res.ahead;
      state.subject = 'compare';
      renderCompareCommitList();
      busy(null);
      showCompareAll();
      analyzeConflicts(cmp);
    } finally {
      if (gen === state.gen) busy(null);
    }
  }

  // Volta para a visão "Todas as alterações" da comparação atual.
  function showCompareAll() {
    if (!state.compare) return;
    const gen = ++state.gen;
    state.current = null;
    markActiveCommit(null);
    showChanges('compare', state.compare.changes, gen);
  }

  async function analyzeConflicts(cmp) {
    const { res, mb, baseC, changes } = cmp;
    // Só faz sentido com ancestral comum e com o que levar para a base.
    if (!mb || !res.ahead.length || cmp.baseSha === cmp.headSha) return;
    try {
      cmp.analysis = await Compare.analyze(state.repo, mb.tree, baseC.tree, changes);
    } catch (e) {
      console.error(e);
      cmp.error = errorMessage(e);
    }
    if (state.compare === cmp && state.subject === 'compare') updateConflictUI();
  }

  function rangesText(c) {
    if (!c.ranges || !c.ranges.length) return '';
    return c.ranges.map((r) => (r.start === r.end ? t('compare.line', { n: r.start }) : t('compare.lines', r))).join(', ');
  }

  function conflictLabel(c) {
    const kind = t('compare.kind.' + (c.large ? 'large' : c.kind));
    const lines = rangesText(c);
    return lines ? `${kind} (${lines})` : kind;
  }

  function conflictStatusHTML() {
    const cmp = state.compare;
    const { res, mb } = cmp;
    if (!mb || !res.ahead.length || cmp.baseSha === cmp.headSha) return '';
    if (cmp.error) return `<div class="cmp-box error">${esc(t('compare.analysisFailed', { message: cmp.error }))}</div>`;
    if (!cmp.analysis) return `<div class="cmp-box info"><span class="spinner"></span>${esc(t('compare.analyzing'))}</div>`;
    const { conflicts, clean } = cmp.analysis;
    const cleanNote = clean ? `<p class="muted">${esc(t('compare.clean', { count: clean }))}</p>` : '';
    if (!conflicts) return `<div class="cmp-box ok"><strong>✓ ${esc(t('compare.noConflicts'))}</strong>${cleanNote}</div>`;
    const items = state.changes
      .map((ch, i) => [ch, i])
      .filter(([ch]) => ch.conflict && ch.conflict.conflict)
      .map(([ch, i]) => `<li><a href="#" data-file="${i}">${esc(ch.path)}</a> — ${esc(conflictLabel(ch.conflict))}</li>`)
      .join('');
    return `<div class="cmp-box warn"><strong>⚠ ${esc(t('compare.conflicts', { count: conflicts }))}</strong>` +
      `<ul>${items}</ul>${cleanNote}<p class="muted">${esc(t('compare.estimate'))}</p></div>`;
  }

  function renderCompareHeader() {
    const cmp = state.compare;
    const { res, mb } = cmp;
    const base = refLabel(cmp.baseRef), head = refLabel(cmp.headRef);
    const ahead = res.ahead.length, behind = res.behind.length;
    const authors = new Set(res.ahead.map((c) => c.author.email || c.author.name)).size;
    const notices = [];
    if (cmp.baseSha === cmp.headSha) notices.push(t('compare.same'));
    else if (!ahead && !res.truncated) notices.push(t('compare.nothing', { base, head }));
    if (!mb && !res.truncated && cmp.baseSha !== cmp.headSha) notices.push(t('compare.unrelated'));
    if (res.truncated) notices.push(t('compare.truncated'));
    if (mb && ahead && behind) notices.push(t('compare.behindNote', { count: behind, base, head }));
    el.commitHeader.hidden = false;
    el.commitHeader.innerHTML = `
      <div class="ch-subject cmp-title">${th('compare.title', { base, head })}</div>
      <div class="ch-meta">
        <span>${esc(t('compare.ahead', { count: ahead }))}</span>
        <span class="${behind ? 'cmp-behind' : ''}">${esc(t('compare.behind', { count: behind }))}</span>
        ${authors ? `<span>${esc(t('compare.authors', { count: authors }))}</span>` : ''}
        ${mb ? `<span>${esc(t('compare.mergeBase'))}: <a href="#" data-goto="${mb.sha}" title="${mb.sha}">${short(mb.sha)}</a></span>` : ''}
        <span class="ch-stats" id="commitStats"></span>
      </div>
      ${notices.map((n) => `<p class="cmp-notice">${esc(n)}</p>`).join('')}
      <div id="cmpStatus">${conflictStatusHTML()}</div>`;
    updateTotals();
  }

  const conflictBadgeHTML = (ch) => (ch.conflict && ch.conflict.conflict
    ? `<span class="cmp-badge" title="${esc(conflictLabel(ch.conflict))}">⚠ ${esc(t('compare.badge'))}</span>` : '');

  // Linhas do compare dentro de um trecho de conflito ganham uma marca na margem.
  function markConflictRows(body, ch) {
    const ranges = ch.conflict && ch.conflict.conflict && ch.conflict.ranges;
    if (!ranges || !ranges.length) return;
    for (const tr of body.querySelectorAll('tr[data-n]')) {
      const n = +tr.dataset.n;
      if (n && ranges.some((r) => n >= r.start && n <= r.end)) tr.classList.add('conflict');
    }
  }

  // Resultado da análise chegou: atualiza o resumo, a lateral e os cabeçalhos/linhas já exibidos.
  function updateConflictUI() {
    const status = document.getElementById('cmpStatus');
    if (status) status.innerHTML = conflictStatusHTML();
    renderFiles();
    state.changes.forEach((ch, i) => {
      const s = el.diffs.querySelector(`.file[data-index="${i}"]`);
      if (!s) return;
      const slot = s.querySelector('.fh-conflict');
      if (slot) slot.innerHTML = conflictBadgeHTML(ch);
      const body = s.querySelector('.file-body:not(.placeholder)');
      if (body) markConflictRows(body, ch);
    });
  }

  function setAppMode(mode, load = true) {
    state.appMode = mode;
    LS.set('appMode', mode);
    for (const b of el.appModeToggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.appmode === mode);
    el.commitControls.hidden = mode !== 'commit';
    el.compareControls.hidden = mode !== 'compare';
    if (!load || !state.repo || !el.branch.options.length) return;
    if (mode === 'compare') return loadCompare();
    state.compare = null;
    return loadBranch();
  }

  function renderCommitHeader(c) {
    const lines = c.message.replace(/\s+$/, '').split('\n');
    const subject = lines[0] || t('commits.noMessage');
    const body = lines.slice(1).join('\n').replace(/^\n+/, '');
    const a = c.author, cm = c.committer;
    const committerInfo = cm.name !== a.name || cm.email !== a.email
      ? `<span>${th('commit.committedBy', { name: cm.name, date: fmt.date(cm.time) })}</span>` : '';
    const n = c.parents.length;
    const parents = n
      ? `<span>${esc(t('commit.parents', { count: n }))}: ${c.parents.map((p, i) =>
          `<a href="#" data-goto="${p}" title="${p}">${short(p)}</a>${n > 1 && i === 0 ? ' ' + esc(t('commit.compared')) : ''}`).join(' ')}</span>`
      : `<span>${esc(t('commit.initial'))}</span>`;
    el.commitHeader.hidden = false;
    el.commitHeader.innerHTML = `
      <div class="ch-subject">${esc(subject)}</div>
      ${body ? `<pre class="ch-body">${esc(body)}</pre>` : ''}
      <div class="ch-meta">
        <span><strong>${esc(a.name)}</strong> &lt;${esc(a.email)}&gt; · <time title="${esc(a.tz)}">${esc(fmt.date(a.time))}</time></span>
        ${committerInfo}
        <span class="ch-sha"><code>${c.sha}</code><button class="btn copy-btn" data-copy="${c.sha}">${esc(t('commit.copy'))}</button></span>
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
      // Os tokens de sintaxe (tokA/tokB) são calculados só quando o arquivo é exibido: ensureTokens().
      lang: hunks.length ? Highlight.langFor(ch.path) : null,
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
    const h = statHTML(state.changes[i].diff);
    for (const n of document.querySelectorAll(`[data-stat="${i}"]`)) n.innerHTML = h;
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
    node.innerHTML = `${esc(t('commit.files', { count: n }))} · <span class="add">+${adds}</span> <span class="del">−${dels}</span>` +
      (done < n ? ' <span class="muted">…</span>' : '');
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

  // "Renomeado (87% semelhante)" para renomeações com alteração de conteúdo.
  const statusTitle = (ch) => statusLabel(ch.status) +
    (ch.similarity !== undefined && ch.similarity < 100 ? ` (${t('files.similarity', { pct: ch.similarity })})` : '');

  function fileItemHTML(ch, i, name, dir, depth) {
    const conflict = ch.conflict && ch.conflict.conflict;
    const title = (ch.oldPath ? ch.oldPath + ' → ' : '') + ch.path + ' (' + statusTitle(ch) + ')' +
      (conflict ? '\n⚠ ' + conflictLabel(ch.conflict) : '');
    return `<li class="file-item${i === state.activeFile ? ' active' : ''}" data-index="${i}" style="--depth:${depth}" title="${esc(title)}">` +
      `<span class="badge s-${ch.status}">${ch.status}</span>` +
      `<span class="fi-text">${esc(name)}${dir ? `<span class="fi-dir">${esc(dir)}</span>` : ''}</span>` +
      (conflict ? '<span class="fi-conflict">⚠</span>' : '') +
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
      : `<li class="list-empty">${esc(t(state.changes.length ? 'files.noMatch' : 'files.none'))}</li>`;
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
    state.collapsed.delete(i);
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
      el.diffs.innerHTML = `<div class="notice">${esc(t('diff.noChanges'))}</div>`;
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
      s.className = state.collapsed.has(i) ? 'file collapsed' : 'file';
      s.dataset.index = i;
      const path = ch.oldPath ? `${pathHTML(ch.oldPath)} <span class="dim">→</span> ${pathHTML(ch.path)}` : pathHTML(ch.path);
      s.innerHTML =
        `<header class="file-head">` +
        `<button class="icon-btn fh-toggle" title="${esc(t('panels.toggle'))}">▾</button>` +
        `<span class="badge s-${ch.status}" title="${esc(statusTitle(ch))}">${ch.status}</span>` +
        `<span class="fh-path" title="${esc(ch.path)}">${path}</span>` +
        `<span class="fh-conflict">${conflictBadgeHTML(ch)}</span>` +
        `<span class="fh-stat" data-stat="${i}">${statHTML(ch.diff)}</span>` +
        `<button class="icon-btn fh-copy" data-copy="${esc(ch.path)}" title="${esc(t('diff.copyPath'))}">⧉</button>` +
        `</header><div class="file-body placeholder">${esc(t('status.loading'))}</div>`;
      frag.appendChild(s);
      observer.observe(s);
    });
    el.diffs.appendChild(frag);
    state.changes.forEach((_, i) => estimatePlaceholder(i));
  }

  /* Âncora de rolagem: a linha do diff que está no topo do painel (arquivo + número de linha
   * antigo/novo + deslocamento em px). Sobrevive à troca Unificado/Lado a lado, em que as
   * alturas mudam, porque é restaurada pela linha, não pelo scrollTop. */
  function captureAnchor() {
    const paneTop = el.diffPane.getBoundingClientRect().top;
    for (const s of el.diffs.querySelectorAll('.file')) {
      const r = s.getBoundingClientRect();
      if (r.bottom <= paneTop) continue;
      const i = +s.dataset.index;
      if (r.top >= paneTop || s.classList.contains('collapsed')) return { i, offset: r.top - paneTop };
      const rows = s.querySelectorAll('tr[data-o]');
      let lo = 0, hi = rows.length;
      while (lo < hi) { // primeira linha cuja base está abaixo do topo do painel
        const m = (lo + hi) >> 1;
        if (rows[m].getBoundingClientRect().bottom <= paneTop) lo = m + 1;
        else hi = m;
      }
      const row = rows[lo];
      if (!row) return { i, offset: r.top - paneTop };
      return { i, o: row.dataset.o, n: row.dataset.n, offset: row.getBoundingClientRect().top - paneTop };
    }
    return null;
  }

  async function restoreAnchor(a, gen) {
    const s = el.diffs.querySelector(`.file[data-index="${a.i}"]`);
    if (!s) return;
    let target = s;
    if (a.o !== undefined) {
      if (s.querySelector('.file-body.placeholder')) {
        if (state.observer) state.observer.unobserve(s);
        await renderFileBody(a.i, gen);
        if (gen !== state.gen || !s.isConnected) return;
      }
      const rows = [...s.querySelectorAll('tr[data-o]')];
      const find = (key, v) => (v ? rows.find((tr) => tr.dataset[key] === v) : null);
      target = find('n', a.n) || find('o', a.o) || s;
    }
    el.diffPane.scrollTop += target.getBoundingClientRect().top - el.diffPane.getBoundingClientRect().top - a.offset;
  }

  // Re-renderiza o painel de diffs (troca de modo/idioma) mantendo recolhidos e a linha em vista.
  async function rerenderDiffs() {
    const anchor = captureAnchor();
    const gen = state.gen;
    renderDiffs();
    if (anchor) await restoreAnchor(anchor, gen);
  }

  /* Renderiza o corpo de um arquivo. Pode ser chamada de novo para o mesmo arquivo
   * (observer, âncora, religar a sintaxe): só a chamada mais recente escreve no DOM. */
  async function renderFileBody(i, gen) {
    const ch = state.changes[i];
    const body = el.diffs.querySelector(`.file[data-index="${i}"] .file-body`);
    if (!body) return;
    const seq = (body.renderSeq = (body.renderSeq || 0) + 1);
    const stale = () => gen !== state.gen || body.renderSeq !== seq || !body.isConnected;
    try {
      await computeFileDiff(ch);
    } catch (e) {
      if (stale()) return;
      body.className = 'file-body';
      body.innerHTML = `<div class="notice error">${esc(t('diff.readError', { message: errorMessage(e) }))}</div>`;
      return;
    }
    if (state.highlight) await ensureTokens(ch);
    if (stale()) return;
    const d = ch.diff;
    body.className = 'file-body';
    body.style.minHeight = '';
    body.innerHTML = diffBodyHTML(ch);
    markConflictRows(body, ch);
    // Exibido sem tokens (sintaxe estava desligada): religar refaz só este corpo.
    if (d.kind === 'text' && d.lang && d.tokA === undefined) body.dataset.plain = '1';
    else delete body.dataset.plain;
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
    const notice = (h) => `<div class="notice">${h}</div>`;
    if (d.kind === 'submodule') {
      return notice(th('diff.submodule', { old: short(ch.oldSha) || '—', new: short(ch.newSha) || '—' }));
    }
    if (d.kind === 'large') {
      return notice(`${esc(t('diff.large', { size: fmt.size(d.size) }))} <button class="btn" data-force="1">${esc(t('diff.showAnyway'))}</button>`);
    }
    if (d.kind === 'binary') {
      if (d.type) {
        const fig = (side, cls, label, size) =>
          `<figure class="${cls}"><figcaption>${esc(label)} · ${esc(fmt.size(size))}</figcaption><img data-side="${side}" alt="${esc(label)}"></figure>`;
        return '<div class="img-diff">' +
          (ch.oldSha ? fig('a', 'old', t('diff.before'), d.oldSize) : '') +
          (ch.newSha ? fig('b', 'new', t('diff.after'), d.newSize) : '') + '</div>';
      }
      return notice(esc(ch.oldSha && ch.newSha
        ? t('diff.binaryChanged', { old: fmt.size(d.oldSize), new: fmt.size(d.newSize) })
        : t('diff.binary', { size: fmt.size(d.oldSize || d.newSize) })));
    }
    const modeNote = ch.oldMode && ch.newMode && ch.oldMode !== ch.newMode
      ? notice(th('diff.modeChanged', { old: ch.oldMode, new: ch.newMode })) : '';
    if (!d.hunks.length) {
      return modeNote || notice(esc(t(ch.status === 'R' ? 'diff.renamedOnly' : 'diff.empty')));
    }
    return modeNote + (state.view === 'split' ? splitHTML(d) : unifiedHTML(d));
  }

  const crMark = () => `<span class="cr" title="${esc(t('diff.cr'))}">␍</span>`;

  /* Tokens de sintaxe por linha dos dois lados (d.tokA = antigo, d.tokB = novo), calculados
   * sobre o arquivo inteiro na primeira vez que ele é exibido com realce. O texto não fica
   * guardado no diff: os blobs são relidos do cache do repositório. */
  async function ensureTokens(ch) {
    const d = ch.diff;
    if (!d || d.kind !== 'text' || !d.lang || d.tokA !== undefined) return;
    try {
      const [a, b] = await Promise.all([
        ch.oldSha ? state.repo.readBlob(ch.oldSha) : EMPTY,
        ch.newSha ? state.repo.readBlob(ch.newSha) : EMPTY,
      ]);
      d.tokA = a.length ? Highlight.lines(td.decode(a), d.lang) : null;
      d.tokB = b.length ? Highlight.lines(td.decode(b), d.lang) : null;
    } catch (e) {
      console.warn(e);
      d.tokA = d.tokB = null; // sem realce para este arquivo, mas o diff continua
    }
  }

  /* HTML de uma linha: combina tokens de sintaxe [classe, texto] com os intervalos
   * [início, fim) de palavras alteradas. Os tokens são cortados nos limites dos intervalos
   * para que <mark> e <span> fiquem bem aninhados. */
  function lineHTML(tokens, ranges, changed) {
    let toks = tokens, cr = false;
    const last = toks[toks.length - 1];
    if (last && last[1].endsWith('\r')) {
      cr = true;
      toks = toks.slice(0, -1);
      if (last[1].length > 1) toks.push([last[0], last[1].slice(0, -1)]);
    }
    let h = '', pos = 0, r = 0, inMark = false;
    for (const [cls, text] of toks) {
      let i = 0;
      while (i < text.length) {
        let end = text.length, marked = false;
        if (ranges) {
          while (r < ranges.length && ranges[r][1] <= pos + i) r++;
          const rg = ranges[r];
          if (rg) {
            marked = pos + i >= rg[0];
            end = Math.min(end, (marked ? rg[1] : rg[0]) - pos);
          }
        }
        if (marked !== inMark) {
          h += marked ? '<mark>' : '</mark>';
          inMark = marked;
        }
        const piece = esc(text.slice(i, end));
        h += cls ? `<span class="hl-${cls}">${piece}</span>` : piece;
        i = end;
      }
      pos += text.length;
    }
    if (inMark) h += '</mark>';
    return h + (cr && changed ? crMark() : '');
  }

  /* Prepara o HTML de cada linha: tokens de sintaxe (quando já calculados) + destaque de
   * palavras entre pares -/+. As cores entram sempre que há tokens; ligar/desligar a sintaxe
   * só alterna a classe .no-hl no painel (CSS), sem refazer este HTML. */
  function prepareHunk(h, d) {
    const tokA = d.tokA || null, tokB = d.tokB || null;
    const mode = tokA || tokB ? 'hl' : 'plain';
    if (h.ready === mode) return;
    h.ready = mode;

    const L = h.lines;
    if (!h.ranged) { // destaque de palavras: não depende do modo, calculado uma vez
      h.ranged = true;
      for (let i = 0; i < L.length;) {
        if (L[i].t !== 1) { i++; continue; }
        let j = i;
        while (j < L.length && L[j].t === 1) j++;
        let k = j;
        while (k < L.length && L[k].t === 2) k++;
        for (let p = 0, pairs = Math.min(j - i, k - j); p < pairs; p++) {
          const a = L[i + p], b = L[j + p];
          const r = Diff.intraline(a.text.replace(/\r$/, ''), b.text.replace(/\r$/, ''));
          if (r) {
            a.ranges = r[0];
            b.ranges = r[1];
          }
        }
        i = k;
      }
    }
    for (const l of L) {
      // Contexto usa o lado novo; linhas removidas, o antigo.
      const lineToks = l.t === 1 ? tokA && tokA[l.o - 1] : tokB && tokB[l.n - 1];
      l.html = lineHTML(lineToks || [[null, l.text]], l.ranges, l.t !== 0);
    }
  }

  const CLS = ['ctx', 'del', 'add'];
  const SIGN = [' ', '-', '+'];
  const hunkLabel = (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

  function eolFlags(l, d) {
    return {
      a: l.t !== 2 && d.noEolOld && l.o === d.oldCount,
      b: l.t !== 1 && d.noEolNew && l.n === d.newCount,
    };
  }

  function unifiedHTML(d) {
    const eolText = '\\ ' + esc(t('diff.noEol'));
    let h = '<table class="diff unified"><colgroup><col class="c-ln"><col class="c-ln"><col></colgroup><tbody>';
    for (const hunk of d.hunks) {
      prepareHunk(hunk, d);
      h += `<tr class="hunk"><td class="ln" colspan="2"></td><td class="code">${hunkLabel(hunk)}</td></tr>`;
      for (const l of hunk.lines) {
        const c = CLS[l.t];
        h += `<tr data-o="${l.o || ''}" data-n="${l.n || ''}"><td class="ln ${c}" data-ln="${l.o || ''}"></td><td class="ln ${c}" data-ln="${l.n || ''}"></td>` +
          `<td class="code ${c}" data-sign="${SIGN[l.t]}">${l.html}</td></tr>`;
        const e = eolFlags(l, d);
        if (e.a || e.b) h += `<tr class="eol"><td class="ln" colspan="2"></td><td class="code">${eolText}</td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  function splitHTML(d) {
    const eolText = '\\ ' + esc(t('diff.noEol'));
    const side = (l, which, last) => {
      if (!l) return `<td class="ln empty"></td><td class="code empty${last ? '' : ' l'}"></td>`;
      const c = CLS[l.t];
      const no = which === 'a' ? l.o : l.n;
      return `<td class="ln ${c}" data-ln="${no}"></td><td class="code ${c}${last ? '' : ' l'}" data-sign="${SIGN[l.t]}">${l.html}</td>`;
    };
    const eolRow = (ea, eb) =>
      `<tr class="eol"><td class="ln"></td><td class="code l">${ea ? eolText : ''}</td><td class="ln"></td><td class="code">${eb ? eolText : ''}</td></tr>`;

    let h = '<table class="diff split"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup><tbody>';
    for (const hunk of d.hunks) {
      prepareHunk(hunk, d);
      h += `<tr class="hunk"><td class="code" colspan="4">${hunkLabel(hunk)}</td></tr>`;
      const L = hunk.lines;
      for (let i = 0; i < L.length;) {
        if (L[i].t === 0) {
          const l = L[i++];
          h += `<tr data-o="${l.o}" data-n="${l.n}">${side(l, 'a', false)}${side(l, 'b', true)}</tr>`;
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
          h += `<tr data-o="${dels[p] ? dels[p].o : ''}" data-n="${adds[p] ? adds[p].n : ''}">` +
            `${side(dels[p], 'a', false)}${side(adds[p], 'b', true)}</tr>`;
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
    if (rerender && state.changes.length) rerenderDiffs().catch(console.error);
  }

  /* Ligar/desligar a sintaxe não re-renderiza o painel: as cores são escondidas por CSS
   * (.no-hl). Ao ligar, só os arquivos já exibidos sem tokens são refeitos, um a um, com as
   * mesmas linhas, então a rolagem e os arquivos recolhidos não mudam. */
  function setHighlight(on, refresh = true) {
    state.highlight = on;
    LS.set('highlight', on);
    el.hlToggle.classList.toggle('on', on);
    el.hlToggle.setAttribute('aria-pressed', String(on));
    el.diffs.classList.toggle('no-hl', !on);
    if (refresh && on) {
      for (const body of el.diffs.querySelectorAll('.file-body[data-plain]')) {
        renderFileBody(+body.closest('.file').dataset.index, state.gen);
      }
    }
  }

  function renderHighlightTitle() {
    el.hlToggle.title = t('toolbar.highlightTitle', { langs: Highlight.LANGUAGES.join(', ') });
  }

  function setFileMode(mode, rerender = true) {
    state.fileMode = mode;
    LS.set('fileMode', mode);
    for (const b of el.fileModeToggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    if (rerender) renderFiles();
  }

  /* ---------- idioma ---------- */

  function renderLocaleSelect() {
    el.localeSelect.innerHTML = I18n.available()
      .map(({ code, name }) => `<option value="${esc(code)}">${esc(name)}</option>`)
      .join('');
    el.localeSelect.value = I18n.locale;
  }

  // Textos dinâmicos (fora do HTML estático) são refeitos ao trocar de idioma.
  function onLocaleChange() {
    el.localeSelect.value = I18n.locale;
    renderHighlightTitle();
    if (state.busyKey) busy(state.busyKey);
    el.supportNote.textContent = state.supportKey ? t(state.supportKey) : '';
    if (state.lastHandle) el.reopenBtn.textContent = t('toolbar.reopen', { name: state.lastHandle.name });
    renderBranchOptions();
    rerenderCommitList();
    if (state.subject) {
      renderHeader();
      renderFiles();
      for (const ch of state.changes) {
        if (ch.diff && ch.diff.hunks) for (const h of ch.diff.hunks) h.ready = false; // marcas de CR têm title traduzido
      }
      rerenderDiffs().catch(console.error);
    }
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
    if (items[idx].dataset.all) showCompareAll();
    else run(selectCommit)(items[idx].dataset.sha);
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
    el.localeSelect.addEventListener('change', () => I18n.setLocale(el.localeSelect.value));

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
      if (!li) return;
      if (li.dataset.all) showCompareAll();
      else run(selectCommit)(li.dataset.sha);
    });

    el.appModeToggle.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-appmode]');
      if (b && b.dataset.appmode !== state.appMode) run(setAppMode)(b.dataset.appmode);
    });
    el.baseSelect.addEventListener('change', run(loadCompare));
    el.headSelect.addEventListener('change', run(loadCompare));
    el.swapBtn.addEventListener('click', run(() => {
      [el.baseSelect.value, el.headSelect.value] = [el.headSelect.value, el.baseSelect.value];
      return loadCompare();
    }));
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
    el.hlToggle.addEventListener('click', () => setHighlight(!state.highlight));

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
        navigator.clipboard.writeText(copy.dataset.copy).then(() => toast(t('toast.copied')), () => toast(t('toast.copyFailed'), 'error'));
        return;
      }
      const go = e.target.closest('[data-goto]');
      if (go) {
        e.preventDefault();
        run(selectCommit)(go.dataset.goto);
        return;
      }
      const file = e.target.closest('[data-file]'); // link de arquivo no resumo de conflitos
      if (file) {
        e.preventDefault();
        jumpToFile(+file.dataset.file);
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
        s.querySelector('.file-body').textContent = t('status.computing');
        renderFileBody(i, state.gen);
        return;
      }
      const head = e.target.closest('.file-head');
      if (head) {
        const s = head.parentElement;
        const i = +s.dataset.index;
        if (s.classList.toggle('collapsed')) state.collapsed.add(i);
        else state.collapsed.delete(i);
      }
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
      const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
      if (e.ctrlKey || e.metaKey || e.altKey || typing) return;
      const map = { j: () => navigateCommit(1), k: () => navigateCommit(-1), n: () => navigateFile(1), p: () => navigateFile(-1) };
      if (map[e.key]) {
        e.preventDefault();
        map[e.key]();
      }
    });
  }

  /* ---------- inicialização ---------- */

  async function init() {
    I18n.init();
    renderLocaleSelect();
    I18n.onChange(onLocaleChange);
    setupPanels();
    setView(state.view, false);
    setHighlight(state.highlight, false);
    renderHighlightTitle();
    setAppMode(state.appMode, false);
    setFileMode(state.fileMode, false);
    bindEvents();

    if (!('DecompressionStream' in window)) {
      state.supportKey = 'support.noDecompression';
      el.supportNote.textContent = t(state.supportKey);
      el.pickBtn.disabled = true;
      return;
    }
    if (!window.showDirectoryPicker) {
      state.supportKey = 'support.noFsAccess';
      el.supportNote.textContent = t(state.supportKey);
      return;
    }
    try {
      const h = await idbGet('lastDir');
      if (h && h.kind === 'directory') {
        state.lastHandle = h;
        el.reopenBtn.textContent = t('toolbar.reopen', { name: h.name });
        el.reopenBtn.hidden = false;
        el.reopenBtn.addEventListener('click', run(async () => {
          const perm = await h.requestPermission({ mode: 'read' });
          if (perm !== 'granted') throw new Error(t('toast.permissionDenied'));
          await openFS(new GitFS.HandleFS(h));
        }));
      }
    } catch { /* sem IndexedDB: ignora */ }
  }

  init();
})();

/* Diff de linhas (Myers O(ND)) + montagem de hunks + destaque dentro da linha. */
(function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Retorna a sequência de operações (0 = igual, 1 = removida, 2 = adicionada) ou null se D > maxD.
  function myers(a, b, maxD) {
    const N = a.length, M = b.length, max = N + M;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
      if (d > maxD) return null;
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) {
          trace.push(v.slice(off - d, off + d + 1));
          return backtrack(trace, N, M);
        }
      }
      trace.push(v.slice(off - d, off + d + 1));
    }
    return null;
  }

  function backtrack(trace, N, M) {
    const ops = [];
    let x = N, y = M;
    for (let d = trace.length - 1; d > 0; d--) {
      const prev = trace[d - 1], pd = d - 1;
      const k = x - y;
      const prevK = k === -d || (k !== d && prev[k - 1 + pd] < prev[k + 1 + pd]) ? k + 1 : k - 1;
      const prevX = prev[prevK + pd];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push(0); x--; y--; }
      ops.push(x === prevX ? 2 : 1);
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) { ops.push(0); x--; y--; }
    return ops.reverse();
  }

  function diffSeq(a, b, maxD) {
    const n = a.length, m = b.length;
    let pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
    const ops = new Array(pre).fill(0);
    const mid = myers(A, B, maxD) || patience(A, B, maxD);
    for (const o of mid) ops.push(o);
    for (let i = 0; i < suf; i++) ops.push(0);
    return ops;
  }

  // Quando o Myers fica caro demais: ancora em elementos únicos nos dois lados
  // (maior subsequência crescente) e resolve os trechos entre âncoras recursivamente.
  function patience(A, B, maxD) {
    const count = new Map();
    for (let i = 0; i < A.length; i++) {
      const c = count.get(A[i]);
      count.set(A[i], c ? { a: c.a + 1, b: 0, i } : { a: 1, b: 0, i });
    }
    const pairs = [];
    for (let j = 0; j < B.length; j++) {
      const c = count.get(B[j]);
      if (c && c.a === 1) c.b++, (c.j = j);
    }
    for (const c of count.values()) if (c.a === 1 && c.b === 1) pairs.push([c.i, c.j]);
    pairs.sort((x, y) => x[0] - y[0]);

    // LIS sobre j (patience sorting).
    const tails = [], prev = new Int32Array(pairs.length);
    for (let p = 0; p < pairs.length; p++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tails[mid]][1] < pairs[p][1]) lo = mid + 1;
        else hi = mid;
      }
      prev[p] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = p;
    }
    const anchors = [];
    for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) anchors.push(pairs[p]);
    anchors.reverse();

    const ops = [];
    if (!anchors.length) {
      for (let i = 0; i < A.length; i++) ops.push(1);
      for (let j = 0; j < B.length; j++) ops.push(2);
      return ops;
    }
    let pa = 0, pb = 0;
    const seg = (ea, eb) => {
      for (const o of diffSeq(A.slice(pa, ea), B.slice(pb, eb), maxD)) ops.push(o);
    };
    for (const [i, j] of anchors) {
      seg(i, j);
      ops.push(0);
      pa = i + 1;
      pb = j + 1;
    }
    seg(A.length, B.length);
    return ops;
  }

  function diffLines(aLines, bLines) {
    const ids = new Map();
    const id = (l) => {
      let v = ids.get(l);
      if (v === undefined) ids.set(l, (v = ids.size));
      return v;
    };
    return diffSeq(aLines.map(id), bLines.map(id), 2000);
  }

  function splitLines(text) {
    if (text === '') return { lines: [], noEol: false };
    const lines = text.split('\n');
    const noEol = lines[lines.length - 1] !== '';
    if (!noEol) lines.pop();
    return { lines, noEol };
  }

  // Agrupa operações em hunks com `ctx` linhas de contexto.
  function buildHunks(ops, a, b, ctx = 3) {
    const n = ops.length;
    const aPos = new Int32Array(n + 1), bPos = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      aPos[i + 1] = aPos[i] + (ops[i] !== 2 ? 1 : 0);
      bPos[i + 1] = bPos[i] + (ops[i] !== 1 ? 1 : 0);
    }
    const hunks = [];
    let idx = 0;
    while (idx < n) {
      while (idx < n && ops[idx] === 0) idx++;
      if (idx >= n) break;
      const start = Math.max(0, idx - ctx);
      let j = idx, end = idx;
      while (j < n) {
        if (ops[j] !== 0) { j++; end = j; continue; }
        let k = j;
        while (k < n && ops[k] === 0) k++;
        if (k >= n || k - j > 2 * ctx) break;
        j = k;
      }
      const stop = Math.min(n, end + ctx);
      const lines = [];
      for (let i = start; i < stop; i++) {
        const t = ops[i];
        lines.push({
          t,
          o: t !== 2 ? aPos[i] + 1 : 0,
          n: t !== 1 ? bPos[i] + 1 : 0,
          text: t !== 2 ? a[aPos[i]] : b[bPos[i]],
        });
      }
      const oldLines = aPos[stop] - aPos[start], newLines = bPos[stop] - bPos[start];
      hunks.push({
        oldStart: oldLines ? aPos[start] + 1 : aPos[start],
        oldLines,
        newStart: newLines ? bPos[start] + 1 : bPos[start],
        newLines,
        lines,
      });
      idx = stop;
    }
    return hunks;
  }

  const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

  /* Palavras alteradas entre duas linhas.
   * Retorna [intervalosAntigo, intervalosNovo], cada um uma lista ordenada de [início, fim)
   * em caracteres, ou null quando as linhas são diferentes demais para valer o destaque. */
  function intraline(oldText, newText) {
    if (oldText.length > 1000 || newText.length > 1000) return null;
    const a = oldText.match(TOKEN) || [], b = newText.match(TOKEN) || [];
    const ops = diffSeq(a, b, 200);
    let same = 0, ai = 0, bi = 0, pa = 0, pb = 0;
    const ra = [], rb = [];
    const add = (ranges, start, end) => {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === start) last[1] = end;
      else ranges.push([start, end]);
    };
    for (const o of ops) {
      if (o === 0) {
        same += a[ai].length;
        pa += a[ai++].length;
        pb += b[bi++].length;
      } else if (o === 1) {
        add(ra, pa, (pa += a[ai++].length));
      } else {
        add(rb, pb, (pb += b[bi++].length));
      }
    }
    const total = Math.max(oldText.length, newText.length);
    if (total && same / total < 0.35) return null; // linhas muito diferentes: sem destaque
    return [ra, rb];
  }

  window.Diff = { diffSeq, diffLines, buildHunks, splitLines, intraline, escapeHtml };
})();

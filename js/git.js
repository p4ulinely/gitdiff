/* Leitor de repositórios git (somente leitura) em JS puro.
 * Suporta: objetos soltos, packfiles (idx v2, OFS_DELTA, REF_DELTA),
 * refs soltas, packed-refs, HEAD, tags anotadas, hashes abreviados e ~N / ^N.
 */
(function () {
  'use strict';

  const td = new TextDecoder('utf-8');
  const HEX = [];
  for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));
  const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

  function toHex(bytes, start, len) {
    let s = '';
    for (let i = start; i < start + len; i++) s += HEX[bytes[i]];
    return s;
  }

  function fromHex(hex) {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Erros carregam um código + parâmetros; a interface traduz (chave errors.<code>).
  class GitError extends Error {
    constructor(code, params = {}) {
      super(code);
      this.name = 'GitError';
      this.code = code;
      this.params = params;
    }
  }
  const fail = (code, params) => { throw new GitError(code, params); };
  const short = (sha) => String(sha).slice(0, 7);

  async function inflate(blob) {
    const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  class LRU {
    constructor(maxBytes) {
      this.max = maxBytes;
      this.size = 0;
      this.map = new Map();
    }
    get(k) {
      const e = this.map.get(k);
      if (!e) return undefined;
      this.map.delete(k);
      this.map.set(k, e);
      return e.v;
    }
    set(k, v, bytes) {
      if (bytes > this.max / 4 || this.map.has(k)) return;
      this.map.set(k, { v, bytes });
      this.size += bytes;
      while (this.size > this.max) {
        const [fk, fe] = this.map.entries().next().value;
        this.map.delete(fk);
        this.size -= fe.bytes;
      }
    }
  }

  function applyDelta(base, delta) {
    let i = 0;
    const varint = () => {
      let r = 0, shift = 0, c;
      do {
        c = delta[i++];
        r += (c & 0x7f) * Math.pow(2, shift);
        shift += 7;
      } while (c & 0x80);
      return r;
    };
    const baseSize = varint();
    const resultSize = varint();
    if (baseSize !== base.length) fail('deltaBaseMismatch');
    const out = new Uint8Array(resultSize);
    let o = 0;
    while (i < delta.length) {
      const op = delta[i++];
      if (op & 0x80) {
        let off = 0, size = 0;
        if (op & 0x01) off |= delta[i++];
        if (op & 0x02) off |= delta[i++] << 8;
        if (op & 0x04) off |= delta[i++] << 16;
        if (op & 0x08) off += delta[i++] * 16777216;
        if (op & 0x10) size |= delta[i++];
        if (op & 0x20) size |= delta[i++] << 8;
        if (op & 0x40) size |= delta[i++] << 16;
        if (size === 0) size = 0x10000;
        out.set(base.subarray(off, off + size), o);
        o += size;
      } else if (op) {
        out.set(delta.subarray(i, i + op), o);
        i += op;
        o += op;
      } else {
        fail('deltaOpcode');
      }
    }
    return out;
  }

  class Pack {
    constructor(name, idx, file) {
      this.name = name;
      this.file = file;
      this.idx = idx;
      const dv = (this.dv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength));
      if (dv.getUint32(0) !== 0xff744f63 || dv.getUint32(4) !== 2) {
        fail('unsupportedIndex', { file: name + '.idx' });
      }
      this.count = dv.getUint32(8 + 255 * 4);
      this.shaOff = 8 + 256 * 4;
      this.offOff = this.shaOff + this.count * 24; // 20 (sha) + 4 (crc) por objeto
      this.largeOff = this.offOff + this.count * 4;
      this.packEnd = file.size - 20;
      this._sorted = null;
    }

    fanout(b) {
      return b < 0 ? 0 : this.dv.getUint32(8 + b * 4);
    }

    offsetAt(i) {
      const o = this.dv.getUint32(this.offOff + i * 4);
      if (o & 0x80000000) {
        const p = this.largeOff + (o & 0x7fffffff) * 8;
        return this.dv.getUint32(p) * 4294967296 + this.dv.getUint32(p + 4);
      }
      return o;
    }

    find(hex) {
      const first = parseInt(hex.slice(0, 2), 16);
      let lo = this.fanout(first - 1), hi = this.fanout(first);
      const target = fromHex(hex);
      const idx = this.idx;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const base = this.shaOff + mid * 20;
        let c = 0;
        for (let j = 0; j < 20 && c === 0; j++) c = idx[base + j] - target[j];
        if (c === 0) return this.offsetAt(mid);
        if (c < 0) lo = mid + 1;
        else hi = mid;
      }
      return -1;
    }

    findPrefix(prefix) {
      const b = parseInt(prefix.slice(0, 2), 16);
      const out = [];
      for (let i = this.fanout(b - 1), hi = this.fanout(b); i < hi; i++) {
        const h = toHex(this.idx, this.shaOff + i * 20, 20);
        if (h.startsWith(prefix)) out.push(h);
      }
      return out;
    }

    // O fim dos dados comprimidos de um objeto é o início do próximo.
    nextOffset(off) {
      if (!this._sorted) {
        const a = new Float64Array(this.count);
        for (let i = 0; i < this.count; i++) a[i] = this.offsetAt(i);
        a.sort();
        this._sorted = a;
      }
      const a = this._sorted;
      let lo = 0, hi = a.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (a[m] <= off) lo = m + 1;
        else hi = m;
      }
      return lo < a.length ? a[lo] : this.packEnd;
    }
  }

  function parsePerson(s) {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(s || '');
    if (!m) return { name: s || '', email: '', time: 0, tz: '+0000' };
    return { name: m[1], email: m[2], time: +m[3], tz: m[4] };
  }

  function parseCommit(sha, data) {
    const text = td.decode(data);
    const sep = text.indexOf('\n\n');
    const head = sep < 0 ? text : text.slice(0, sep);
    const c = { sha, tree: null, parents: [], author: null, committer: null, message: sep < 0 ? '' : text.slice(sep + 2) };
    for (const line of head.split('\n')) {
      if (line.startsWith(' ')) continue; // continuação (ex.: gpgsig)
      const sp = line.indexOf(' ');
      const key = line.slice(0, sp), val = line.slice(sp + 1);
      if (key === 'tree') c.tree = val;
      else if (key === 'parent') c.parents.push(val);
      else if (key === 'author') c.author = parsePerson(val);
      else if (key === 'committer') c.committer = parsePerson(val);
    }
    if (!c.author) c.author = parsePerson('');
    if (!c.committer) c.committer = c.author;
    return c;
  }

  function parseTree(data) {
    const entries = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const nul = data.indexOf(0, sp);
      entries.push({
        mode: td.decode(data.subarray(i, sp)),
        name: td.decode(data.subarray(sp + 1, nul)),
        sha: toHex(data, nul + 1, 20),
      });
      i = nul + 21;
    }
    return entries;
  }

  const isTree = (e) => e && e.mode === '40000';

  class Repo {
    constructor(fs, gitDir) {
      this.fs = fs;
      this.gitDir = gitDir;
      this.packs = [];
      this.cache = new LRU(128 * 1024 * 1024);
      this.commits = new Map();
      this.trees = new Map();
    }

    static async open(fs) {
      let gitDir;
      if (await fs.getFile('.git/HEAD')) gitDir = '.git/';
      else if ((await fs.getFile('HEAD')) && (await fs.list('objects')).length) gitDir = '';
      else if (await fs.getFile('.git')) fail('worktree');
      else fail('notARepo');
      const repo = new Repo(fs, gitDir);
      await repo.loadPacks();
      return repo;
    }

    p(path) {
      return this.gitDir + path;
    }

    async readText(path) {
      const f = await this.fs.getFile(this.p(path));
      return f ? await f.text() : null;
    }

    async loadPacks() {
      const entries = await this.fs.list(this.p('objects/pack'));
      const names = new Set(entries.map((e) => e.name));
      const packs = await Promise.all(
        entries
          .filter((e) => e.name.endsWith('.idx') && names.has(e.name.slice(0, -4) + '.pack'))
          .map(async (e) => {
            const base = e.name.slice(0, -4);
            const [idxFile, packFile] = await Promise.all([
              this.fs.getFile(this.p('objects/pack/' + e.name)),
              this.fs.getFile(this.p('objects/pack/' + base + '.pack')),
            ]);
            if (!idxFile || !packFile) return null;
            return new Pack(base, new Uint8Array(await idxFile.arrayBuffer()), packFile);
          })
      );
      this.packs = packs.filter(Boolean);
    }

    async readObject(sha) {
      for (const pack of this.packs) {
        const off = pack.find(sha);
        if (off >= 0) return this.readPacked(pack, off);
      }
      const hit = this.cache.get(sha);
      if (hit) return hit;
      const f = await this.fs.getFile(this.p(`objects/${sha.slice(0, 2)}/${sha.slice(2)}`));
      if (!f) fail('objectNotFound', { sha: sha.slice(0, 10) });
      const raw = await inflate(f);
      const nul = raw.indexOf(0);
      const type = td.decode(raw.subarray(0, nul)).split(' ')[0];
      const obj = { type, data: raw.subarray(nul + 1) };
      this.cache.set(sha, obj, obj.data.length + 64);
      return obj;
    }

    async readPacked(pack, offset) {
      const key = pack.name + '@' + offset;
      const hit = this.cache.get(key);
      if (hit) return hit;

      const head = new Uint8Array(await pack.file.slice(offset, offset + 64).arrayBuffer());
      let i = 0;
      let c = head[i++];
      const type = (c >> 4) & 7;
      while (c & 0x80) c = head[i++]; // tamanho (não precisamos dele)

      let baseOffset = -1, baseSha = null;
      if (type === 6) {
        c = head[i++];
        let off = c & 0x7f;
        while (c & 0x80) {
          c = head[i++];
          off = (off + 1) * 128 + (c & 0x7f);
        }
        baseOffset = offset - off;
      } else if (type === 7) {
        baseSha = toHex(head, i, 20);
        i += 20;
      }

      const data = await inflate(pack.file.slice(offset + i, pack.nextOffset(offset)));
      let obj;
      if (type === 6) {
        const base = await this.readPacked(pack, baseOffset);
        obj = { type: base.type, data: applyDelta(base.data, data) };
      } else if (type === 7) {
        const base = await this.readObject(baseSha);
        obj = { type: base.type, data: applyDelta(base.data, data) };
      } else if (TYPE_NAMES[type]) {
        obj = { type: TYPE_NAMES[type], data };
      } else {
        fail('unknownPackType', { type });
      }
      this.cache.set(key, obj, obj.data.length + 64);
      return obj;
    }

    async readCommit(sha) {
      let c = this.commits.get(sha);
      if (c) return c;
      const o = await this.readObject(sha);
      if (o.type !== 'commit') fail('notACommit', { sha: short(sha), type: o.type });
      c = parseCommit(sha, o.data);
      this.commits.set(sha, c);
      return c;
    }

    async readTree(sha) {
      let t = this.trees.get(sha);
      if (t) return t;
      const o = await this.readObject(sha);
      if (o.type !== 'tree') fail('notATree', { sha: short(sha) });
      t = parseTree(o.data);
      if (this.trees.size > 20000) this.trees.clear();
      this.trees.set(sha, t);
      return t;
    }

    async readBlob(sha) {
      const o = await this.readObject(sha);
      if (o.type !== 'blob') fail('notABlob', { sha: short(sha) });
      return o.data;
    }

    async peelToCommit(sha) {
      for (let n = 0; n < 20; n++) {
        const o = await this.readObject(sha);
        if (o.type === 'commit') return sha;
        if (o.type !== 'tag') fail('notCommitish', { sha: short(sha), type: o.type });
        const m = /^object ([0-9a-f]{40})/m.exec(td.decode(o.data));
        if (!m) fail('invalidTag');
        sha = m[1];
      }
      fail('tagChainTooLong');
    }

    async listRefs() {
      const refs = new Map();
      const packed = await this.readText('packed-refs');
      if (packed) {
        for (const line of packed.split('\n')) {
          if (!line || line[0] === '#' || line[0] === '^') continue;
          const sp = line.indexOf(' ');
          refs.set(line.slice(sp + 1).trim(), line.slice(0, sp));
        }
      }
      const walk = async (dir) => {
        for (const e of await this.fs.list(this.p(dir))) {
          const path = dir + '/' + e.name;
          if (e.kind === 'directory') await walk(path);
          else {
            const t = ((await this.readText(path)) || '').trim();
            if (/^[0-9a-f]{40}$/.test(t)) refs.set(path, t);
          }
        }
      };
      await walk('refs');
      if (!refs.size && (await this.fs.list(this.p('reftable'))).length) {
        fail('reftable');
      }
      return refs;
    }

    async readHead() {
      const t = ((await this.readText('HEAD')) || '').trim();
      if (t.startsWith('ref: ')) return { ref: t.slice(5).trim() };
      return { sha: t };
    }

    async findByPrefix(prefix) {
      const out = new Set();
      for (const p of this.packs) for (const s of p.findPrefix(prefix)) out.add(s);
      const d = prefix.slice(0, 2);
      for (const e of await this.fs.list(this.p('objects/' + d))) {
        if (e.kind === 'file' && (d + e.name).startsWith(prefix)) out.add(d + e.name);
      }
      return [...out];
    }

    async resolveBase(s) {
      if (/^[0-9a-fA-F]{40}$/.test(s)) return this.peelToCommit(s.toLowerCase());
      if (/^[0-9a-fA-F]{4,39}$/.test(s)) {
        const matches = await this.findByPrefix(s.toLowerCase());
        if (matches.length === 1) return this.peelToCommit(matches[0]);
        if (matches.length > 1) {
          const commits = [];
          for (const m of matches) {
            try {
              if ((await this.readObject(m)).type === 'commit') commits.push(m);
            } catch { /* ignora */ }
          }
          if (commits.length === 1) return commits[0];
          fail('ambiguous', { ref: s, count: matches.length });
        }
      }
      const refs = await this.listRefs();
      if (s === 'HEAD' || s === '@') {
        const h = await this.readHead();
        const sha = h.sha || refs.get(h.ref);
        if (sha) return this.peelToCommit(sha);
      }
      for (const name of [s, 'refs/' + s, 'refs/heads/' + s, 'refs/tags/' + s, 'refs/remotes/' + s]) {
        if (refs.has(name)) return this.peelToCommit(refs.get(name));
      }
      fail('commitNotFound', { ref: s });
    }

    // Aceita hash completo/abreviado, nome de branch/tag e sufixos ~N / ^N.
    async resolve(input) {
      const s = input.trim();
      if (!s) fail('emptyRef');
      const m = /^(.+?)((?:[~^]\d*)*)$/.exec(s);
      let sha = await this.resolveBase(m[1]);
      for (const [, op, num] of m[2].matchAll(/([~^])(\d*)/g)) {
        const n = num === '' ? 1 : +num;
        if (op === '~') {
          for (let k = 0; k < n; k++) {
            sha = (await this.readCommit(sha)).parents[0];
            if (!sha) fail('beyondRoot', { ref: s });
          }
        } else if (n > 0) {
          sha = (await this.readCommit(sha)).parents[n - 1];
          if (!sha) fail('noSuchParent', { ref: s, n });
        }
      }
      return sha;
    }

    async diffTrees(oldSha, newSha, prefix = '', out = []) {
      const [a, b] = await Promise.all([oldSha ? this.readTree(oldSha) : [], newSha ? this.readTree(newSha) : []]);
      const am = new Map(a.map((e) => [e.name, e]));
      const bm = new Map(b.map((e) => [e.name, e]));
      const names = new Set([...am.keys(), ...bm.keys()]);
      const add = (e, path) => out.push({ status: 'A', path, newSha: e.sha, newMode: e.mode, oldSha: null, oldMode: null });
      const del = (e, path) => out.push({ status: 'D', path, oldSha: e.sha, oldMode: e.mode, newSha: null, newMode: null });
      for (const name of names) {
        const x = am.get(name), y = bm.get(name);
        if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
        const path = prefix + name;
        if (isTree(x) || isTree(y)) {
          if (isTree(x) && isTree(y)) {
            await this.diffTrees(x.sha, y.sha, path + '/', out);
            continue;
          }
          if (isTree(x)) await this.diffTrees(x.sha, null, path + '/', out);
          else if (x) del(x, path);
          if (isTree(y)) await this.diffTrees(null, y.sha, path + '/', out);
          else if (y) add(y, path);
          continue;
        }
        if (x && y) out.push({ status: 'M', path, oldSha: x.sha, oldMode: x.mode, newSha: y.sha, newMode: y.mode });
        else if (x) del(x, path);
        else add(y, path);
      }
      return out;
    }

    async diffCommit(commit, parentIndex = 0) {
      let oldTree = null;
      const parent = commit.parents[parentIndex];
      if (parent) {
        try {
          oldTree = (await this.readCommit(parent)).tree;
        } catch {
          oldTree = null; // clone raso: pai ausente
        }
      }
      return this.diffTreesWithRenames(oldTree, commit.tree);
    }

    // Diferença entre duas árvores (qualquer uma pode ser null), com renomeações exatas, ordenada por caminho.
    async diffTreesWithRenames(oldTree, newTree) {
      const changes = await this.diffTrees(oldTree, newTree);
      // Renomeações exatas (mesmo conteúdo, caminho diferente).
      const deleted = new Map();
      for (const c of changes) if (c.status === 'D' && c.oldMode !== '160000' && !deleted.has(c.oldSha)) deleted.set(c.oldSha, c);
      const removed = new Set();
      for (const c of changes) {
        if (c.status !== 'A') continue;
        const d = deleted.get(c.newSha);
        if (!d) continue;
        deleted.delete(c.newSha);
        removed.add(d);
        c.status = 'R';
        c.oldPath = d.path;
        c.oldSha = d.oldSha;
        c.oldMode = d.oldMode;
      }
      const result = await this.detectSimilarRenames(changes.filter((c) => !removed.has(c)));
      return result.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    }

    /* Renomeações com alteração de conteúdo, como o git (limiar padrão de 50%).
     * Pontuação de um par removido→adicionado = bytes de linhas em comum / tamanho do maior.
     * Os pares são atribuídos do mais parecido para o menos.
     *
     * Custo: cada linha vira um inteiro uma única vez e cada arquivo vira um vetor ordenado,
     * então um par é só a intersecção de dois vetores de inteiros. Mesmo assim, como no
     * diff.renameLimit do git, há limites: até RENAME_PAIRS pares e um orçamento de trabalho
     * (WORK_BUDGET elementos comparados). Acima disso ficam só as renomeações exatas.
     * Binários, vazios e arquivos acima de 1 MB são ignorados. */
    async detectSimilarRenames(changes, threshold = 0.5) {
      const RENAME_PAIRS = 2500, MAX = 1024 * 1024, WORK_BUDGET = 15e6;
      const dels = changes.filter((c) => c.status === 'D' && c.oldMode !== '160000');
      const adds = changes.filter((c) => c.status === 'A' && c.newMode !== '160000');
      if (!dels.length || !adds.length || dels.length * adds.length > RENAME_PAIRS) return changes;

      // 1) bytes e número de linhas (contar '\n' nos bytes é barato; decodificar não é)
      const read = async (sha) => {
        let b;
        try {
          b = await this.readBlob(sha);
        } catch {
          return null;
        }
        if (!b.length || b.length > MAX || b.subarray(0, 8000).includes(0)) return null;
        let lines = 1;
        for (let k = 0; k < b.length; k++) if (b[k] === 10) lines++;
        return { size: b.length, bytes: b, lines };
      };
      const [D, N] = await Promise.all([Promise.all(dels.map((c) => read(c.oldSha))), Promise.all(adds.map((c) => read(c.newSha)))]);

      // 2) pares que podem chegar ao limiar (tamanhos compatíveis) e o trabalho estimado
      const cand = [];
      let work = 0;
      for (let i = 0; i < dels.length; i++) {
        if (!D[i]) continue;
        for (let j = 0; j < adds.length; j++) {
          if (!N[j]) continue;
          if (Math.min(D[i].size, N[j].size) / Math.max(D[i].size, N[j].size) < threshold) continue;
          cand.push(i, j);
          work += D[i].lines + N[j].lines;
        }
      }
      if (!cand.length || work > WORK_BUDGET) return changes; // acima do orçamento: só renomeações exatas

      // 3) só agora decodifica: cada linha vira um inteiro, cada arquivo um vetor ordenado
      const ids = new Map(), idLen = [];
      const vectorize = (f) => {
        if (!f || f.v) return;
        const lines = td.decode(f.bytes).split('\n');
        const v = new Int32Array(lines.length);
        for (let k = 0; k < lines.length; k++) {
          let id = ids.get(lines[k]);
          if (id === undefined) {
            id = ids.size;
            ids.set(lines[k], id);
            idLen.push(lines[k].length + 1);
          }
          v[k] = id;
        }
        f.v = v.sort();
        f.bytes = null;
      };
      for (let c = 0; c < cand.length; c += 2) {
        vectorize(D[cand[c]]);
        vectorize(N[cand[c + 1]]);
      }

      const pairs = [];
      for (let c = 0; c < cand.length; c += 2) {
        const i = cand[c], j = cand[c + 1];
        const a = D[i].v, b = N[j].v;
        let x = 0, y = 0, same = 0;
        while (x < a.length && y < b.length) { // intersecção de multiconjuntos ordenados
          if (a[x] === b[y]) { same += idLen[a[x]]; x++; y++; }
          else if (a[x] < b[y]) x++;
          else y++;
        }
        const score = Math.min(1, same / Math.max(D[i].size, N[j].size));
        if (score >= threshold) pairs.push({ i, j, score });
      }
      if (!pairs.length) return changes;
      pairs.sort((x, y) => y.score - x.score);
      const usedD = new Set(), usedA = new Set();
      for (const { i, j, score } of pairs) {
        if (usedD.has(i) || usedA.has(j)) continue;
        usedD.add(i);
        usedA.add(j);
        const a = adds[j], d = dels[i];
        a.status = 'R';
        a.oldPath = d.path;
        a.oldSha = d.oldSha;
        a.oldMode = d.oldMode;
        a.similarity = Math.floor(score * 100);
      }
      const gone = new Set([...usedD].map((i) => dels[i]));
      return changes.filter((c) => !gone.has(c));
    }

    // Alvo de uma ref simbólica (ex.: refs/remotes/origin/HEAD → refs/remotes/origin/main), ou null.
    async readSymbolicRef(name) {
      const t = ((await this.readText(name)) || '').trim();
      return t.startsWith('ref: ') ? t.slice(5).trim() : null;
    }

    /* Compara duas pontas como "git log base..head" / "head..base" + "git merge-base".
     *
     * Percorre os dois históricos ao mesmo tempo, do commit mais recente para o mais antigo,
     * marcando cada commit com quem o alcança (A = base, B = head). Um commit marcado pelos
     * dois é comum; o primeiro comum ainda não "coberto" por outro comum é o ancestral comum
     * (como o paint_down_to_common do git). Para quando só restam comuns já cobertos.
     *
     * Retorna { ahead: [commits só do head], behind: [commits só da base], mergeBase, mergeBases, truncated }. */
    async compareTips(baseSha, headSha, limit = 20000) {
      const A = 1, B = 2, BOTH = 3, STALE = 4;
      const flags = new Map(), queued = new Set(), queue = [], visited = [];
      const mergeBases = [];
      const insert = (c) => {
        const t = c.committer.time;
        let lo = 0, hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (queue[mid].committer.time >= t) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, c);
      };
      const mark = async (sha, f) => {
        const old = flags.get(sha) || 0;
        if ((old | f) === old) return;
        flags.set(sha, old | f);
        if (queued.has(sha)) return; // já na fila: as marcas novas valem quando sair
        let c;
        try {
          c = await this.readCommit(sha);
        } catch {
          return; // clone raso: pai ausente
        }
        if (queued.has(sha)) return;
        queued.add(sha);
        insert(c); // também reinsere um commit já visitado que ganhou marca nova (relógios fora de ordem)
      };
      const done = () => queue.every((c) => (flags.get(c.sha) & (BOTH | STALE)) === (BOTH | STALE));

      await Promise.all([mark(baseSha, A), mark(headSha, B)]);
      let steps = 0, truncated = false;
      while (queue.length && !done()) {
        if (++steps > limit) { truncated = true; break; }
        const c = queue.shift();
        queued.delete(c.sha);
        let f = flags.get(c.sha);
        if ((f & BOTH) === BOTH && !(f & STALE)) {
          mergeBases.push(c.sha);
          f |= STALE; // ancestrais de um ancestral comum não são "melhores"
          flags.set(c.sha, f);
        }
        visited.push(c);
        const pf = (f & BOTH) === BOTH ? f | STALE : f;
        await Promise.all(c.parents.map((p) => mark(p, pf)));
      }

      // Classifica pelas marcas finais (um commit pode ter ganho a outra marca depois de visitado).
      const seen = new Set(), ahead = [], behind = [];
      for (const c of visited) {
        if (seen.has(c.sha)) continue;
        seen.add(c.sha);
        const f = flags.get(c.sha) & BOTH;
        if (f === B) ahead.push(c);
        else if (f === A) behind.push(c);
      }
      return { ahead, behind, mergeBase: mergeBases[0] || null, mergeBases, truncated };
    }
  }

  // Percorre o histórico em ordem de data do committer (como `git log`).
  class LogWalker {
    constructor(repo, tips) {
      this.repo = repo;
      this.queue = [];
      this.seen = new Set();
      this.started = false;
      this.ready = Promise.all(tips.map((t) => this.push(t)));
    }

    async push(sha) {
      if (this.seen.has(sha)) return;
      this.seen.add(sha);
      let c;
      try {
        c = await this.repo.readCommit(sha);
      } catch {
        return; // pai ausente (clone raso)
      }
      const t = c.committer.time;
      let lo = 0, hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.queue[mid].committer.time >= t) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, c);
    }

    async next(n) {
      await this.ready;
      this.started = true;
      const out = [];
      while (out.length < n && this.queue.length) {
        const c = this.queue.shift();
        out.push(c);
        await Promise.all(c.parents.map((p) => this.push(p)));
      }
      return out;
    }

    get done() {
      return this.started && this.queue.length === 0;
    }
  }

  window.Git = { Repo, LogWalker, GitError };
})();

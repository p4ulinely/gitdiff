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
    if (baseSize !== base.length) throw new Error('Delta inválido: tamanho da base não confere');
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
        throw new Error('Delta inválido: opcode 0');
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
        throw new Error(`Formato de índice não suportado: ${name}.idx`);
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
      else if (await fs.getFile('.git')) {
        throw new Error('Esta pasta é um worktree ou submódulo (o arquivo .git aponta para outro lugar). Abra o repositório principal.');
      } else {
        throw new Error('Nenhum repositório git encontrado nesta pasta (não há .git).');
      }
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
      if (!f) throw new Error(`Objeto não encontrado: ${sha.slice(0, 10)} (clone raso ou parcial?)`);
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
        throw new Error(`Tipo de objeto desconhecido no pack: ${type}`);
      }
      this.cache.set(key, obj, obj.data.length + 64);
      return obj;
    }

    async readCommit(sha) {
      let c = this.commits.get(sha);
      if (c) return c;
      const o = await this.readObject(sha);
      if (o.type !== 'commit') throw new Error(`${sha.slice(0, 7)} não é um commit (${o.type})`);
      c = parseCommit(sha, o.data);
      this.commits.set(sha, c);
      return c;
    }

    async readTree(sha) {
      let t = this.trees.get(sha);
      if (t) return t;
      const o = await this.readObject(sha);
      if (o.type !== 'tree') throw new Error(`${sha.slice(0, 7)} não é uma árvore`);
      t = parseTree(o.data);
      if (this.trees.size > 20000) this.trees.clear();
      this.trees.set(sha, t);
      return t;
    }

    async readBlob(sha) {
      const o = await this.readObject(sha);
      if (o.type !== 'blob') throw new Error(`${sha.slice(0, 7)} não é um blob`);
      return o.data;
    }

    async peelToCommit(sha) {
      for (let n = 0; n < 20; n++) {
        const o = await this.readObject(sha);
        if (o.type === 'commit') return sha;
        if (o.type !== 'tag') throw new Error(`${sha.slice(0, 7)} aponta para um ${o.type}, não para um commit`);
        const m = /^object ([0-9a-f]{40})/m.exec(td.decode(o.data));
        if (!m) throw new Error('Tag inválida');
        sha = m[1];
      }
      throw new Error('Cadeia de tags longa demais');
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
        throw new Error('Este repositório usa o formato "reftable", que ainda não é suportado.');
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
          throw new Error(`Hash ambíguo "${s}": ${matches.length} objetos começam com ele.`);
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
      throw new Error(`Commit não encontrado: "${s}"`);
    }

    // Aceita hash completo/abreviado, nome de branch/tag e sufixos ~N / ^N.
    async resolve(input) {
      const s = input.trim();
      if (!s) throw new Error('Informe um hash de commit.');
      const m = /^(.+?)((?:[~^]\d*)*)$/.exec(s);
      let sha = await this.resolveBase(m[1]);
      for (const [, op, num] of m[2].matchAll(/([~^])(\d*)/g)) {
        const n = num === '' ? 1 : +num;
        if (op === '~') {
          for (let k = 0; k < n; k++) {
            sha = (await this.readCommit(sha)).parents[0];
            if (!sha) throw new Error(`"${s}" vai além do primeiro commit.`);
          }
        } else if (n > 0) {
          sha = (await this.readCommit(sha)).parents[n - 1];
          if (!sha) throw new Error(`"${s}": o commit não tem o pai ${n}.`);
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
      const changes = await this.diffTrees(oldTree, commit.tree);
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
      return changes.filter((c) => !removed.has(c)).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
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

  window.Git = { Repo, LogWalker };
})();

/* Abstração de sistema de arquivos somente-leitura.
 * - HandleFS: usa a File System Access API (showDirectoryPicker) — Chrome/Edge.
 * - FileListFS: usa <input webkitdirectory> como alternativa (Firefox/Safari).
 * Interface: getFile(path) -> File|null, list(path) -> [{name, kind}]
 */
(function () {
  'use strict';

  class HandleFS {
    constructor(handle) {
      this.handle = handle;
      this.name = handle.name;
      this.dirs = new Map([['', handle]]);
    }

    async dir(path) {
      path = path.replace(/\/+$/, '');
      const cached = this.dirs.get(path);
      if (cached) return cached;
      const i = path.lastIndexOf('/');
      const parent = await this.dir(i < 0 ? '' : path.slice(0, i));
      const h = await parent.getDirectoryHandle(path.slice(i + 1));
      this.dirs.set(path, h);
      return h;
    }

    async getFile(path) {
      const i = path.lastIndexOf('/');
      try {
        const d = await this.dir(i < 0 ? '' : path.slice(0, i));
        const fh = await d.getFileHandle(path.slice(i + 1));
        return await fh.getFile();
      } catch {
        return null;
      }
    }

    async list(path) {
      try {
        const d = await this.dir(path);
        const out = [];
        for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind });
        return out;
      } catch {
        return [];
      }
    }
  }

  class FileListFS {
    constructor(fileList) {
      const all = Array.from(fileList);
      this.name = all.length ? all[0].webkitRelativePath.split('/')[0] : '';
      let entries = all.map((f) => {
        const rel = f.webkitRelativePath;
        return [rel.slice(rel.indexOf('/') + 1), f];
      });
      // Se a pasta escolhida contém .git, mantemos só o que interessa.
      const gitOnly = entries.filter(([p]) => p.startsWith('.git/'));
      if (gitOnly.length) entries = gitOnly;

      this.files = new Map(entries);
      this.children = new Map();
      for (const [p] of entries) {
        const parts = p.split('/');
        let dir = '';
        for (let i = 0; i < parts.length; i++) {
          let m = this.children.get(dir);
          if (!m) this.children.set(dir, (m = new Map()));
          if (!m.has(parts[i])) m.set(parts[i], i === parts.length - 1 ? 'file' : 'directory');
          dir = dir ? dir + '/' + parts[i] : parts[i];
        }
      }
    }

    async getFile(path) {
      return this.files.get(path) || null;
    }

    async list(path) {
      const m = this.children.get(path.replace(/\/+$/, ''));
      return m ? [...m].map(([name, kind]) => ({ name, kind })) : [];
    }
  }

  window.GitFS = { HandleFS, FileListFS };
})();

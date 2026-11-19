/* Comparação de branches para PR: alterações do PR (ancestral comum → compare) e
 * previsão de conflitos com a base.
 *
 * A previsão é uma estimativa, não um merge de verdade. Para cada arquivo alterado nos
 * DOIS lados desde o ancestral comum, as regiões de linhas alteradas (em coordenadas do
 * ancestral) são comparadas: regiões que se sobrepõem ou se encostam conflitam, como no
 * merge de 3 vias do git, exceto quando os dois lados fizeram exatamente a mesma alteração.
 * Não depende do DOM.
 */
(function () {
  'use strict';

  const td = new TextDecoder('utf-8');
  const MAX_BYTES = 4 * 1024 * 1024;

  const isBinary = (bytes) => {
    for (let i = 0, n = Math.min(bytes.length, 8000); i < n; i++) if (bytes[i] === 0) return true;
    return false;
  };

  /* Regiões alteradas de "ancestral → lado", a partir das operações do diff de linhas.
   * Cada região: a1..a2 (intervalo [a1, a2) no ancestral; vazio = inserção na posição a1),
   * b1..b2 (o mesmo trecho no lado) e o texto novo, para reconhecer alterações idênticas. */
  function regions(ops, sideLines) {
    const out = [];
    let a = 0, b = 0, i = 0;
    while (i < ops.length) {
      if (ops[i] === 0) { a++; b++; i++; continue; }
      const r = { a1: a, b1: b };
      while (i < ops.length && ops[i] !== 0) {
        if (ops[i] === 1) a++;
        else b++;
        i++;
      }
      r.a2 = a;
      r.b2 = b;
      r.text = sideLines.slice(r.b1, r.b2).join('\n');
      out.push(r);
    }
    return out;
  }

  // Sobreposição ou encosto (sem linha comum entre as duas alterações), como o xdiff do git.
  const touches = (x, y) => x.a1 <= y.a2 && y.a1 <= x.a2;
  const sameEdit = (x, y) => x.a1 === y.a1 && x.a2 === y.a2 && x.text === y.text;

  function splitKeys(text) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    else if (lines.length) lines[lines.length - 1] += '\u0000'; // sem \n final também é alteração
    return lines;
  }

  /* Conflitos de conteúdo entre as versões do ancestral (o), da base (b) e do compare (h).
   * Retorna os trechos em conflito em números de linha do compare: [{ start, end }]. */
  function contentConflicts(oText, bText, hText) {
    const O = splitKeys(oText), Bl = splitKeys(bText), H = splitKeys(hText);
    const rb = regions(Diff.diffLines(O, Bl), Bl);
    const rh = regions(Diff.diffLines(O, H), H);
    const out = [];
    let j = 0;
    for (const x of rh) {
      while (j < rb.length && rb[j].a2 < x.a1) j++; // regiões ordenadas: pula as que terminam antes
      for (let k = j; k < rb.length && rb[k].a1 <= x.a2; k++) {
        if (touches(x, rb[k]) && !sameEdit(x, rb[k])) {
          // linhas do compare; inserção pura vira a linha onde entrou
          out.push({ start: x.b1 + 1, end: Math.max(x.b1 + 1, x.b2) });
          break;
        }
      }
    }
    return out;
  }

  /* Analisa os arquivos do PR (headChanges: ancestral → compare) contra as alterações da base
   * (ancestral → base). Grava em cada item de headChanges afetado:
   *   ch.conflict = { kind, conflict: boolean, ranges?: [{start, end}] }
   * kind: content | modifyDelete | addAdd | renameRename | binary | clean (alterado nos dois, sem conflito)
   * Retorna { conflicts, clean } (contagens). */
  async function analyze(repo, mbTree, baseTree, headChanges) {
    const baseChanges = await repo.diffTreesWithRenames(mbTree, baseTree);
    // Índice pelo caminho no ancestral (renomeação/remoção) e pelo caminho novo (adição).
    const byOld = new Map(), byNew = new Map();
    for (const c of baseChanges) {
      if (c.status === 'A') byNew.set(c.path, c);
      else byOld.set(c.oldPath || c.path, c);
    }
    const read = (sha) => (sha ? repo.readBlob(sha) : Promise.resolve(new Uint8Array(0)));
    let conflicts = 0, clean = 0;

    for (const h of headChanges) {
      delete h.conflict;
      const b = h.status === 'A' ? byNew.get(h.path) : byOld.get(h.oldPath || h.path);
      if (!b) continue;
      const set = (kind, extra) => {
        h.conflict = { kind, conflict: kind !== 'clean', ...extra };
        if (kind === 'clean') clean++;
        else conflicts++;
      };
      // Os dois lados chegaram ao mesmo resultado: nada a resolver.
      if (b.path === h.path && b.newSha === h.newSha && b.newMode === h.newMode) continue;
      if (h.status === 'D' && b.status === 'D') continue;
      if (h.status === 'D' || b.status === 'D') { set('modifyDelete'); continue; }
      // Renomeado para caminhos diferentes nos dois lados. Se só um lado renomeou, o git
      // acompanha a renomeação e o conteúdo ainda é comparado abaixo.
      if (h.status === 'R' && b.status === 'R' && b.path !== h.path) { set('renameRename'); continue; }
      if (h.newMode === '160000' || b.newMode === '160000') { set('binary'); continue; }
      if (b.newSha === h.newSha) { set('clean'); continue; } // mesmo conteúdo, só modo/caminho diferente

      const [o, bb, hh] = await Promise.all([read(h.status === 'A' ? null : h.oldSha), read(b.newSha), read(h.newSha)]);
      if (isBinary(o) || isBinary(bb) || isBinary(hh)) { set('binary'); continue; }
      if (o.length + bb.length + hh.length > MAX_BYTES) { set('content', { ranges: [], large: true }); continue; }
      const ranges = contentConflicts(td.decode(o), td.decode(bb), td.decode(hh));
      if (ranges.length) set(h.status === 'A' ? 'addAdd' : 'content', { ranges });
      else set('clean');
    }
    return { conflicts, clean };
  }

  window.Compare = { analyze, contentConflicts, regions };
})();

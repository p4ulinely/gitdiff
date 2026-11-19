# gitdiff

Visualizador de diferenças git que roda no navegador e é estático. O `.git` é lido direto pelo navegador, sem servidor e sem chamar o binário `git`. Converse com o usuário em português.

## Restrições do projeto

- **JavaScript puro, sem dependências, sem build, sem npm.** Não adicione frameworks nem bibliotecas.
- **Scripts clássicos, não ES modules.** A página precisa funcionar aberta via `file://`, onde `import` é bloqueado por CORS. Cada arquivo é uma IIFE que expõe um global (`GitFS`, `Git`, `Diff`, `Compare`, `Highlight`, `I18n`).
- **A ordem dos `<script>` no `index.html` importa:** `i18n.js` → `locales/*.js` → `fs.js` → `git.js` → `diff.js` → `compare.js` → `highlight.js` → `app.js`.
- APIs do navegador usadas: File System Access API (`showDirectoryPicker`), com `<input webkitdirectory>` como alternativa; `DecompressionStream('deflate')` para o zlib; `Intl`; IndexedDB para lembrar a última pasta; `localStorage` para preferências (chaves com prefixo `gitdiff:`).

## Arquitetura

| Arquivo | Papel |
|---|---|
| `js/fs.js` | Interface mínima de FS: `getFile(path) → File\|null` e `list(path) → [{name, kind}]`. Implementações `HandleFS` e `FileListFS`. |
| `js/git.js` | `Repo`: objetos soltos, packfiles (idx v2, OFS/REF_DELTA), refs, packed-refs, `resolve()` (hash abreviado, refs, `~N`/`^N`), `diffTrees`, `diffTreesWithRenames`/`diffCommit` (renomeações exatas + por similaridade ≥ 50%, como o git), `compareTips` (ahead/behind + merge-base). `LogWalker`: histórico por data do committer. |
| `js/compare.js` | Previsão de conflitos de um PR (`Compare.analyze`). Não depende do DOM. |
| `js/diff.js` | Myers O(ND) com limite `maxD`. Acima dele usa o fallback *patience* (âncoras em linhas únicas + LIS). Também `buildHunks` e `intraline`, que devolve intervalos `[início, fim)` das palavras alteradas. Não depende do DOM. |
| `js/highlight.js` | Realce de sintaxe próprio (lexers à mão com regex sticky). A lista de linguagens é `LANGUAGES` (C# é a principal); não a repita aqui. JS/JSX, TS/TSX, C#, C, C++ e Java compartilham o `lexCode`, com ramos por linguagem. HTML/Razor/Vue usam o `lexHtml`, e CSS/SCSS/Less o `lexCss`. Python, YAML e Dockerfile têm lexers próprios (`lexPython`, `lexYaml`, `lexDocker`); YAML e Dockerfile são orientados a linha. Arquivos sem extensão (Dockerfile) são reconhecidos pelo nome em `BY_NAME`, que é checado antes de `EXT` em `langFor`. O mapeamento de extensões fica em `EXT`, e `.h` é tratado como C++ (as palavras-chave de C++ incluem as de C). `Highlight.lines(texto, lang)` devolve tokens `[classe, texto]` por linha. Não depende do DOM. |
| `js/i18n.js` | `t()`, `html()`, plurais, fallback para `en`, `data-i18n*`, `I18n.missing(code)`. |
| `js/app.js` | Toda a interface e o estado (`state`). |

Pontos que não são óbvios:
- **Fim de cada objeto no pack:** é o offset do próximo objeto, tirado dos offsets ordenados do `.idx`. O `DecompressionStream` falha se houver bytes sobrando, então o slice precisa ser exato.
- **Ordem de leitura:** `readObject` procura nos packs antes dos objetos soltos, porque a busca no pack é em memória e a de objeto solto custa IPC de FS.
- **Corridas assíncronas:** `state.gen` é incrementado a cada troca de commit. Todo trabalho assíncrono confere o `gen` antes de mexer no DOM.
- **Re-render preservando o estado:** trocar Unificado/Lado a lado ou o idioma chama `rerenderDiffs()`.
  - Antes de re-renderizar, ela captura uma âncora: a linha no topo do painel, identificada por `tr[data-o][data-n]` (números de linha antigo/novo), mais o deslocamento em px. Depois restaura pela linha, não pelo `scrollTop`, porque as alturas mudam entre os modos.
  - Os arquivos recolhidos ficam em `state.collapsed`, e não só no DOM.
  - `renderFileBody` pode ser chamada várias vezes para o mesmo arquivo (observer, âncora, religar a sintaxe). Só a chamada mais recente escreve no DOM (`body.renderSeq`).
- **Renderização sob demanda:** os diffs são renderizados quando ficam visíveis (`IntersectionObserver`). As estatísticas (+/−) são calculadas em segundo plano por `computeAllStats`, e cada arquivo guarda seu resultado em `ch.diff` e `ch.promise`.
- **Modo Comparar (pull request):** `state.appMode` é `'commit'` ou `'compare'`. `state.subject` diz o que o painel mostra (`'commit'` com `state.current`, ou `'compare'` com `state.compare`). `showChanges()` é o caminho único para exibir uma lista de alterações, e `renderHeader()` escolhe o cabeçalho.
  - **Semântica de PR (3 pontos):** o diff vai do **ancestral comum** até o compare, não de ponta a ponta. Os commits listados são `git log base..compare`. Sem ancestral comum, mostra a diferença direta, com aviso.
  - **`compareTips`:** percorre os dois históricos juntos por data, com marcas A/B/STALE, como o `paint_down_to_common` do git. Commits que ganham marca nova depois de visitados são reinseridos, para tolerar relógios fora de ordem. Há um limite de passos (`truncated`).
  - **Conflitos (`compare.js`):** cada arquivo alterado nos dois lados vira regiões de linhas em coordenadas do ancestral, e o conflito existe quando as regiões se sobrepõem ou se encostam, salvo alteração idêntica. Também são detectados modificado×removido, adicionado nos dois lados, binário e renomeado diferente. O resultado fica em `ch.conflict` e é calculado em segundo plano, depois da exibição (`analyzeConflicts` → `updateConflictUI`).
  - **Validação:** a previsão foi validada contra `git merge-tree --write-tree` (merge real, sem alterar o repositório), com 100% de acerto em 600 arquivos com edições aleatórias. **Qualquer mudança em `compare.js`, `compareTips` ou na detecção de renomeações deve repetir esse teste.** Erros já cometidos: tratar renomeação de um lado só como conflito, e não detectar renomeação com edição.
  - **Base padrão:** `origin/HEAD` → `main`/`master`/`develop`. O compare padrão é a branch atual. As escolhas ficam em `localStorage` (`cmp:base`/`cmp:head`).
- **Arquivo sem `\n` final:** a última linha recebe um sufixo `\u0000` só na chave de comparação. Assim, "sem quebra de linha no final" conta como diferença.
- **Realce de sintaxe:**
  - **Arquivo inteiro:** os lados antigo e novo são tokenizados inteiros, nunca por hunk, para que comentários e strings de várias linhas e blocos Razor saiam certos. Isso é feito em `ensureTokens(ch)` no `renderFileBody` (o único caminho de renderização do corpo), só para arquivos exibidos com realce. O resultado fica em `ch.diff.tokA`/`tokB`. **Não guarde o texto dos arquivos no diff:** as estatísticas são calculadas para todos os arquivos do commit, e guardar o texto multiplicaria a memória. Os blobs são relidos do cache do repositório.
  - **Heurísticas de classificação** (`classify`): depois de `.`/`->` é sempre membro, nunca palavra-chave (`promise.catch`, `map.get`); CAIXA_ALTA é constante (`lit`); `match`/`case` do Python só são palavra-chave no início de instrução; contextuais do C# usadas como nome de variável (`file`, `value`…) ficam fora da lista.
  - **Combinação com o destaque de palavras:** `lineHTML()` no `app.js` corta os tokens nos limites dos intervalos do `intraline`, para que `<mark>` e `<span class="hl-*">` fiquem bem aninhados.
  - **Para adicionar uma linguagem ou extensão:** siga o checklist da seção [Como adicionar uma linguagem ao realce de sintaxe](#como-adicionar-uma-linguagem-ao-realce-de-sintaxe).
  - **Ligar/desligar é só CSS:** o HTML sai com as cores sempre que os tokens existem, e `setHighlight` alterna `.no-hl` em `#diffs`. Ao ligar, só os corpos marcados `data-plain` (exibidos sem tokens) são refeitos. Com a sintaxe desligada, nada é tokenizado. **Não volte a re-renderizar o painel inteiro nessa troca.**
  - **Cache de linha:** `hunk.ready` guarda o modo (`'hl'`/`'plain'`, conforme existam tokens). O destaque de palavras (`line.ranges`) é calculado uma vez por hunk (`hunk.ranged`).
  - **Invariantes do highlighter:** (1) a concatenação dos tokens é exatamente o texto de entrada; (2) todo laço de lexer consome pelo menos um caractere. Quebrar qualquer uma delas faz texto sumir ou trava a aba.
  - **JSX:**
    - Ligado em `.js`/`.jsx` (lang `js`) e `.tsx` (lang `tsx`). Desligado no `.ts` puro, onde `<T>expr` é um cast.
    - Um `<` só abre elemento quando `prev` está em `JSX_AFTER`, ou seja, onde pode começar uma expressão: `(`, `=`, `=>`, `return`… Assim `a < b` e `useState<T>()` continuam sendo código.
    - `TS_GENERIC` exclui `<T,>` e `<T extends X>`.
  - **SCSS/Less (`lexCss`):** dentro de um bloco, `nome:` é decidido por `isDeclaration()`, que olha adiante: se aparece `{` antes de `;`/`}`, é um seletor aninhado (`a:hover {`). Também são reconhecidos `$var`/`@var`, `#{}`, `%placeholder`, `@include nome(...)` e `!default`.
  - **`</script>` e `</style>`:** um comentário dentro dessas tags não pode passar do fechamento (veja `clampEnd`), igual ao navegador.

## Convenções

- **i18n é obrigatório.** Nenhum texto visível pode ficar fixo em `app.js`, `git.js` ou `index.html`.
  - Toda chave nova entra em `js/locales/en.js` (a referência) **e** em `js/locales/pt-BR.js`.
  - No HTML estático, use `data-i18n`, `data-i18n-html` ou `data-i18n-attr="title:chave;placeholder:chave"`.
  - No JS, `t(chave, params)` devolve texto puro. `I18n.html(chave, params)` (`th` no `app.js`) é para traduções com marcação, e escapa os parâmetros.
  - Erros em `git.js` usam `fail('codigo', params)`, que lança um `GitError` traduzido pela chave `errors.codigo`. Nunca use `throw new Error('texto')` ali.
  - Texto que aparece dinamicamente também precisa ser refeito em `onLocaleChange()` no `app.js`.
- **Escape sempre.** Todo dado vindo do repositório (mensagens, nomes, caminhos, conteúdo) passa por `esc()` antes de ir para o `innerHTML`.
- **Estilo:** comentários em português, CSS com variáveis em `:root`, tema claro/escuro via `prefers-color-scheme`.
- **Handlers assíncronos de evento** são envolvidos em `run(fn)`, que mostra o erro num toast.

## Como adicionar uma linguagem ao realce de sintaxe

Siga o checklist inteiro: cada item já foi esquecido pelo menos uma vez. Tudo fica em `js/highlight.js`, salvo onde indicado.

### Caso A: só uma extensão nova para uma linguagem que já existe

Exemplos: `.mjs` → JS, `.razor` → Razor, `Containerfile` → Dockerfile.

- [ ] **Mapeamento:**
  - extensão → `EXT` (chave em minúsculas, sem ponto);
  - arquivo sem extensão ou reconhecido pelo nome → `BY_NAME` (regex sobre o nome do arquivo em minúsculas, checada antes de `EXT`).
- [ ] **`LANGUAGES`:** só mude o nome exibido se a variante for relevante (ex.: `'CSS/SCSS/Less'`).
- [ ] **README:** atualize a linha "Realce de sintaxe" em Recursos.
- [ ] **Teste:** confira `Highlight.langFor('caminho/arquivo.ext')` e também um nome parecido que **não** deve casar.

### Caso B: uma linguagem nova

1. **Escolha onde fica o lexer:**
   - **C-like** (chaves, `//`, `/* */`): reaproveite o `lexCode`. Adicione o código da linguagem em **`CODE_KW` e `CODE_LIT`**; sem isso, `classify` quebra com `undefined.has`. As particularidades entram em ramos `if (lang === 'x')`. Confira também as condições que já listam linguagens: `js`/`jsx`/`cFamily` no início do `lexCode` e a escolha do regex de identificador.
   - **Outra sintaxe:** escreva um `lexX(lx, opts)` próprio e despache no `tokenize()`. Linguagens orientadas a linha (YAML, Dockerfile) costumam ficar mais simples processando linha a linha, como `lexYaml`/`lexDocker`.
2. **Respeite as invariantes:**
   - a concatenação dos tokens é **exatamente** o texto de entrada. Use só `lx.emit(cls, fatia_do_fonte)` e `lx.emitTo(cls, fim)`;
   - **todo laço consome pelo menos um caractere.** Termine com um fallback que emita um caractere, e garanta que quem chama consome o que um sub-lexer deixou ao retornar (`'}'`, `'\n'`…);
   - construções de várias linhas funcionam naturalmente, porque o arquivo inteiro é tokenizado. Se a linguagem puder vir embutida em outra (como `<script>`/`<style>`), aceite `opts.until`/`opts.stop`.
3. **Use só as classes de token existentes:** `kw str com num fn type tag attr meta lit re`. Uma classe nova exige uma variável `--hl-x` em `:root` **e** no bloco escuro do `css/style.css`, mais a regra `.hl-x`. A regra `.no-hl [class*="hl-"]` já cobre o desligamento.
4. **Evite as armadilhas que já apareceram:**
   - palavra-chave depois de `.`/`->` é membro (`promise.catch`, `re.match`);
   - palavras-chave contextuais e "suaves" também são usadas como nome de variável (`value`, `file`, `match`);
   - CAIXA_ALTA é constante (`lit`), não tipo;
   - `#` e `//` dentro de URLs e strings não são comentário;
   - `<` pode ser comparação ou generic;
   - linguagens embutidas não podem passar do delimitador de fechamento (`clampEnd`).
5. **Mapeamento:** `EXT` e/ou `BY_NAME`.
6. **`LANGUAGES`:** acrescente o nome exibido. Ele alimenta a dica do botão Sintaxe via `{langs}`. **Não edite as traduções** por causa disso; só crie chaves (em `en.js` **e** `pt-BR.js`) se surgir texto novo de interface.
7. **Documentação:**
   - README: a linha "Realce de sintaxe" em Recursos;
   - este arquivo: a linha do `highlight.js` na tabela de Arquitetura, só se houver lexer próprio ou heurística não óbvia, e um item em "Realce de sintaxe" se a heurística merecer explicação.
8. **Testes:** todos obrigatórios; veja "Como testar".
   - `node --check js/*.js js/locales/*.js`;
   - **fuzzing** da linguagem nova (modelo abaixo), com fragmentos que estressem os delimitadores dela;
   - **amostra real** impressa como `[classe:texto]`, conferida a olho, com os casos difíceis da linguagem;
   - **regressão:** o fuzzing das outras linguagens, o teste do `lineHTML` (sintaxe + destaque de palavras), o JS do próprio projeto sem tags JSX falsas, e o teste de ponta a ponta se o `app.js` foi alterado.

Modelo de fuzzing (Node 22, salve com a ferramenta de escrita de arquivos):

```js
import fs from 'node:fs'; import vm from 'node:vm';
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync('js/highlight.js', 'utf8'));
const lang = 'x', frag = ['a', '"', "'", '\\', '\n', ' ', '{', '}', '#', '//', '/*', '*/' /* + delimitadores da linguagem */];
let fails = 0;
for (let n = 0; n < 5000; n++) {
  let src = '';
  for (let i = 0, len = Math.random() * 80 | 0; i < len; i++) src += frag[Math.random() * frag.length | 0];
  if (Highlight.tokenize(src, lang).map((t) => t[1]).join('') !== src) fails++;   // não perde nem duplica texto
  if (Highlight.lines(src, lang).length !== src.split('\n').length) fails++;        // número de linhas bate
}
console.log('falhas', fails); // deve ser 0, e o script precisa terminar (não pode travar)
```

## Como testar

Não há suíte de testes no repositório.

**Interface (ponta a ponta):** o Chrome está instalado em `C:/Program Files/Google/Chrome/Application/chrome.exe`. A receita que funcionou:
- gere um repositório de teste e um manifesto JSON do `.git` dele;
- monte uma cópia do `index.html` com um script que substitui `window.showDirectoryPicker` por um handle falso (`getDirectoryHandle`/`getFileHandle`/`entries`) que lê os arquivos via `fetch`;
- sirva tudo com um servidor HTTP em Node, abra o `chrome --headless=new --remote-debugging-port=…` e leia o resultado de um cenário em `window.__result` via `Runtime.evaluate` (WebSocket do DevTools Protocol; o Node 22 tem `WebSocket` global);
- capture `error`/`unhandledrejection` na página. O handle falso não é clonável, então o `idbSet` falha ali, e isso é esperado.

**Núcleo:** `git.js` e `diff.js` não dependem do DOM e podem ser testados no Node 22+:

- carregue os arquivos com `vm.runInThisContext` após `globalThis.window = globalThis`;
- implemente a interface de FS com `fs.openAsBlob` (devolve um `Blob` com `slice`, `stream` e `arrayBuffer`);
- monte um repositório de teste com commits, renomeações, binários, arquivos sem EOL, merge e tag anotada; rode `git gc` para gerar packs com deltas e crie um commit solto depois;
- compare com o git: `git rev-list --date-order`, `git diff-tree -r --no-renames --numstat` (os +/− por arquivo devem bater) e `git rev-parse` para o `resolve()`;
- para a comparação de branches: `compareTips` contra `git rev-list base..head`, `git rev-list head..base` e `git merge-base` (inclua ramos derivados e branch contra ela mesma). Para a previsão de conflitos, compare com os arquivos que `git merge-tree --write-tree --name-only base head` lista em conflito, em cenários feitos à mão (conteúdo sobreposto, adição no fim, binário, adição nos dois lados, modificado×removido, renomeação com edição) **e** num fuzzing com edições aleatórias nos dois lados;
- para o diff, compare a contagem de linhas iguais com uma LCS por programação dinâmica em sequências aleatórias, e force o fallback patience com `Diff.diffSeq(a, b, 3)`;
- para o highlighter, faça fuzzing com fragmentos problemáticos (`@{`, `"""`, `${`, `</script>`, `@*`…) em todas as linguagens. Confira que a concatenação dos tokens é igual à entrada e que o número de linhas bate, e inspecione amostras reais de C# e Razor imprimindo `[classe:texto]`.

No Git Bash do Windows, heredocs podem perder barras invertidas: grave scripts de teste com a ferramenta de escrita de arquivos.

Para checar a sintaxe: `node --check js/*.js js/locales/*.js`.

## Limitações conhecidas

- Merge é comparado só com o primeiro pai.
- A detecção de renomeação por similaridade roda em **todo** commit (`diffCommit`), então o custo dela entra direto no tempo de abrir um commit.
  - Limites: até 2500 pares removido×adicionado e um orçamento de ~15 milhões de linhas comparadas (estimado contando `\n` nos bytes, **antes** de decodificar). Binários e arquivos acima de 1 MB são ignorados. Acima disso, só renomeações exatas.
  - Medido: pior caso dentro do orçamento ≈ 200 ms (50×50 arquivos de 3.000 linhas); acima dele, < 100 ms. **Ao mexer nessa função, refaça essa medição.** A primeira versão, sem o orçamento e com `Map` por par, levava 7,6 s.
- A previsão de conflitos é por arquivo e por região de linhas, e não aplica as estratégias de merge do git (ex.: `ours`/`theirs`, rerere). Com vários ancestrais comuns (merges cruzados), usa o mais recente.
- Não há suporte a SHA-256, `reftable`, `objects/info/alternates` nem `.idx` v1.
- O filtro de commits só busca nos commits já carregados (de 100 em 100), e só no título, autor, e-mail e hash.

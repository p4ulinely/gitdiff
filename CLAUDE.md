# gitdiff

Visualizador de diferenças git que roda no navegador e é estático. O `.git` é lido direto pelo navegador, sem servidor e sem chamar o binário `git`. Converse com o usuário em português.

## Restrições do projeto

- **JavaScript puro, sem dependências, sem build, sem npm.** Não adicione frameworks nem bibliotecas.
- **Scripts clássicos, não ES modules.** A página precisa funcionar aberta via `file://`, onde `import` é bloqueado por CORS. Cada arquivo é uma IIFE que expõe um global (`GitFS`, `Git`, `Diff`, `I18n`).
- **A ordem dos `<script>` no `index.html` importa:** `i18n.js` → `locales/*.js` → `fs.js` → `git.js` → `diff.js` → `highlight.js` → `app.js`.
- APIs do navegador usadas: File System Access API (`showDirectoryPicker`), com `<input webkitdirectory>` como alternativa; `DecompressionStream('deflate')` para o zlib; `Intl`; IndexedDB para lembrar a última pasta; `localStorage` para preferências (chaves com prefixo `gitdiff:`).

## Arquitetura

| Arquivo | Papel |
|---|---|
| `js/fs.js` | Interface mínima de FS: `getFile(path) → File\|null` e `list(path) → [{name, kind}]`. Implementações `HandleFS` e `FileListFS`. |
| `js/git.js` | `Repo`: objetos soltos, packfiles (idx v2, OFS/REF_DELTA), refs, packed-refs, `resolve()` (hash abreviado, refs, `~N`/`^N`), `diffTrees`, `diffCommit` (com renomeações exatas). `LogWalker`: histórico por data do committer. |
| `js/diff.js` | Myers O(ND) com limite `maxD`. Acima dele usa o fallback *patience* (âncoras em linhas únicas + LIS). Também `buildHunks` e `intraline`, que devolve intervalos `[início, fim)` das palavras alteradas. Não depende do DOM. |
| `js/highlight.js` | Realce de sintaxe próprio (lexers à mão com regex sticky). Linguagens: C# (principal), JS, TS, HTML, CSS, Razor (`.cshtml`/`.razor`), Vue, Python, C, C++ e Java. JS, TS, C#, C, C++ e Java compartilham o `lexCode`, com ramos por linguagem. Python tem lexer próprio (`lexPython`). O mapeamento de extensões fica em `EXT`, e `.h` é tratado como C++ (as palavras-chave de C++ incluem as de C). `Highlight.lines(texto, lang)` devolve tokens `[classe, texto]` por linha. Não depende do DOM. |
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
- **Arquivo sem `\n` final:** a última linha recebe um sufixo `\u0000` só na chave de comparação. Assim, "sem quebra de linha no final" conta como diferença.
- **Realce de sintaxe:**
  - **Arquivo inteiro:** os lados antigo e novo são tokenizados inteiros, nunca por hunk, para que comentários e strings de várias linhas e blocos Razor saiam certos. Isso é feito em `ensureTokens(ch)` no `renderFileBody` (o único caminho de renderização do corpo), só para arquivos exibidos com realce. O resultado fica em `ch.diff.tokA`/`tokB`. **Não guarde o texto dos arquivos no diff:** as estatísticas são calculadas para todos os arquivos do commit, e guardar o texto multiplicaria a memória. Os blobs são relidos do cache do repositório.
  - **Heurísticas de classificação** (`classify`): depois de `.`/`->` é sempre membro, nunca palavra-chave (`promise.catch`, `map.get`); CAIXA_ALTA é constante (`lit`); `match`/`case` do Python só são palavra-chave no início de instrução; contextuais do C# usadas como nome de variável (`file`, `value`…) ficam fora da lista.
  - **Combinação com o destaque de palavras:** `lineHTML()` no `app.js` corta os tokens nos limites dos intervalos do `intraline`, para que `<mark>` e `<span class="hl-*">` fiquem bem aninhados.
  - **Para adicionar uma linguagem:** (1) um lexer ou um ramo no `lexCode`; (2) as extensões em `EXT`; (3) o nome em `LANGUAGES`, que alimenta a dica do botão via `{langs}`, sem mexer nas traduções; (4) a linha de recursos no README; (5) fuzzing + amostra real.
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
- para o diff, compare a contagem de linhas iguais com uma LCS por programação dinâmica em sequências aleatórias, e force o fallback patience com `Diff.diffSeq(a, b, 3)`;
- para o highlighter, faça fuzzing com fragmentos problemáticos (`@{`, `"""`, `${`, `</script>`, `@*`…) em todas as linguagens. Confira que a concatenação dos tokens é igual à entrada e que o número de linhas bate, e inspecione amostras reais de C# e Razor imprimindo `[classe:texto]`.

No Git Bash do Windows, heredocs podem perder barras invertidas: grave scripts de teste com a ferramenta de escrita de arquivos.

Para checar a sintaxe: `node --check js/*.js js/locales/*.js`.

## Limitações conhecidas

- Merge é comparado só com o primeiro pai.
- Renomeação só é detectada quando o conteúdo é idêntico.
- Não há suporte a SHA-256, `reftable`, `objects/info/alternates` nem `.idx` v1.
- O filtro de commits só busca nos commits já carregados (de 100 em 100), e só no título, autor, e-mail e hash.

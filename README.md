# gitdiff

Visualizador de diferenças git que roda direto no navegador. É estático, em JavaScript puro, sem dependências e sem build.

## Como usar

1. Abra o `index.html` no Chrome ou no Edge. Se o navegador bloquear o acesso pelo `file://`, sirva a pasta localmente com `python -m http.server` ou `npx serve` e acesse `http://localhost:8000`.
2. Clique em **Abrir pasta…** e escolha a pasta do repositório (a que contém `.git`).
3. Escolha a branch. Os commits aparecem na coluna da esquerda e carregam aos poucos conforme você rola a lista.
4. Clique num commit ou digite o hash no campo do topo. O campo também aceita hash abreviado, branch, tag, `HEAD~3`, `abc123^2` etc.

Nada é enviado para fora: o `.git` é lido localmente pelo navegador.

## Recursos

- Leitura nativa do `.git`: objetos soltos, packfiles (com deltas), refs, `packed-refs` e tags anotadas
- Painéis de commits e de arquivos alterados, ambos recolhíveis e redimensionáveis
- Arquivos alterados em lista ou em árvore de pastas, com filtro e contagem de +/−
- **Modo Comparar** (prévia de pull request): escolha a base e a branch para ver:
  - os commits que entrariam no PR e quantos commits a branch está atrás da base;
  - as alterações a partir do ancestral comum (como o GitHub/GitLab mostram);
  - **os conflitos prováveis** com a base, com as linhas indicadas.
- Diff unificado ou lado a lado, com destaque das palavras alteradas
- Realce de sintaxe pela extensão do arquivo, ligado por padrão (botão **Sintaxe**): C# (`.cs`), JavaScript/JSX, TypeScript/TSX, HTML, CSS/SCSS/Less, Razor (`.cshtml`), Vue, Python, C, C++, Java, YAML e Dockerfile (detectado pelo nome: `Dockerfile`, `Dockerfile.dev`, `*.dockerfile`, `Containerfile`)
- Detecção de renomeações exatas, de arquivos binários e de submódulos, com prévia de imagens antes/depois
- Atalhos: `j`/`k` para o próximo/anterior commit, `n`/`p` para o próximo/anterior arquivo
- No Chrome/Edge, o botão **Reabrir** volta à última pasta usada

No Firefox e no Safari é usado o seletor de pasta padrão (`webkitdirectory`). Funciona, mas é mais lento em projetos grandes.

## Idiomas

Inglês (padrão) e português. O idioma é trocado pelo seletor no canto superior direito e a escolha fica salva no navegador.

Para adicionar um idioma:

1. Copie `js/locales/en.js` para `js/locales/<código>.js` (ex.: `es.js`, `fr.js`).
2. Troque o código e o nome em `I18n.register('es', { name: 'Español', ... })` e traduza os valores. Não mude as chaves.
3. Inclua `<script src="js/locales/es.js"></script>` no `index.html`, junto dos outros idiomas.

O novo idioma aparece sozinho no seletor. Chaves não traduzidas caem para o inglês e geram um aviso no console. Para listar o que falta traduzir, rode `I18n.missing('es')` no console.

Formato das mensagens:

- `{nome}` é substituído por um parâmetro, e os parâmetros são escapados quando o texto vai para o HTML.
- Plurais usam um objeto `{ one, other }`, mais `zero`, `few`, `many` etc. quando o idioma precisar, seguindo as regras do `Intl.PluralRules`.
- Datas, tempo relativo ("há 3 dias") e números são formatados pelo `Intl` no idioma ativo.
- Os erros do leitor git (`js/git.js`) não têm texto: eles carregam um código, traduzido pela chave `errors.<código>`.

## Limitações

- Commits de merge são comparados com o primeiro pai
- Não suporta repositórios SHA-256, o formato `reftable` nem `objects/info/alternates`
- Worktrees e submódulos (em que `.git` é um arquivo) precisam ser abertos pelo repositório principal

## Estrutura

```
index.html
css/style.css
js/i18n.js   motor de tradução (fallback, plurais, data-i18n no HTML)
js/locales/  um arquivo por idioma (en.js é a referência)
js/fs.js     acesso a arquivos (File System Access API / webkitdirectory)
js/git.js    leitura do repositório: objetos, packs, refs, histórico, diff de árvores
js/diff.js   diff de linhas (Myers + fallback patience), hunks, destaque intralinha
js/compare.js  previsão de conflitos de um PR (merge de 3 vias aproximado)
js/highlight.js  realce de sintaxe (lista de linguagens em Highlight.LANGUAGES)
js/app.js    interface
```

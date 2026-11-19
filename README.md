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
- Diff unificado ou lado a lado, com destaque das palavras alteradas
- Detecção de renomeações exatas, de arquivos binários e de submódulos, com prévia de imagens antes/depois
- Atalhos: `j`/`k` para o próximo/anterior commit, `n`/`p` para o próximo/anterior arquivo
- No Chrome/Edge, o botão **Reabrir** volta à última pasta usada

No Firefox e no Safari é usado o seletor de pasta padrão (`webkitdirectory`). Funciona, mas é mais lento em projetos grandes.

## Limitações

- Commits de merge são comparados com o primeiro pai
- Não suporta repositórios SHA-256, o formato `reftable` nem `objects/info/alternates`
- Worktrees e submódulos (em que `.git` é um arquivo) precisam ser abertos pelo repositório principal

## Estrutura

```
index.html
css/style.css
js/fs.js     acesso a arquivos (File System Access API / webkitdirectory)
js/git.js    leitura do repositório: objetos, packs, refs, histórico, diff de árvores
js/diff.js   diff de linhas (Myers + fallback patience), hunks, destaque intralinha
js/app.js    interface
```

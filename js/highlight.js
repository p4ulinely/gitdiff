/* Realce de sintaxe sem dependências.
 *
 * Linguagens: C# (principal), JavaScript, TypeScript, HTML, CSS (scss/less básico),
 * Razor (.cshtml/.razor), Vue (SFC), Python, C, C++ e Java.
 *
 * O texto é tokenizado inteiro (não linha a linha), para que construções de várias
 * linhas — comentários, strings verbatim/raw do C#, template strings, blocos Razor,
 * <script>/<style> — fiquem corretas em qualquer trecho do diff.
 *
 * Saída de lines(): uma lista por linha de tokens [classe|null, texto].
 * Invariante: a concatenação dos textos é exatamente o texto de entrada.
 * Classes: kw str com num fn type tag attr meta lit re  (CSS: .hl-<classe>)
 */
(function () {
  'use strict';

  const words = (s) => new Set(s.trim().split(/\s+/));

  const JS_KW = words(`break case catch class const continue debugger default delete do else export extends
    finally for function if import in instanceof let new return switch throw try typeof var void while with
    yield async await of static get set from as`);
  const TS_KW = new Set([...JS_KW, ...words(`interface type enum implements namespace declare abstract private
    protected public readonly keyof infer is unique satisfies module override`)]);
  const TS_TYPES = words('string number boolean any unknown never object symbol bigint');
  const JS_LIT = words('true false null undefined this super NaN Infinity');

  const CS_KW = words(`abstract as base bool break byte case catch char checked class const continue decimal
    default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit
    in int interface internal is lock long namespace new object operator out override params private protected
    public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch throw try typeof
    uint ulong unchecked unsafe ushort using virtual void volatile while add and ascending async await by
    descending dynamic equals from get global group init into join let nameof nint not notnull nuint on
    or orderby partial record remove required select set unmanaged var when where with yield`);
  // Contextuais muito usadas como nome de variável (file, value, alias, scoped, managed) ficam de fora.
  const CS_LIT = words('true false null this base');

  const C_KW = words(`auto break case char const continue default do double else enum extern float for goto
    if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned
    void volatile while _Bool _Complex _Atomic _Static_assert _Noreturn _Thread_local _Alignas _Alignof _Generic
    bool`);
  const CPP_KW = new Set([...C_KW, ...words(`alignas alignof and and_eq asm bitand bitor catch char8_t char16_t
    char32_t class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype
    delete dynamic_cast explicit export final friend mutable namespace new noexcept not not_eq operator or or_eq
    override private protected public reinterpret_cast requires static_assert static_cast template thread_local
    throw try typeid typename using virtual wchar_t xor xor_eq module import`)]);
  const C_LIT = words('true false NULL nullptr this');
  const C_TYPES = words(`size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t
    uint16_t uint32_t uint64_t FILE wchar_t string string_view vector array map unordered_map set unordered_set
    list deque pair tuple optional variant unique_ptr shared_ptr weak_ptr function`);

  const JAVA_KW = words(`abstract assert boolean break byte case catch char class const continue default do
    double else enum extends final finally float for goto if implements import instanceof int interface long
    native new package private protected public return short static strictfp switch synchronized throw throws
    transient try void volatile while var record yield sealed permits`);
  const JAVA_LIT = words('true false null this super');

  const PY_KW = words(`and as assert async await break class continue def del elif else except finally for
    from global if import in is lambda nonlocal not or pass raise return try while with yield match case`);
  const PY_LIT = words('True False None self cls Ellipsis NotImplemented __name__ __main__ __file__');
  const PY_TYPES = words('int float complex str bool list dict set frozenset tuple bytes bytearray object type range');

  const VOID_TAGS = words('area base br col embed hr img input link meta param source track wbr');
  const RAZOR_BLOCKS = words('if foreach for while switch try lock do');
  const RAZOR_DIRECTIVES = words(`model inject inherits namespace page layout addTagHelper removeTagHelper
    tagHelperPrefix implements preservewhitespace attribute rendermode typeparam`);

  const RE = {
    ws: /[ \t\f\r]+|\n/y,
    lineRest: /[^\n]*/y,
    ident: /[A-Za-z_$À-￿][\w$À-￿]*/y,
    csIdent: /@?[A-Za-z_À-￿][\wÀ-￿]*/y,
    razorIdent: /[A-Za-z_]\w*/y,
    num: /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y,
    regex: /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/y,
    call: /\s*\(/y,
    csString: /(\$*)(@?)(\$*)("""+|")/y,
    tagName: /[A-Za-z][\w:.-]*/y,
    closeTag: /<\/([A-Za-z][\w:.-]*)/y,
    closeTagRest: /\s*>?/y,
    attrName: /[^\s=>/"']+/y,
    unquoted: /[^\s>]+/y,
    entity: /&(?:#\d+|#x[\da-fA-F]+|\w+);/y,
    text: /[^<&@{}\n]+|[\s\S]/y,
    cssIdent: /-?-?[A-Za-z_][\w-]*/y,
    cssNum: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y,
    cssHex: /#[\da-fA-F]{3,8}(?![\w-])/y,
    cssSel: /[.#][\w-]+/y,
    cssPseudo: /::?[\w-]+/y,
    cssAt: /@[\w-]+/y,
    important: /!\s*(?:important|default|global|optional)\b/iy,
    elseLike: /\s*(?:else|catch|finally)\b/y,
    pyIdent: /[A-Za-z_À-￿][\wÀ-￿]*/y,
    cNum: /(?:0[xX][\da-fA-F']+(?:\.[\da-fA-F']*)?(?:[pP][+-]?\d+)?|0[bB][01']+|(?:\d[\d']*(?:\.[\d']*)?|\.\d[\d']*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y,
    cRaw: /(?:u8|[uUL])?R"([^()\\\s"]{0,16})\(/y,
    cPrefix: /(?:u8|[uUL])(?=["'])/y,
    cDirective: /#[ \t]*[A-Za-z_]\w*/y,
    cHeader: /[ \t]*(?:<[^>\n]*>|"[^"\n]*")/y,
    scope: /::/y,
    pyString: /([rRbBuUfF]{0,2})('''|"""|'|")/y,
    pyDecorator: /@[\w.]+/y,
  };

  // Um comentário não pode passar de </script> ou </style>: o navegador fecha a tag ali.
  function clampEnd(lx, end, stop) {
    if (!stop) return end;
    stop.lastIndex = lx.p;
    const m = stop.exec(lx.s);
    return m && m.index < end ? m.index : end;
  }
  const END_SCRIPT = /<\/script/gi;
  const END_STYLE = /<\/style/gi;

  class Lexer {
    constructor(src) {
      this.s = src;
      this.p = 0;
      this.n = src.length;
      this.out = [];
    }
    eof() { return this.p >= this.n; }
    starts(str) { return this.s.startsWith(str, this.p); }
    re(r, at = this.p) {
      r.lastIndex = at;
      const m = r.exec(this.s);
      return m ? m[0] : null;
    }
    // Consome `text` (que deve começar na posição atual) com a classe `cls`.
    emit(cls, text) {
      if (!text) return;
      this.p += text.length;
      const last = this.out[this.out.length - 1];
      if (last && last[0] === cls) last[1] += text;
      else this.out.push([cls, text]);
    }
    // Consome até a posição absoluta `end`.
    emitTo(cls, end) { this.emit(cls, this.s.slice(this.p, end)); }
  }

  const isAlpha = (c) => !!c && /[A-Za-z]/.test(c);
  const isDigit = (c) => !!c && c >= '0' && c <= '9';

  function atLineStart(lx) {
    let i = lx.p - 1;
    while (i >= 0 && (lx.s[i] === ' ' || lx.s[i] === '\t')) i--;
    return i < 0 || lx.s[i] === '\n';
  }

  function lexQuoted(lx, q) {
    const s = lx.s;
    let i = lx.p + 1;
    while (i < lx.n) {
      const ch = s[i];
      if (ch === '\\') i += 2;
      else if (ch === q) { i++; break; }
      else if (ch === '\n') break;
      else i++;
    }
    lx.emitTo('str', Math.min(i, lx.n));
  }

  function lexTemplate(lx, lang) {
    const s = lx.s;
    let i = lx.p + 1;
    while (i < lx.n) {
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { i++; break; }
      if (ch === '$' && s[i + 1] === '{') {
        lx.emitTo('str', i);
        lx.emit('meta', '${');
        lexCode(lx, lang, { close: '}' });
        if (s[lx.p] === '}') lx.emit('meta', '}');
        i = lx.p;
        continue;
      }
      i++;
    }
    lx.emitTo('str', Math.min(i, lx.n));
  }

  // Strings do C#: "..", @"..", $"..{x}..", $@"..", """raw""", $$"""raw""". Retorna false se não for string.
  function lexCsString(lx) {
    const m = RE.csString;
    m.lastIndex = lx.p;
    const r = m.exec(lx.s);
    if (!r) return false;
    const s = lx.s;
    const interp = (r[1] + r[3]).length > 0, verbatim = r[2] === '@', quotes = r[4];
    if (quotes.length >= 3) {
      const end = s.indexOf(quotes, lx.p + r[0].length);
      lx.emitTo('str', end < 0 ? lx.n : end + quotes.length);
      return true;
    }
    let i = lx.p + r[0].length;
    while (i < lx.n) {
      const ch = s[i];
      if (verbatim) {
        if (ch === '"') {
          if (s[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
      } else {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') { i++; break; }
        if (ch === '\n') break;
      }
      if (interp && ch === '{') {
        if (s[i + 1] === '{') { i += 2; continue; }
        lx.emitTo('str', i);
        lx.emit('meta', '{');
        lexCode(lx, 'cs', { close: '}' });
        if (s[lx.p] === '}') lx.emit('meta', '}');
        i = lx.p;
        continue;
      }
      if (interp && ch === '}' && s[i + 1] === '}') { i += 2; continue; }
      i++;
    }
    lx.emitTo('str', Math.min(i, lx.n));
    return true;
  }

  const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^'.split(''), '=>']);

  /* JSX: um '<' só abre elemento onde pode começar uma expressão. Assim "a < b",
   * "useState<string>()" e "Array<T>" continuam sendo código. */
  const JSX_AFTER = new Set([...'(,=:[!&|?{};'.split(''), '=>', '', 'kw:return', 'kw:yield', 'kw:default', 'kw:case']);
  const JSX_START = /<(?:>|[A-Za-z_$][\w$.:-]*(?=[\s/>{]))/y;
  const TS_GENERIC = /<[A-Za-z_$][\w$]*\s*(?:,|extends\b)/y; // <T,>(x) => …, <T extends X>(…)

  function lexJsxTag(lx, lang) {
    const s = lx.s;
    lx.emit('tag', '<');
    const name = lx.re(/[A-Za-z_$][\w$.:-]*/y);
    if (name) lx.emit(/^[a-z]/.test(name) ? 'tag' : 'type', name); // div vs Componente
    while (!lx.eof()) {
      const c = s[lx.p];
      if (c === '>') { lx.emit('tag', '>'); return false; }
      if (c === '/' && s[lx.p + 1] === '>') { lx.emit('tag', '/>'); return true; }
      if (/\s/.test(c)) { lx.emit(null, lx.re(RE.ws)); continue; }
      if (c === '{') { // {...props} ou valor {expr}
        lx.emit(null, '{');
        lexCode(lx, lang, { close: '}' });
        if (s[lx.p] === '}') lx.emit(null, '}');
        continue;
      }
      if (c === '"' || c === "'") { lexQuoted(lx, c); continue; }
      const attr = lx.re(/[\w$:.-]+/y);
      if (attr) { lx.emit('attr', attr); continue; }
      lx.emit(null, c);
    }
    return true;
  }

  // Um elemento JSX completo (com filhos), a partir do '<'.
  function lexJsx(lx, lang) {
    const s = lx.s;
    let depth = 0;
    while (!lx.eof()) {
      if (s[lx.p] === '<' && s[lx.p + 1] === '/') {
        lx.emit('tag', lx.re(/<\/[\w$.:-]*\s*>?/y));
        if (--depth <= 0) return;
        continue;
      }
      if (s[lx.p] === '<' && lx.re(JSX_START) !== null) {
        if (!lexJsxTag(lx, lang)) depth++;
        else if (depth === 0) return; // <Comp /> sozinho
        continue;
      }
      if (depth <= 0) return;
      if (s[lx.p] === '{') { // {expr} e {/* comentário */}
        lx.emit(null, '{');
        lexCode(lx, lang, { close: '}' });
        if (s[lx.p] === '}') lx.emit(null, '}');
        continue;
      }
      lx.emit(null, lx.re(/[^<{]+/y) || s[lx.p]);
    }
  }

  const TYPE_DECL = new Set(['kw:class', 'kw:struct', 'kw:interface', 'kw:enum', 'kw:record', 'kw:union']);
  const CODE_KW = { cs: CS_KW, ts: TS_KW, tsx: TS_KW, js: JS_KW, c: C_KW, cpp: CPP_KW, java: JAVA_KW };
  const CODE_LIT = { cs: CS_LIT, ts: JS_LIT, tsx: JS_LIT, js: JS_LIT, c: C_LIT, cpp: C_LIT, java: JAVA_LIT };

  const isConstName = (w) => /^[A-Z][A-Z\d]*_[A-Z\d_]*$|^[A-Z][A-Z\d]{2,}$/.test(w); // MAX_SIZE, BUFFER

  function classify(lx, id, lang, prev) {
    const word = id[0] === '@' ? id.slice(1) : id;
    const cFamily = lang === 'c' || lang === 'cpp';
    // Depois de '.' ou '->' é sempre membro: promise.catch(), map.get(k), obj.default.
    const member = prev === '.' || prev === '->';
    if (!member && id[0] !== '@' && CODE_KW[lang].has(word)) return 'kw';
    if (!member && CODE_LIT[lang].has(word)) return 'lit';
    if ((lang === 'ts' || lang === 'tsx') && TS_TYPES.has(word)) return 'type';
    if (TYPE_DECL.has(prev)) return 'type'; // class Foo, record Point(...)
    if (lx.re(RE.call, lx.p + id.length) !== null) return 'fn';
    if (cFamily && lx.re(RE.scope, lx.p + id.length) !== null) return 'type'; // std::, Ns::
    if (cFamily && !member && C_TYPES.has(word)) return 'type'; // antes de isConstName: FILE
    if (isConstName(word)) return 'lit';
    if (member) return null; // Model.Name, p->x
    if (/^[A-Z]/.test(word)) return 'type';
    return null;
  }

  // Linha de pré-processador C/C++ (#include <x.h>, #define com continuação '\').
  function lexPreprocessor(lx, lang) {
    const directive = lx.re(RE.cDirective);
    lx.emit('meta', directive);
    if (/include|import/.test(directive)) {
      const h = lx.re(RE.cHeader);
      if (h) lx.emit('str', h);
    }
    const endOfLine = (l) => l.s[l.p] === '\n' && !/\\\r?$/.test(l.s.slice(Math.max(0, l.p - 2), l.p));
    lexCode(lx, lang, { until: endOfLine, noPreprocessor: true });
  }

  // Text block do Java: """ ... """ (aceita \""" dentro).
  function lexTextBlock(lx) {
    const s = lx.s;
    let i = lx.p + 3;
    while (i < lx.n && !s.startsWith('"""', i)) i += s[i] === '\\' ? 2 : 1;
    lx.emitTo('str', Math.min(i + 3, lx.n));
  }

  /* Código C-like (js, ts, cs, c, cpp, java).
   * opts.close     para no fechamento ')' '}' ']' balanceado (não consome)
   * opts.until     função de parada (não consome)
   * opts.razor     permite marcação HTML e @: dentro do código (blocos Razor)
   * opts.statement bloco Razor @if/@foreach…: termina após o '}' de nível 0 (com else/catch/finally) */
  function lexCode(lx, lang, opts = {}) {
    const s = lx.s;
    const js = lang === 'js' || lang === 'ts' || lang === 'tsx', cFamily = lang === 'c' || lang === 'cpp';
    // JSX vale em .js/.jsx/.tsx; no .ts puro "<T>expr" é cast, então fica desligado.
    const jsx = lang === 'js' || lang === 'tsx';
    const open = opts.close === '}' ? '{' : opts.close === ')' ? '(' : opts.close === ']' ? '[' : null;
    let depth = 0, braces = 0, prev = '';
    while (!lx.eof()) {
      if (opts.until && opts.until(lx)) return;
      const c = s[lx.p], c2 = s[lx.p + 1];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { lx.emit(null, lx.re(RE.ws)); continue; }
      if (c === '/' && c2 === '/') {
        lx.emitTo('com', clampEnd(lx, lx.p + lx.re(RE.lineRest).length, opts.stop));
        continue;
      }
      if (c === '/' && c2 === '*') {
        const e = s.indexOf('*/', lx.p + 2);
        lx.emitTo('com', clampEnd(lx, e < 0 ? lx.n : e + 2, opts.stop));
        continue;
      }
      if (opts.close && c === opts.close && depth === 0) return;

      if (opts.razor) {
        if (c === '@' && c2 === '*') {
          const e = s.indexOf('*@', lx.p + 2);
          lx.emitTo('com', e < 0 ? lx.n : e + 2);
          continue;
        }
        if (c === '@' && c2 === ':') {
          lx.emit('meta', '@:');
          lexHtml(lx, { razor: true, until: (l) => l.s[l.p] === '\n' });
          prev = ';';
          continue;
        }
        // Marcação começa onde cabe uma instrução (inclusive depois de "case X:").
        if (c === '<' && isAlpha(c2) && (prev === '' || prev === '{' || prev === '}' || prev === ';' || prev === ':')) {
          lexHtml(lx, { razor: true, element: true });
          prev = '}';
          continue;
        }
      }

      if (lang === 'cs' && c === '#' && atLineStart(lx)) { lx.emit('meta', lx.re(RE.lineRest)); continue; }
      if (lang === 'cs' && (c === '"' || c === '$' || (c === '@' && (c2 === '"' || c2 === '$')))) {
        if (lexCsString(lx)) { prev = 'str'; continue; }
      }
      if (cFamily) {
        if (c === '#' && !opts.noPreprocessor && atLineStart(lx) && lx.re(RE.cDirective)) {
          lexPreprocessor(lx, lang);
          prev = ';';
          continue;
        }
        const raw = lx.re(RE.cRaw);
        if (raw) { // R"delim( ... )delim"
          const close = ')' + raw.slice(raw.indexOf('"') + 1, -1) + '"';
          const e = s.indexOf(close, lx.p + raw.length);
          lx.emitTo('str', e < 0 ? lx.n : e + close.length);
          prev = 'str';
          continue;
        }
        const prefix = lx.re(RE.cPrefix);
        if (prefix) { // L"..", u8"..", u'x'
          lx.emit('str', prefix);
          lexQuoted(lx, s[lx.p]);
          prev = 'str';
          continue;
        }
        if (isDigit(c) || (c === '.' && isDigit(c2))) { lx.emit('num', lx.re(RE.cNum)); prev = 'num'; continue; }
        if (c === '-' && c2 === '>') { lx.emit(null, '->'); prev = '->'; continue; }
      }
      if (lang === 'java' && lx.starts('"""')) { lexTextBlock(lx); prev = 'str'; continue; }
      if (c === '"' || c === "'") { lexQuoted(lx, c); prev = 'str'; continue; }
      if (js && c === '`') { lexTemplate(lx, lang); prev = 'str'; continue; }
      if (jsx && c === '<' && JSX_AFTER.has(prev) && lx.re(JSX_START) !== null && lx.re(TS_GENERIC) === null) {
        lexJsx(lx, lang);
        prev = ')'; // um elemento é uma expressão completa
        continue;
      }
      if (js && c === '/' && (prev === '' || REGEX_AFTER.has(prev) || prev.startsWith('kw:'))) {
        const m = lx.re(RE.regex);
        if (m) { lx.emit('re', m); prev = 're'; continue; }
      }
      if (isDigit(c) || (c === '.' && isDigit(c2))) { lx.emit('num', lx.re(RE.num)); prev = 'num'; continue; }

      const id = lx.re(js || lang === 'java' ? RE.ident : lang === 'cs' ? RE.csIdent : RE.pyIdent);
      if (id) {
        const cls = classify(lx, id, lang, prev);
        lx.emit(cls, id);
        prev = cls === 'kw' ? 'kw:' + id : 'id';
        continue;
      }
      // Decorators (TS) e anotações (Java): @Override, @Service("x")
      if ((js || lang === 'java') && c === '@' && isAlpha(c2)) { lx.emit('meta', '@' + lx.re(RE.ident, lx.p + 1)); prev = 'id'; continue; }

      if (c === open) depth++;
      else if (c === opts.close) depth--;
      if (c === '{') braces++;
      else if (c === '}') braces--;
      lx.emit(null, c);
      prev = c === '>' && s[lx.p - 2] === '=' ? '=>' : c;
      if (opts.statement && c === '}' && braces <= 0 && lx.re(RE.elseLike) === null) return;
    }
  }

  /* HTML (também base de Razor e Vue).
   * opts.razor      reconhece @expressões, @{ }, @if…
   * opts.vue        reconhece {{ expr }}
   * opts.element    lê um único elemento (com filhos) e retorna
   * opts.closeBrace para no '}' de nível 0 (corpo de @section { })
   * opts.until      função de parada */
  function lexHtml(lx, opts = {}) {
    const s = lx.s;
    let depth = 0;
    while (!lx.eof()) {
      if (opts.until && opts.until(lx)) return;
      const c = s[lx.p], c2 = s[lx.p + 1];
      if (opts.closeBrace && c === '}' && depth <= 0) return;
      if (opts.razor && c === '@' && lexRazor(lx)) continue;
      if (opts.vue && c === '{' && c2 === '{') {
        lx.emit('meta', '{{');
        lexCode(lx, 'js', { until: (l) => l.starts('}}') });
        if (lx.starts('}}')) lx.emit('meta', '}}');
        continue;
      }
      if (c === '<') {
        if (lx.starts('<!--')) {
          const e = s.indexOf('-->', lx.p + 4);
          lx.emitTo('com', e < 0 ? lx.n : e + 3);
          continue;
        }
        if (c2 === '!' || c2 === '?') {
          const e = s.indexOf('>', lx.p);
          lx.emitTo('meta', e < 0 ? lx.n : e + 1);
          continue;
        }
        if (c2 === '/') {
          RE.closeTag.lastIndex = lx.p;
          const m = RE.closeTag.exec(s);
          if (m) {
            lx.emit('tag', '</' + m[1]);
            lx.emit('tag', lx.re(RE.closeTagRest));
            depth--;
            if (opts.element && depth <= 0) return;
            continue;
          }
        }
        if (isAlpha(c2)) {
          const tag = lexTag(lx, opts);
          const name = tag.name.toLowerCase();
          if (tag.selfClosing || VOID_TAGS.has(name)) {
            if (opts.element && depth <= 0) return;
            continue;
          }
          depth++;
          if (name === 'script') {
            const ts = /^ts|typescript/i.test(tag.attrs.lang || tag.attrs.type || '');
            lexCode(lx, ts ? 'ts' : 'js', { stop: END_SCRIPT, until: (l) => l.s.slice(l.p, l.p + 8).toLowerCase() === '</script' });
          } else if (name === 'style') {
            lexCss(lx, { stop: END_STYLE, until: (l) => l.s.slice(l.p, l.p + 7).toLowerCase() === '</style' });
          }
          continue;
        }
      }
      if (c === '&') {
        const m = lx.re(RE.entity);
        if (m) { lx.emit('lit', m); continue; }
      }
      lx.emit(null, lx.re(RE.text));
    }
  }

  function lexTag(lx, opts) {
    const s = lx.s;
    lx.emit('tag', '<');
    const name = lx.re(RE.tagName);
    lx.emit('tag', name);
    const attrs = {};
    let selfClosing = false, last = '';
    while (!lx.eof()) {
      const c = s[lx.p];
      if (c === '>') { lx.emit('tag', '>'); break; }
      if (c === '/' && s[lx.p + 1] === '>') { lx.emit('tag', '/>'); selfClosing = true; break; }
      if (/\s/.test(c)) { lx.emit(null, lx.re(RE.ws)); continue; }
      if (opts.razor && c === '@' && lexRazor(lx)) continue;
      if (c === '=') {
        lx.emit(null, '=');
        const q = s[lx.p];
        const start = lx.p;
        if (q === '"' || q === "'") lexAttrValue(lx, q, last, opts);
        else lx.emit('str', lx.re(RE.unquoted));
        attrs[last] = s.slice(start, lx.p).replace(/^["']|["']$/g, '');
        continue;
      }
      const an = lx.re(RE.attrName);
      if (an) { lx.emit('attr', an); last = an.toLowerCase(); continue; }
      lx.emit(null, c);
    }
    return { name, selfClosing, attrs };
  }

  function lexAttrValue(lx, q, attr, opts) {
    const s = lx.s;
    // Vue: :prop, @evento e v-* contêm expressões JS.
    if (opts.vue && /^(?::|@|v-|#)/.test(attr)) {
      lx.emit('str', q);
      lexCode(lx, 'js', { until: (l) => l.s[l.p] === q || l.s[l.p] === '\n' });
      if (s[lx.p] === q) lx.emit('str', q);
      return;
    }
    lx.emit('str', q);
    while (!lx.eof()) {
      let i = lx.p;
      while (i < lx.n && s[i] !== q && !(opts.razor && s[i] === '@')) i++;
      lx.emitTo('str', i);
      if (lx.eof()) return;
      if (s[lx.p] === q) { lx.emit('str', q); return; }
      if (!lexRazor(lx)) lx.emit('str', '@');
    }
  }

  // Trata um '@' do Razor. Retorna false se o '@' é literal (ex.: e-mail).
  function lexRazor(lx) {
    const s = lx.s, p = lx.p, c2 = s[p + 1];
    if (p > 0 && /[\w.]/.test(s[p - 1])) return false;
    if (c2 === '@') { lx.emit(null, '@@'); return true; }
    if (c2 === '*') {
      const e = s.indexOf('*@', p + 2);
      lx.emitTo('com', e < 0 ? lx.n : e + 2);
      return true;
    }
    if (c2 === '{') {
      lx.emit('meta', '@{');
      lexCode(lx, 'cs', { close: '}', razor: true });
      if (s[lx.p] === '}') lx.emit('meta', '}');
      return true;
    }
    if (c2 === '(') {
      lx.emit('meta', '@');
      lx.emit(null, '(');
      lexCode(lx, 'cs', { close: ')' });
      if (s[lx.p] === ')') lx.emit(null, ')');
      return true;
    }
    const id = lx.re(RE.razorIdent, p + 1);
    if (!id) return false;
    const after = lx.re(/\s*\(/y, p + 1 + id.length) !== null;

    if (RAZOR_BLOCKS.has(id) || (id === 'using' && after)) {
      lx.emit('meta', '@');
      lx.emit('kw', id);
      lexCode(lx, 'cs', { razor: true, statement: true });
      return true;
    }
    if (RAZOR_DIRECTIVES.has(id) || id === 'using') {
      lx.emit('meta', '@');
      lx.emit('kw', id);
      lexCode(lx, 'cs', { until: (l) => l.s[l.p] === '\n' });
      return true;
    }
    if (id === 'section' || id === 'functions' || id === 'code') {
      lx.emit('meta', '@');
      lx.emit('kw', id);
      while (!lx.eof() && s[lx.p] !== '{' && s[lx.p] !== '\n') {
        const w = lx.re(RE.ws);
        if (w) lx.emit(null, w);
        else lx.emit('type', lx.re(/[^\s{]+/y));
      }
      if (s[lx.p] === '{') {
        lx.emit('meta', '{');
        if (id === 'section') lexHtml(lx, { razor: true, closeBrace: true });
        else lexCode(lx, 'cs', { close: '}', razor: true });
        if (s[lx.p] === '}') lx.emit('meta', '}');
      }
      return true;
    }
    lx.emit('meta', '@');
    lexImplicit(lx);
    return true;
  }

  // @Model.Items[0].Name, @Html.Raw(x), @await Component.InvokeAsync(...)
  function lexImplicit(lx) {
    const s = lx.s;
    for (;;) {
      const id = lx.re(RE.razorIdent);
      if (!id) return;
      if (id === 'await') {
        lx.emit('kw', id);
        const w = lx.re(/[ \t]+/y);
        if (w) lx.emit(null, w);
        continue;
      }
      lx.emit(s[lx.p + id.length] === '(' ? 'fn' : null, id);
      while (s[lx.p] === '(' || s[lx.p] === '[') {
        const close = s[lx.p] === '(' ? ')' : ']';
        lx.emit(null, s[lx.p]);
        lexCode(lx, 'cs', { close });
        if (s[lx.p] === close) lx.emit(null, close);
      }
      if (s[lx.p] === '.' && /[A-Za-z_]/.test(s[lx.p + 1] || '')) { lx.emit(null, '.'); continue; }
      if (s[lx.p] === '?' && s[lx.p + 1] === '.' && /[A-Za-z_]/.test(s[lx.p + 2] || '')) { lx.emit(null, '?.'); continue; }
      return;
    }
  }

  /* Dentro de um bloco, "nome:" pode iniciar uma declaração (color: red;) ou um seletor
   * aninhado do SCSS/Less (a:hover { ... }). Decide olhando adiante: se um '{' aparece antes
   * de ';' ou '}' (fora de parênteses, strings e #{}), é seletor. */
  function isDeclaration(lx) {
    const s = lx.s;
    let i = lx.p, parens = 0;
    while (i < lx.n) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const e = s.indexOf(ch, i + 1);
        i = e < 0 ? lx.n : e + 1;
        continue;
      }
      if (ch === '#' && s[i + 1] === '{') {
        const e = s.indexOf('}', i);
        i = e < 0 ? lx.n : e + 1;
        continue;
      }
      if (ch === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 ? lx.n : e + 2;
        continue;
      }
      if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (parens <= 0) {
        if (ch === '{') return false;
        if (ch === ';' || ch === '}') return true;
      }
      i++;
    }
    return true;
  }

  const SCSS_FN_AT = words('@include @mixin @function @return');

  function lexCss(lx, opts = {}) {
    const s = lx.s;
    let depth = 0, parens = 0, inValue = false, prop = false, prev = '', lastAt = '', atRule = false;
    const stmtStart = () => prev === '{' || prev === ';' || prev === '}' || prev === '' || prev === '(';
    while (!lx.eof()) {
      if (opts.until && opts.until(lx)) return;
      const c = s[lx.p], c2 = s[lx.p + 1];
      if (/\s/.test(c)) { lx.emit(null, lx.re(RE.ws)); continue; }
      if (c === '/' && c2 === '*') {
        const e = s.indexOf('*/', lx.p + 2);
        lx.emitTo('com', clampEnd(lx, e < 0 ? lx.n : e + 2, opts.stop));
        continue;
      }
      if (c === '/' && c2 === '/' && !inValue) {
        lx.emitTo('com', clampEnd(lx, lx.p + lx.re(RE.lineRest).length, opts.stop));
        continue;
      }
      // SCSS: interpolação #{...} (em seletores, propriedades e valores)
      if (c === '#' && c2 === '{') {
        const e = s.indexOf('}', lx.p);
        lx.emitTo('meta', e < 0 ? lx.n : e + 1);
        continue;
      }
      if (c === '(') parens++;
      else if (c === ')') {
        parens = Math.max(0, parens - 1);
        if (!parens && depth === 0) inValue = false; // fim de (max-width: 600px)
      }
      if (c === '"' || c === "'") { lexQuoted(lx, c); prev = 'str'; continue; }
      // SCSS: $variavel (definição "$x: ..." inicia um valor)
      if (c === '$') {
        const m = lx.re(/\$[\w-]+/y);
        if (m) {
          const decl = !inValue && stmtStart() && lx.re(/\s*:/y, lx.p + m.length) !== null;
          lx.emit('meta', m);
          if (decl) prop = true;
          prev = 'var';
          continue;
        }
      }
      if (c === '@') {
        const m = lx.re(RE.cssAt);
        if (m) {
          // Less: @variavel (no valor ou em "@x: ..."); senão é uma at-rule (@media, @include…)
          const lessVar = inValue || (stmtStart() && lx.re(/\s*:/y, lx.p + m.length) !== null);
          lx.emit(lessVar ? 'meta' : 'kw', m);
          if (lessVar && !inValue) prop = true;
          lastAt = lessVar ? '' : m;
          atRule = !lessVar; // argumentos até o próximo '{' ou ';'
          prev = lessVar ? 'var' : 'at';
          continue;
        }
      }
      if (c === '{' || c === '}' || c === ';') {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        inValue = prop = atRule = false;
        lx.emit(null, c);
        prev = c;
        continue;
      }
      if (c === ':' && prop) {
        inValue = true;
        prop = false;
        lx.emit(null, c);
        continue;
      }
      if (isDigit(c) || ((c === '.' || c === '-') && (isDigit(c2) || (c2 === '.' && isDigit(s[lx.p + 2]))))) {
        const m = lx.re(RE.cssNum);
        if (m) { lx.emit('num', m); continue; }
      }
      // !important, e no SCSS !default / !global
      if (c === '!') {
        const m = lx.re(RE.important);
        if (m) { lx.emit('kw', m); continue; }
      }
      if (inValue) {
        if (c === '#') {
          const m = lx.re(RE.cssHex);
          if (m) { lx.emit('num', m); continue; }
        }
        const id = lx.re(RE.cssIdent);
        if (id) { lx.emit(s[lx.p + id.length] === '(' ? 'fn' : 'lit', id); continue; }
      } else {
        if (c === '.' || c === '#') {
          const m = lx.re(RE.cssSel);
          if (m) { lx.emit('type', m); prev = 'sel'; continue; }
        }
        if (c === '%') { // SCSS: %placeholder
          const m = lx.re(/%[\w-]+/y);
          if (m) { lx.emit('type', m); prev = 'sel'; continue; }
        }
        if (c === ':') {
          const m = lx.re(RE.cssPseudo);
          if (m) { lx.emit('meta', m); prev = 'sel'; continue; }
        }
        const id = lx.re(RE.cssIdent);
        if (id) {
          const feature = parens > 0 && lx.re(/\s*:(?!:)/y, lx.p + id.length) !== null; // (min-width: …)
          if (atRule && !feature) {
            // @include nome(args), @mixin nome, @media screen and …: só o nome do mixin é colorido
            lx.emit(prev === 'at' && SCSS_FN_AT.has(lastAt) ? 'fn' : null, id);
            prev = 'atarg';
          } else if ((depth > 0 || parens > 0) && stmtStart() &&
                     lx.re(/\s*:(?!:)/y, lx.p + id.length) !== null && (parens > 0 || isDeclaration(lx))) {
            lx.emit('attr', id);
            prop = true;
            prev = 'prop';
          } else {
            lx.emit('tag', id);
            prev = 'sel';
          }
          continue;
        }
      }
      lx.emit(null, c);
      if (c !== ',' && c !== '>' && c !== '+' && c !== '~') prev = c;
    }
  }

  /* Strings do Python: prefixos r/b/u/f (e combinações como rb, fr), aspas simples/duplas,
   * triplas (várias linhas) e f-strings com {expr}. Retorna false se não for string. */
  function lexPyString(lx) {
    RE.pyString.lastIndex = lx.p;
    const m = RE.pyString.exec(lx.s);
    if (!m || !/^(?:[rRuU]|[bB][rR]?|[rR][bBfF]|[fF][rR]?)?$/.test(m[1])) return false;
    const s = lx.s, q = m[2], triple = q.length === 3, f = /f/i.test(m[1]);
    let i = lx.p + m[0].length;
    while (i < lx.n) {
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (s.startsWith(q, i)) { i += q.length; break; }
      if (!triple && ch === '\n') break;
      if (f && ch === '{') {
        if (s[i + 1] === '{') { i += 2; continue; }
        lx.emitTo('str', i);
        lx.emit('meta', '{');
        lexPython(lx, { close: '}' });
        if (s[lx.p] === '}') lx.emit('meta', '}');
        i = lx.p;
        continue;
      }
      if (f && ch === '}' && s[i + 1] === '}') { i += 2; continue; }
      i++;
    }
    lx.emitTo('str', Math.min(i, lx.n));
    return true;
  }

  /* match/case são palavras-chave "suaves": só valem no início de uma instrução e quando
   * não são usadas como nome (match = ..., match.group(), match(...)). */
  const PY_SOFT_KW = words('match case');
  function isSoftKeyword(lx, id) {
    if (!atLineStart(lx)) return false;
    return lx.re(/[ \t]*[=.,)(:\]]/y, lx.p + id.length) === null || lx.re(/[ \t]+\(/y, lx.p + id.length) !== null;
  }

  // Python. opts.close = '}' para no fechamento de um {expr} de f-string (não consome).
  function lexPython(lx, opts = {}) {
    const s = lx.s;
    let depth = 0, prev = '';
    while (!lx.eof()) {
      const c = s[lx.p], c2 = s[lx.p + 1];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { lx.emit(null, lx.re(RE.ws)); continue; }
      if (c === '#') { lx.emit('com', lx.re(RE.lineRest)); continue; }
      if (opts.close && c === opts.close && depth === 0) return;
      if ((c === '"' || c === "'" || /[rRbBuUfF]/.test(c)) && lexPyString(lx)) { prev = 'str'; continue; }
      if (c === '@' && atLineStart(lx)) {
        const m = lx.re(RE.pyDecorator);
        if (m && m.length > 1) { lx.emit('meta', m); prev = 'id'; continue; }
      }
      if (isDigit(c) || (c === '.' && isDigit(c2))) { lx.emit('num', lx.re(RE.num)); prev = 'num'; continue; }
      const id = lx.re(RE.pyIdent);
      if (id) {
        const member = prev === '.';
        let cls;
        if (!member && PY_KW.has(id) && (!PY_SOFT_KW.has(id) || isSoftKeyword(lx, id))) cls = 'kw';
        else if (!member && PY_LIT.has(id)) cls = 'lit';
        else if (prev === 'kw:def') cls = 'fn';
        else if (prev === 'kw:class') cls = 'type';
        else if (lx.re(RE.call, lx.p + id.length) !== null) cls = 'fn';
        else if (isConstName(id)) cls = 'lit';
        else if (member) cls = null;
        else if (PY_TYPES.has(id) || /^[A-Z]/.test(id)) cls = 'type';
        else cls = null;
        lx.emit(cls, id);
        prev = cls === 'kw' ? 'kw:' + id : 'id';
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      lx.emit(null, c);
      prev = c;
    }
  }

  function tokenize(text, lang) {
    const lx = new Lexer(text);
    while (!lx.eof()) {
      const before = lx.p;
      if (lang === 'css') lexCss(lx);
      else if (lang === 'html') lexHtml(lx);
      else if (lang === 'vue') lexHtml(lx, { vue: true });
      else if (lang === 'razor') lexHtml(lx, { razor: true });
      else if (lang === 'py') lexPython(lx);
      else lexCode(lx, lang);
      if (lx.p === before) lx.emit(null, text[lx.p]); // segurança: sempre avança
    }
    return lx.out;
  }

  function toLines(tokens) {
    const lines = [[]];
    for (const [cls, text] of tokens) {
      let start = 0, i;
      while ((i = text.indexOf('\n', start)) >= 0) {
        if (i > start) lines[lines.length - 1].push([cls, text.slice(start, i)]);
        lines.push([]);
        start = i + 1;
      }
      if (start < text.length) lines[lines.length - 1].push([cls, text.slice(start)]);
    }
    return lines;
  }

  const EXT = {
    cs: 'cs', csx: 'cs',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', json: 'js',
    ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    cshtml: 'razor', razor: 'razor',
    vue: 'vue',
    py: 'py', pyw: 'py', pyi: 'py',
    java: 'java',
    c: 'c',
    // .h pode ser C ou C++; as palavras-chave de C++ incluem as de C.
    h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  };

  const MAX_CHARS = 1.5 * 1024 * 1024;

  // Nomes exibidos na interface (dica do botão Sintaxe). Fonte única: ao adicionar uma
  // linguagem, atualize EXT e esta lista. As traduções usam {langs} e não precisam mudar.
  const LANGUAGES = ['C#', 'JavaScript/JSX', 'TypeScript/TSX', 'HTML', 'CSS/SCSS/Less', 'Razor', 'Vue',
    'Python', 'C', 'C++', 'Java'];

  window.Highlight = {
    MAX_CHARS,
    LANGUAGES,
    langFor(path) {
      const i = path.lastIndexOf('.');
      return i < 0 ? null : EXT[path.slice(i + 1).toLowerCase()] || null;
    },
    tokenize,
    /** Tokens por linha, ou null se o texto for grande demais. */
    lines(text, lang) {
      if (!lang || text.length > MAX_CHARS) return null;
      return toLines(tokenize(text, lang));
    },
  };
})();

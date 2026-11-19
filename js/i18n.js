/* Internacionalização.
 *
 * Idiomas ficam em js/locales/<código>.js e se registram com:
 *   I18n.register('en', { name: 'English', messages: { ... } });
 *
 * Mensagens:
 *   - texto simples com parâmetros:  'Hello {name}'
 *   - plural (Intl.PluralRules):     { one: '{count} file', other: '{count} files', zero?: '...' }
 *   - chaves aninhadas, acessadas com ponto: t('toolbar.openFolder')
 *
 * HTML estático:
 *   data-i18n="key"                     -> textContent
 *   data-i18n-html="key"                -> innerHTML (só para textos do dicionário, que são confiáveis)
 *   data-i18n-attr="title:key;placeholder:key2"
 *
 * Chave ausente no idioma atual cai para o idioma padrão (en) e, por fim, para a própria chave.
 * Para ver o que falta traduzir: I18n.missing('pt-BR') no console.
 */
(function () {
  'use strict';

  const DEFAULT = 'en';
  const STORAGE_KEY = 'gitdiff:locale';
  const locales = {};
  const listeners = [];
  const warned = new Set();
  let current = DEFAULT;

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function register(code, def) {
    locales[code] = def;
  }

  function lookup(code, key) {
    let node = locales[code] && locales[code].messages;
    for (const part of key.split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }

  function resolve(key) {
    let v = lookup(current, key);
    if (v === undefined && current !== DEFAULT) {
      v = lookup(DEFAULT, key);
      if (v !== undefined && !warned.has(current + ':' + key)) {
        warned.add(current + ':' + key);
        console.warn(`[i18n] "${key}" sem tradução em "${current}"`);
      }
    }
    return v;
  }

  function format(key, params, escape) {
    let v = resolve(key);
    if (v === undefined) return key;
    if (typeof v === 'object') {
      const n = Number(params.count);
      v = (n === 0 && v.zero !== undefined ? v.zero : v[new Intl.PluralRules(current).select(n)]) ?? v.other;
    }
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (k in params ? (escape ? escapeHtml(params[k]) : String(params[k])) : m));
  }

  /** Texto puro (para textContent, title, toast…). */
  const t = (key, params = {}) => format(key, params, false);

  /** HTML: a tradução pode conter marcação; os parâmetros são escapados. */
  const html = (key, params = {}) => format(key, params, true);

  function apply(root = document) {
    for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = html(n.dataset.i18nHtml);
    for (const n of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of n.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) n.setAttribute(attr, t(key));
      }
    }
  }

  function setLocale(code) {
    if (!locales[code]) code = DEFAULT;
    current = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* sem storage */ }
    document.documentElement.lang = code;
    apply();
    for (const fn of listeners) fn(code);
  }

  function init() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* sem storage */ }
    current = saved && locales[saved] ? saved : DEFAULT;
    document.documentElement.lang = current;
    apply();
  }

  /** Chaves presentes no idioma padrão que faltam em `code`. */
  function missing(code) {
    const out = [];
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node)) {
        const key = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !('other' in v)) walk(v, key);
        else if (lookup(code, key) === undefined) out.push(key);
      }
    };
    walk(locales[DEFAULT].messages, '');
    return out;
  }

  window.I18n = {
    register,
    init,
    t,
    html,
    apply,
    setLocale,
    missing,
    onChange: (fn) => listeners.push(fn),
    get locale() { return current; },
    available: () => Object.entries(locales).map(([code, d]) => ({ code, name: d.name })),
  };
  window.t = t;
})();

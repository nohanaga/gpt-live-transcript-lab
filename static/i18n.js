// UI localization. Japanese is the source language: UI strings are written in Japanese and
// wrapped in t(), and index.html is authored in Japanese. In English mode, t() and
// translateDocument() look the Japanese text up in the English dictionary.
// locale.js (a classic script in <head>) decides the language before first paint and
// stores it on <html lang>, so this module, theme.js, and CSS all agree.
import english from './i18n-en.js';

export const LANGUAGES = ['ja', 'en'];
export const LANGUAGE_STORAGE_KEY = 'transcript-lab-language';
export const language = globalThis.document?.documentElement?.lang === 'en' ? 'en' : 'ja';

const PLACEHOLDER = /\{(\d+)\}/g;
const TRANSLATED_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'label'];

export function translate(text, target = language) {
  return target === 'en' && Object.hasOwn(english, text) ? english[text] : text;
}

// Translate a Japanese UI string; {0}, {1}, ... are replaced by the extra arguments.
export function t(text, ...values) {
  const template = translate(text);
  if (!values.length) return template;
  return template.replace(PLACEHOLDER, (match, index) => (index < values.length ? String(values[index]) : match));
}

function translateText(value) {
  const key = value.replace(/\s+/g, ' ').trim();
  if (!key) return value;
  const result = translate(key);
  if (result === key) return value;
  // Keep the surrounding whitespace so inline layout does not change.
  return value.match(/^\s*/)[0] + result + value.match(/\s*$/)[0];
}

// Translate the static Japanese markup of index.html (text, labels, and tooltips) in place.
export function translateDocument(root = globalThis.document) {
  if (language !== 'en' || !root) return;
  const walker = root.createTreeWalker(root.body ?? root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script, style')) continue;
    node.nodeValue = translateText(node.nodeValue);
  }
  for (const element of (root.body ?? root).querySelectorAll('*')) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      if (element.hasAttribute(name)) element.setAttribute(name, translateText(element.getAttribute(name)));
    }
    if (element.tagName === 'INPUT' && element.hasAttribute('value') && element.type === 'text') {
      element.value = translateText(element.getAttribute('value'));
    }
  }
  root.title = translateText(root.title);
  const description = root.querySelector('meta[name="description"]');
  if (description) description.content = translateText(description.content);
}

// Persist the choice and reload: server messages, prompts, and the replay data follow the
// language of the page, so a clean reload is the only consistent way to switch.
export function switchLanguage(next) {
  if (!LANGUAGES.includes(next) || next === language) return;
  try {
    globalThis.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Storage may be blocked; the URL parameter below still applies to this reload.
  }
  const url = new URL(globalThis.location.href);
  url.searchParams.set('lang', next);
  globalThis.location.assign(url);
}

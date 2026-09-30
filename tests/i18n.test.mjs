import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import english from '../static/i18n-en.js';
import { language, t, translate } from '../static/i18n.js';

const JAPANESE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
const read = (name) => readFileSync(new URL(`../static/${name}`, import.meta.url), 'utf8');
const placeholders = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort();
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('Japanese is the default and t() interpolates positional values', () => {
  assert.equal(language, 'ja');
  assert.equal(t('天気'), '天気');
  assert.equal(t('{0} / {1} 件', 3, 'x'), '3 / x 件');
  assert.equal(translate('ライブ接続', 'en'), 'Live connection');
  assert.equal(translate('未登録の文字列', 'en'), '未登録の文字列');
});

test('the English dictionary is complete for every t() call', () => {
  const missing = [];
  for (const file of ['app.js', 'trace-view.js', 'trace-model.js', 'lab-model.js', 'scenarios.js']) {
    const source = read(file);
    for (const [, literal] of source.matchAll(/\bt\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
      const key = new Function(`return ${literal}`)();
      if (!Object.hasOwn(english, key)) missing.push(`${file}: ${key}`);
    }
    // Every Japanese string must go through t(): nothing Japanese may remain outside t('...').
    const outside = source.replace(/\bt\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g, 't(');
    for (const line of outside.split('\n')) {
      if (JAPANESE.test(line.replace(/'日本語(?:に切り替え)?'/g, ''))) missing.push(`${file}: untranslated ${line.trim()}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the English dictionary covers the static Japanese markup', () => {
  const html = read('index.html');
  const missing = [];
  const pattern = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<[^>]+>|[^<]+/g;
  for (const [token] of html.matchAll(pattern)) {
    const values = token.startsWith('<')
      ? [...token.matchAll(/\s(?:aria-label|title|placeholder|alt|label|value|content)="([^"]*)"/g)].map((match) => match[1])
      : [token];
    for (const value of values) {
      const key = normalize(decode(value));
      if (JAPANESE.test(key) && !token.startsWith('<!--') && !Object.hasOwn(english, key)) missing.push(key);
    }
  }
  assert.deepEqual(missing, []);
});

test('English translations are English and keep every placeholder', () => {
  for (const [key, value] of Object.entries(english)) {
    assert.ok(JAPANESE.test(key), `key without Japanese: ${key}`);
    assert.doesNotMatch(value, JAPANESE, `Japanese left in translation of ${key}`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholders differ for ${key}`);
  }
});

test('English mode translates scenarios, timeline captions, and errors', () => {
  // A fresh process gives a fresh module graph with <html lang="en">.
  const script = `
    globalThis.document = { documentElement: { lang: 'en' } };
    const { language, t } = await import('./static/i18n.js');
    const { scenarios } = await import('./static/scenarios.js');
    const { resolveOptions } = await import('./static/lab-model.js');
    let optionError = '';
    try { resolveOptions({ minTurnSeparationMs: -1 }); } catch (error) { optionError = error.message; }
    console.log(JSON.stringify({
      language, scenarios, optionError,
      replay: t('{0} / {1} 件', 1, 2),
    }));
  `;
  const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }));
  assert.equal(output.language, 'en');
  assert.doesNotMatch(JSON.stringify(output.scenarios), JAPANESE);
  assert.equal(output.scenarios[0].title, '01 · Basic fragments');
  const correction = output.scenarios.find((item) => item.id === 'late-correction');
  const deltas = correction.events.map(({ event }) => event.delta).filter(Boolean);
  assert.deepEqual(deltas, ['Tokyo', ', no, Osaka.']);
  assert.match(output.optionError, /Enter/);
  assert.doesNotMatch(output.optionError, JAPANESE);
});

test('locale.js picks the URL, then the saved choice, then the browser language', () => {
  const run = ({ search = '', stored = null, languages = ['ja-JP'], blocked = false }) => {
    const root = {};
    const writes = [];
    const localStorage = {
      getItem: () => { if (blocked) throw new Error('blocked'); return stored; },
      setItem: (key, value) => { if (blocked) throw new Error('blocked'); writes.push([key, value]); },
    };
    runInNewContext(read('locale.js'), {
      document: { documentElement: root },
      window: { location: { search }, localStorage, navigator: { languages, language: languages[0] } },
      URLSearchParams,
    });
    return { language: root.lang, writes };
  };
  assert.deepEqual(run({ search: '?lang=en' }), { language: 'en', writes: [['transcript-lab-language', 'en']] });
  assert.deepEqual(run({ search: '?lang=xx', stored: 'en' }), { language: 'en', writes: [] });
  assert.equal(run({ stored: 'ja', languages: ['en-US'] }).language, 'ja');
  assert.equal(run({ languages: ['en-US'] }).language, 'en');
  assert.equal(run({ languages: ['ja'] }).language, 'ja');
  assert.equal(run({ languages: ['fr-FR'], blocked: true }).language, 'en');
});

test('theme labels follow the page language', () => {
  const root = { dataset: {}, lang: 'en' };
  const button = Object.assign(new EventTarget(), {
    attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
  });
  const document = Object.assign(new EventTarget(), {
    documentElement: root, getElementById: (id) => (id === 'theme-toggle' ? button : { hidden: true }),
  });
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  runInNewContext(read('theme.js'), { document, window, Event, DOMException, console });
  document.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(button.attributes['aria-label'], 'Switch to dark theme');
  button.dispatchEvent(new Event('click'));
  assert.equal(button.attributes['aria-label'], 'Switch to light theme');
});

test('the language toggle is loaded before theme.js and offered in the header', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('src="/static/locale.js"') < html.indexOf('src="/static/theme.js"'));
  assert.match(html, /id="language-toggle"[^>]*type="button"/);
  const app = read('app.js');
  assert.match(app, /\/ws\?lang=\$\{language\}/);
  assert.match(app, /\/api\/config\?lang=\$\{language\}/);
  assert.match(app, /delegation_mode: \$\('delegation-mode'\)\.value, language,/);
});

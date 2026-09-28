import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TranscriptGrouper } from '../static/vendor/grouper.js';
import {
  createEventAdapter, readGrouperDiagnostics, resolveOptions,
  splitLedgerText, waitForIce,
} from '../static/lab-model.js';
import { scenarios } from '../static/scenarios.js';
import {
  OperationTimeline, parseServerTiming, projectSpans, layoutSpans, visibleSpans, timelineGeometry, timelineBounds,
  LANES, TRACE_COMPONENTS, LANE_COMPONENTS, liveEventPresentation,
  transcriptPresentation, transcriptLaneLayout,
} from '../static/trace-model.js';
import { instrumentGrouper } from '../static/grouper-trace.js';
import { WaveformHistory, waveformColumns, LiveWaveformCapture } from '../static/audio-waveform.js';

const delta = (event_id, text, start_ms = 0, end_ms = 100, speaker = 'input') => ({
  type: `session.${speaker}_transcript.delta`, event_id, delta: text, start_ms, end_ms,
});

test('browser entrypoint and DOM renderer parse successfully', () => {
  for (const name of ['app.js', 'trace-view.js', 'audio-waveform.js', 'waveform-processor.js', 'theme.js']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../static/${name}`, import.meta.url))]);
  }
});

function themeHarness({ stored = null, dark = false, readError, writeError } = {}) {
  const root = { dataset: {} };
  const button = Object.assign(new EventTarget(), {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const status = { textContent: '', hidden: true };
  const document = Object.assign(new EventTarget(), {
    documentElement: root,
    getElementById: (id) => id === 'theme-toggle' ? button : status,
  });
  const system = Object.assign(new EventTarget(), { matches: dark });
  const writes = [];
  const warnings = [];
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => system,
    localStorage: {
      getItem: () => { if (readError) throw readError; return stored; },
      setItem: (key, value) => { if (writeError) throw writeError; writes.push([key, value]); },
    },
  });
  let changes = 0;
  window.addEventListener('themechange', () => { changes += 1; });
  runInNewContext(readFileSync(new URL('../static/theme.js', import.meta.url), 'utf8'), {
    document, window, Event, DOMException, console: { warn: (...args) => warnings.push(args) },
  });
  return {
    root, button, status, system, writes, warnings,
    changes: () => changes,
    ready: () => document.dispatchEvent(new Event('DOMContentLoaded')),
    click: () => button.dispatchEvent(new Event('click')),
    storage: (key, newValue) => window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue })),
  };
}

test('theme uses system preference before first paint and applies a saved override', () => {
  for (const [stored, dark, expected] of [
    [null, false, 'light'], [null, true, 'dark'],
    ['light', true, 'light'], ['dark', false, 'dark'], ['invalid', true, 'dark'],
  ]) {
    const ui = themeHarness({ stored, dark });
    assert.equal(ui.root.dataset.theme, expected);
    ui.ready();
    assert.equal(ui.button.attributes['aria-label'], expected === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え');
    assert.equal(ui.button.title, ui.button.attributes['aria-label']);
    assert.equal(ui.status.hidden, true);
    assert.deepEqual(ui.writes, []);
  }
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="/static/theme.js"') < html.indexOf('href="/static/styles.css"'));
  assert.match(html, /id="theme-toggle"[^>]*type="button"[^>]*aria-label=/);
  assert.match(html, /name="color-scheme" content="light dark"/);
});

test('theme icon toggle persists both choices and stops following the system after manual selection', () => {
  const ui = themeHarness();
  ui.ready();
  ui.system.matches = true;
  ui.system.dispatchEvent(new Event('change'));
  assert.equal(ui.root.dataset.theme, 'dark');
  ui.click();
  assert.equal(ui.root.dataset.theme, 'light');
  assert.equal(ui.button.attributes['aria-label'], 'ダークテーマに切り替え');
  ui.system.dispatchEvent(new Event('change'));
  assert.equal(ui.root.dataset.theme, 'light');
  ui.click();
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.button.attributes['aria-label'], 'ライトテーマに切り替え');
  assert.deepEqual(ui.writes, [['transcript-lab-theme', 'light'], ['transcript-lab-theme', 'dark']]);
  assert.equal(ui.changes(), 5);
});

test('theme follows cross-tab changes without overwriting preferences or reacting to other keys', () => {
  const ui = themeHarness({ stored: 'dark' });
  ui.ready();
  ui.storage('unrelated', 'light');
  assert.equal(ui.root.dataset.theme, 'dark');
  ui.storage('transcript-lab-theme', 'light');
  assert.equal(ui.root.dataset.theme, 'light');
  ui.storage('transcript-lab-theme', 'dark');
  assert.equal(ui.root.dataset.theme, 'dark');
  ui.storage(null, null);
  assert.equal(ui.root.dataset.theme, 'light');
  assert.deepEqual(ui.writes, []);
});

test('theme reports blocked persistence while keeping the switch usable and propagates unexpected errors', () => {
  const ui = themeHarness({
    readError: new DOMException('Blocked', 'SecurityError'),
    writeError: new DOMException('Full', 'QuotaExceededError'),
  });
  ui.ready();
  assert.equal(ui.status.hidden, false);
  assert.match(ui.status.textContent, /保存できません/);
  ui.click();
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.status.hidden, false);
  assert.equal(ui.warnings.length, 2);
  assert.throws(() => themeHarness({ readError: new TypeError('Unexpected') }), /Unexpected/);
});

test('page layout is fluid and loads theme styling for controls and waveforms', () => {
  const css = readFileSync(new URL('../static/styles.css', import.meta.url), 'utf8');
  const themes = readFileSync(new URL('../static/theme.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  assert.match(css, /main\{width:100%;margin:0;/);
  assert.match(css, /footer\{width:100%;margin:0;/);
  assert.doesNotMatch(css, /1320px/);
  assert.match(html, /href="\/static\/theme.css"/);
  assert.match(themes, /color-scheme: light/);
  assert.match(themes, /color-scheme: dark/);
  assert.equal((themes.match(/--waveform-input:/g) ?? []).length, 2);
  assert.equal((themes.match(/--waveform-output:/g) ?? []).length, 2);
});

test('default controls select live first and native horizontal timeline scale', () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="mode-live"') < html.indexOf('id="mode-replay"'));
  assert.match(html, /id="mode-live" class="mode active" aria-pressed="true"/);
  assert.match(html, /id="replay-controls" hidden/);
  assert.match(html, /id="live-controls">/);
  assert.doesNotMatch(html, /<select id="trace-(axis|zoom)"/);
  assert.match(html, /id="trace-axis"[^>]*role="group" aria-label="時間軸"/);
  assert.match(html, /data-axis="local" aria-pressed="true"/);
  assert.match(html, /data-axis="source" aria-pressed="false"/);
  assert.match(html, /id="trace-zoom"[^>]*role="group" aria-label="表示倍率"/);
  assert.match(html, /data-zoom="1000" aria-pressed="true"/);
  for (const zoom of ['0', '100', '500', '2000']) {
    assert.match(html, new RegExp(`data-zoom="${zoom}" aria-pressed="false"`));
  }
  assert.match(html, /id="trace-text" type="checkbox" checked/);
  assert.match(html, /id="trace-text-only" type="checkbox">/);
});

test('timeline-first layout keeps a unique DOM contract and folds supporting panels below the chart', () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const file of ['app.js', 'trace-view.js']) {
    const source = readFileSync(new URL(`../static/${file}`, import.meta.url), 'utf8');
    for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(ids.includes(id), `${file} requires #${id}`);
    }
  }
  assert.match(html, /<h1 id="operation-title">内部処理タイムライン<\/h1>/);
  assert.match(html, /href="#operation-workspace"/);
  assert.doesNotMatch(html, /class="intro"/);
  for (const id of ['session-settings', 'transcript-panels']) {
    assert.ok(html.indexOf('id="operation-chart"') < html.indexOf(`id="${id}"`));
  }
  assert.doesNotMatch(html, /<details[^>]*(?:auxiliary-panel|trace-help|trace-filter-panel)[^>]*\sopen/);
});

test('compact live and pause controls expose action labels while retaining their SVG icons', () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  for (const [id, label, icons] of [
    ['connect-live', 'マイクを許可して接続', 1], ['stop-live', '接続を終了', 1],
    ['mute', 'マイクをミュート', 2], ['trace-pause', '表示を一時停止', 2],
  ]) {
    const button = html.match(new RegExp(`<button id="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0];
    assert.ok(button, id);
    assert.ok(button.includes(`aria-label="${label}"`));
    assert.match(button, /title="/);
    assert.equal((button.match(/<svg\b/g) ?? []).length, icons);
    assert.equal((button.match(/aria-hidden="true"/g) ?? []).length, icons);
  }
  const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../static/trace-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\$\('mute'\)\.textContent\s*=/);
  assert.doesNotMatch(view, /\$\('trace-pause'\)\.textContent\s*=/);
});

test('timeline geometry keeps native scale for short and long sessions at any viewport width', () => {
  for (const available of [135, 700, 1200]) {
    for (const duration of [100, 5000, 240_000, 3_600_000]) {
      const geometry = timelineGeometry(0, duration, available, 1000);
      assert.equal(geometry.scale, 1);
      assert.equal(geometry.width, Math.max(available, duration));
      assert.equal(geometry.tickStep * geometry.scale, 100);
      assert.equal(250 * geometry.scale, 250);
    }
  }
  assert.equal(timelineGeometry(0, 100, 700, 500).scale, 0.5);
  assert.equal(timelineGeometry(0, 240_000, 700, 2000).scale, 2);
});

test('timeline geometry fits the full duration to the viewport only in overview mode', () => {
  for (const duration of [100, 5000, 240_000]) {
    const geometry = timelineGeometry(0, duration, 700, 0);
    assert.equal(geometry.width, 700);
    assert.equal(geometry.scale, 700 / duration);
    assert.ok(Math.abs(duration * geometry.scale - 700) < 0.001);
  }
});

const envelope = (start_ms, min = -0.5, max = 0.5, rms = 0.3) => ({
  start_ms, end_ms: start_ms + 20, min, max, rms,
});

test('waveform history retains every sample beyond ten minutes and exports envelopes without raw audio', () => {
  const history = new WaveformHistory();
  for (let i = 0; i < 30_010; i += 1) history.append('input', envelope(i * 20));
  history.append('output', envelope(10));
  assert.equal(history.channels.input.samples.length, 30_010);
  assert.equal(history.channels.input.samples[0].start_ms, 0);
  assert.equal(history.channels.input.samples.at(-1).start_ms, 600_180);
  assert.equal(history.channels.input.dropped, 0);
  assert.equal(history.channels.output.samples.length, 1);
  assert.equal(history.channels.output.dropped, 0);
  assert.equal(history.export().interval_ms, 20);
  assert.equal(history.export().limit_per_channel, null);
  assert.equal(history.export().retention, 'until-reset');
  assert.deepEqual(Object.keys(history.channels.input.samples[0]), ['start_ms', 'end_ms', 'min', 'max', 'rms']);
  assert.throws(() => history.append('unknown', envelope(60)), /Unknown waveform channel/);
  for (const invalid of [envelope(0), envelope(NaN), envelope(60, 1, -1), envelope(60, -1, 1, -1)]) {
    assert.throws(() => history.append('input', invalid), /Invalid or out-of-order/);
  }
  assert.equal(history.channels.input.samples.length, 30_010);
  assert.equal(waveformColumns(history.channels.input.samples, 0, 1, 20)[0].max, 0.5);
  const snapshotCount = history.channels.output.samples.length;
  history.append('output', envelope(30));
  assert.ok(waveformColumns(history.channels.output.samples, 40, 1, 10, snapshotCount).every((value) => value === null));
  assert.equal(waveformColumns(history.channels.output.samples, 40, 1, 10)[0].max, 0.5);
});

test('waveform pixel projection shares timeline scale, preserves peaks at overview zoom and leaves gaps blank', () => {
  const samples = [envelope(100), envelope(120, -0.9, 0.8, 0.4), envelope(180, 0, 0, 0)];
  const native = waveformColumns(samples, 100, timelineGeometry(0, 200, 100, 1000).scale, 100);
  assert.equal(native.length, 100);
  assert.equal(native[0].min, -0.5);
  assert.equal(native[20].min, -0.9);
  assert.equal(native[40], null);
  assert.equal(native[79], null);
  assert.deepEqual(native[80], { min: 0, max: 0, rms: 0 });
  assert.deepEqual(waveformColumns(samples, 100, 0.01, 1), [{ min: -0.9, max: 0.8, rms: 0.4 }]);
  assert.equal(waveformColumns(samples, 120, 2, 40)[0].max, 0.8);
  assert.ok(waveformColumns(samples, 200, 1, 100).every((column) => column === null));
  assert.deepEqual(waveformColumns(samples, 100, 1, 0), []);
});

test('waveform worklet measures exact 20ms windows across render quanta and emits silence after mute', () => {
  let Processor;
  const messages = [];
  const scope = {
    sampleRate: 48_000, currentFrame: 0,
    AudioWorkletProcessor: class { port = { postMessage: (data) => messages.push(data) }; },
    registerProcessor: (name, implementation) => {
      assert.equal(name, 'transcript-waveform');
      Processor = implementation;
    },
  };
  runInNewContext(readFileSync(new URL('../static/waveform-processor.js', import.meta.url), 'utf8'), scope);
  const processor = new Processor({ processorOptions: { intervalMs: 20 } });
  for (let block = 0; block < 15; block += 1) {
    const positive = new Float32Array(128).fill(0.5);
    const negative = new Float32Array(128).fill(-0.5);
    const output = new Float32Array(128);
    assert.equal(processor.process([[positive, negative]], [[output]]), true);
    assert.ok(output.every((sample) => sample === 0), 'analysis output must not echo or duplicate audio');
    scope.currentFrame += 128;
  }
  assert.equal(messages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { start_ms: 0, end_ms: 20, min: -0.5, max: 0.5, rms: 0.5 },
    { start_ms: 20, end_ms: 40, min: -0.5, max: 0.5, rms: 0.5 },
  ]);
  for (let block = 0; block < 8; block += 1) {
    processor.process([[new Float32Array(128)]]);
    scope.currentFrame += 128;
  }
  assert.equal(messages.at(-1).end_ms, 60);
  assert.equal(messages.at(-1).rms, 0);
  assert.equal(messages.at(-1).min, 0);
  assert.equal(messages.at(-1).max, 0);
  const count = messages.length;
  processor.process([[]]);
  assert.equal(messages.length, count, 'missing media must not be fabricated as an audio window');
});

class MockAudioContext extends EventTarget {
  currentTime = 0;
  state = 'suspended';
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() {
    return { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
  }
  async resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
  async close() { this.state = 'closed'; this.dispatchEvent(new Event('statechange')); }
}

class MockWorkletNode extends EventTarget {
  port = { onmessage: null, closed: false, close() { this.closed = true; } };
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
}

test('waveform capture aligns clocks, handles suspension, stops nodes, and isolates reset generations', async () => {
  let time = 100;
  const timeline = new OperationTimeline(() => time);
  const states = [];
  const errors = [];
  const capture = new LiveWaveformCapture(timeline, {
    AudioContext: MockAudioContext, AudioWorkletNode: MockWorkletNode,
    onStateChange: (state) => states.push(state), onError: (error) => errors.push(error),
  });
  time = 200;
  await capture.resume();
  await capture.attach('input', {});
  const entry = capture.entries.get('input');
  const receive = entry.processor.port.onmessage;
  receive({ data: envelope(0) });
  assert.equal(timeline.waveforms.channels.input.samples[0].start_ms, 100);
  assert.equal(timeline.export().audio_waveforms.channels.input.samples.length, 1);
  capture.context.currentTime = 0.02;
  capture.context.state = 'suspended';
  capture.context.dispatchEvent(new Event('statechange'));
  time = 1200;
  await capture.resume();
  receive({ data: envelope(20) });
  assert.equal(timeline.waveforms.channels.input.samples[1].start_ms, 1100);
  receive({ data: envelope(NaN) });
  assert.equal(errors.length, 1);
  timeline.reset('live');
  receive({ data: envelope(40) });
  assert.equal(timeline.waveforms.channels.input.samples.length, 0);
  assert.equal(timeline.export().audio_waveforms.channels.input.dropped, 0);
  await capture.stop();
  await capture.stop();
  assert.equal(capture.context.state, 'closed');
  assert.equal(entry.source.connected, false);
  assert.equal(entry.processor.connected, false);
  assert.equal(entry.processor.port.closed, true);
  assert.equal(capture.entries.size, 0);
  assert.deepEqual(states, ['suspended', 'running', 'suspended', 'running']);
});

test('waveform capture cannot attach after stop and surfaces module or processor errors', async () => {
  const timeline = new OperationTimeline(() => 0);
  const errors = [];
  const options = {
    AudioContext: MockAudioContext, AudioWorkletNode: MockWorkletNode,
    onStateChange: () => {}, onError: (error) => errors.push(error.message),
  };
  const capture = new LiveWaveformCapture(timeline, options);
  await capture.attach('output', {});
  capture.entries.get('output').processor.dispatchEvent(new Event('processorerror'));
  assert.deepEqual(errors, ['Audio waveform processor failed.']);
  await capture.stop();
  await capture.attach('input', {});
  assert.equal(capture.entries.size, 0);
  class FailedContext extends MockAudioContext {
    audioWorklet = { addModule: async () => { throw new Error('Module blocked'); } };
  }
  const failed = new LiveWaveformCapture(timeline, { ...options, AudioContext: FailedContext });
  await assert.rejects(failed.attach('input', {}), /Module blocked/);
  await failed.stop();
  assert.throws(() => new LiveWaveformCapture(timeline, { ...options, AudioContext: null }), /unavailable/);
});

test('trace components own every lane exactly once and distinguish local timing support', () => {
  const lanes = Object.values(TRACE_COMPONENTS).flatMap((component) => component.lanes);
  assert.equal(lanes.length, new Set(lanes).size);
  assert.deepEqual([...lanes].sort(), Object.keys(LANES).sort());
  assert.equal(LANE_COMPONENTS.input, 'app');
  assert.equal(LANE_COMPONENTS.live_input, 'live');
  assert.equal(LANE_COMPONENTS.segment, 'grouper');
  assert.equal(LANE_COMPONENTS.handoff, 'ledger');
  assert.equal(TRACE_COMPONENTS.ledger.sourceTime, true);
  assert.equal(LANE_COMPONENTS.ledger_text, 'ledger');
  assert.equal(LANE_COMPONENTS.backend_request, 'ledger');
  assert.equal(LANE_COMPONENTS.grouper_text, 'grouper');
  assert.equal(TRACE_COMPONENTS.app.sourceTime, false);
  assert.equal(TRACE_COMPONENTS.grouper.sourceTime, true);
  assert.equal(LANE_COMPONENTS.function_call, 'backend');
  assert.equal(LANE_COMPONENTS.jev_decision, 'backend');
  assert.equal(TRACE_COMPONENTS.backend.sourceTime, false);
});

test('Jev decisions preserve probabilities and join the delegated execution flow', () => {
  const trace = new OperationTimeline(() => 0);
  const span = trace.mark('jev_decision', 'Jev choice', {
    provider: 'jev', delegation_id: 'jev-d1',
    decision: { choice: 'weather_tokyo', confidence: 0.7, threshold: 0.75, approved: false,
      probabilities: { clarify: 0.2, weather_tokyo: 0.8 } },
  }, { status: 'warning' });
  const presentation = transcriptPresentation(span);
  assert.equal(presentation.caption, 'Jev 判定 / 実行しない');
  assert.match(presentation.text, /信頼度: 0.7 \/ 閾値: 0.75/);
  assert.match(presentation.text, /weather_tokyo: 80.0%/);
  assert.equal(projectSpans(trace.spans, { flowOnly: true, delegationId: 'jev-d1' })[0].id, span.id);
  assert.equal(projectSpans(trace.spans, { component: 'backend' })[0].id, span.id);
  const reply = trace.mark('backend_reply', 'formatted', { content: '天気を取得しました。', provider: 'jev' });
  assert.match(transcriptPresentation(reply).caption, /追加推論なし/);
});

test('function flow filter joins Ledger inputs and ACKs by IDs without attributing unrelated speech', () => {
  const trace = new OperationTimeline(() => 0);
  const input = trace.mark('live_input', 'input', { event: delta('input-1', '大阪の天気') });
  const other = trace.mark('live_input', 'unrelated', { event: delta('input-2', '別の発話') });
  const local = trace.mark('live_input', 'local event', { event: { ...delta('', 'ローカル ID の発話') },
    adapted_event: { event_id: 'local-1' } });
  trace.mark('live_delegation', 'delegate', { event: { type: 'session.delegation.created', event_id: 'delegate-1', delegation: { id: 'd1', target: 'client' } } });
  trace.mark('backend_context', 'context', { delegation_id: 'd1', request_id: 'req-1', source_event_ids: ['input-1'] });
  trace.mark('delegation', 'consume_srt', { request_id: 'req-1' });
  const sent = trace.mark('backend_request', 'sent', { delegation_id: 'd1', model: 'model-deployment', model_round: 1,
    ledger_srt: 'USER: 大阪の天気', request_body: { input: [{ role: 'user', content: 'USER: 大阪の天気' }] } });
  trace.mark('command', 'append', { event: { type: 'session.commentary.append', event_id: 'cmd-1', delegation_id: 'd1', content: '取得しました。' } });
  const ack = trace.mark('live_context', 'ACK', { event: { type: 'session.commentary.appended', client_event_id: 'cmd-1' } });
  const unrelatedAck = trace.mark('live_context', 'unrelated ACK', { event: { type: 'session.thinking.appended', client_event_id: 'other-command' } });
  const speech = trace.mark('live_output', 'unattributed speech', { event: delta('output-1', '回答', 0, 1, 'output') });
  trace.mark('backend_context', 'next context', { delegation_id: 'd2', source_event_ids: ['input-1', 'input-2', 'local-1'] });
  trace.mark('handoff', 'manual consume', { delegation_id: 'manual:1', status: 'consumed_locally' });
  trace.mark('ui', 'render');
  const before = JSON.stringify(trace.export());
  const first = projectSpans(trace.spans, { flowOnly: true, delegationId: 'd1' });
  assert.ok(first.some((span) => span.id === input.id));
  assert.ok(first.some((span) => span.id === ack.id));
  assert.ok(first.some((span) => span.lane === 'delegation'));
  assert.ok(first.every((span) => ![other.id, local.id, unrelatedAck.id, speech.id].includes(span.id)));
  assert.equal(first.find((span) => span.id === sent.id).transcript.text, sent.detail.request_body.input[0].content);
  const second = projectSpans(trace.spans, { flowOnly: true, delegationId: 'd2' });
  assert.ok(second.some((span) => span.id === input.id));
  assert.ok(second.some((span) => span.id === other.id));
  assert.ok(second.some((span) => span.id === local.id));
  assert.ok(!second.some((span) => span.id === ack.id));
  assert.ok(!projectSpans(trace.spans, { flowOnly: true }).some((span) => span.lane === 'ui'));
  assert.ok(!projectSpans(trace.spans, { flowOnly: true }).some((span) => span.label === 'manual consume'));
  assert.equal(JSON.stringify(trace.export()), before);
});

test('transcript presentation preserves raw deltas including whitespace, empty text and markup literally', () => {
  const trace = new OperationTimeline(() => 0);
  for (const text of ['', ' \t\n ', '  東京😀\n東京 <img src=x onerror=alert(1)>  ']) {
    const event = delta('raw-id', text);
    const before = JSON.stringify(event);
    const span = trace.mark('live_input', event.type, { event });
    assert.deepEqual(transcriptPresentation(span), {
      kind: 'raw', caption: 'RAW 差分', role: 'USER', text,
    });
    assert.equal(JSON.stringify(event), before);
  }
  const output = trace.mark('live_output', 'session.output_transcript.delta', { event: delta('a1', 'はい', 0, 10, 'output') });
  assert.equal(transcriptPresentation(output).role, 'ASSISTANT');
  assert.equal(transcriptPresentation(trace.mark('command', 'session.commentary.append', { content: 'not a transcript' })), null);
  assert.equal(transcriptPresentation(trace.mark('live_input', 'session.input_transcript.delta', { event: { delta: null } })), null);
});

test('sent Ledger cards preview the last utterance while preserving the complete SRT', () => {
  const trace = new OperationTimeline(() => 0);
  const srt = '1\n00:00:00,000 --> 00:00:01,000\nUSER: 東京の天気\n\n1\n00:00:02,000 --> 00:00:03,000\nUSER: 大阪に変更';
  const span = trace.mark('backend_request', 'request', { ledger_srt: srt, model: 'test-model', model_round: 1 });
  const presentation = transcriptPresentation(span);
  assert.equal(presentation.text, srt);
  assert.equal(presentation.preview, '末尾の発話: USER: 大阪に変更');
  assert.equal(presentation.caption, '↑ 後段へ送信開始 / round 1');
  assert.equal(span.detail.ledger_srt, srt);
});

test('Ledger component includes actual model inputs without treating consumption as transmission', () => {
  const trace = new OperationTimeline(() => 0);
  const row = ledgerRow({ text: '東京', pending_text: '東京' });
  trace.recordLedger([row]);
  trace.recordLedger([{ ...row, delivered_characters: 2, pending_text: '' }]);
  const prepared = trace.mark('backend_context', 'prepared only', { delegation_id: 'd1', backend_context: 'USER: 東京' });
  const srt = '1\n00:00:00,000 --> 00:00:00,300\nUSER: 東京';
  const sent = trace.mark('backend_request', 'model request', {
    delegation_id: 'd1', model: 'test-model', model_round: 1, ledger_srt: srt,
    request_body: { input: [{ role: 'user', content: srt }] },
  });
  trace.mark('backend_model', 'model failed', { delegation_id: 'd1' }, { status: 'error' });
  const before = JSON.stringify(trace.export());
  const ledger = projectSpans(trace.spans, { component: 'ledger' });
  assert.equal(ledger.length, 3);
  assert.ok(!ledger.some((span) => span.id === prepared.id));
  assert.equal(ledger.filter((span) => span.lane === 'backend_request').length, 1);
  assert.equal(ledger.find((span) => span.id === sent.id).transcript.text, srt);
  assert.ok(ledger.filter((span) => span.lane === 'ledger_text').every((span) => span.transcript.kind === 'ledger'));
  assert.ok(!projectSpans(trace.spans, { component: 'backend' }).some((span) => span.id === sent.id));
  assert.ok(projectSpans(trace.spans, { component: 'ledger', flowOnly: true, delegationId: 'd1' })
    .some((span) => span.id === sent.id));
  assert.equal(JSON.stringify(trace.export()), before);
});

test('transcript presentation distinguishes Grouper full update and closed snapshots from internal states', () => {
  const trace = new OperationTimeline(() => 0);
  const segment = { id: 's1', speaker: 'user', text: 'こんにちは。', startMs: 0, endMs: 500 };
  const first = trace.mark('grouper_text', 'segment.updated', { segment: { ...segment } });
  segment.text += '今日の予定を教えて。';
  const updated = trace.mark('grouper_text', 'segment.updated', { segment: { ...segment } });
  const closed = trace.mark('grouper_text', 'segment.closed / speaker_change', { segment: { ...segment }, reason: 'speaker_change' });
  const pending = trace.begin('segment', 'current', { state: { ...segment } });
  assert.equal(transcriptPresentation(first).text, 'こんにちは。');
  assert.equal(transcriptPresentation(updated).text, segment.text);
  assert.equal(transcriptPresentation(closed).caption, 'Grouper 全文 / 閉鎖');
  assert.equal(transcriptPresentation(pending), null);
  assert.deepEqual(projectSpans(trace.spans, { textOnly: true }).map((span) => span.id), [first.id, updated.id, closed.id]);
});

const ledgerRow = (changes = {}) => ({
  identifier: 'live:u1', role: 'USER', text: '東京😀\n', start_ms: 0, end_ms: 300,
  delivered_characters: 0, projected: false, pending_text: '東京😀\n', ...changes,
});

test('Ledger snapshots preserve text and consumption history and use receipt time independently of source time', () => {
  let now = 0;
  const trace = new OperationTimeline(() => now);
  const row = ledgerRow();
  now = 500;
  trace.recordLedger([row], { request_id: 'r1', event_id: 'u1', parent_id: 'roundtrip_1' });
  const first = trace.spans[0];
  now = 600;
  trace.recordLedger([{ ...row }], { request_id: 'ack-no-change' });
  assert.equal(trace.spans.length, 1);
  row.delivered_characters = 4;
  row.pending_text = '';
  now = 700;
  trace.recordLedger([row], { request_id: 'r2' });
  now = 800;
  row.text += '、いえ、大阪';
  row.pending_text = '、いえ、大阪';
  row.end_ms = 900;
  trace.recordLedger([row], { request_id: 'r3', event_id: 'u2' });
  assert.deepEqual(trace.spans.map((span) => span.detail.change), ['created', 'consumed', 'text_updated']);
  assert.equal(first.detail.ledger_segment.text, '東京😀\n');
  assert.equal(first.detail.ledger_segment.delivered_characters, 0);
  assert.equal(first.parent_id, 'roundtrip_1');
  assert.equal(first.detail.request_id, 'r1');
  assert.equal(trace.spans[1].detail.ledger_segment.text, '東京😀\n');
  assert.deepEqual(splitLedgerText(trace.spans[2].detail.ledger_segment), { delivered: '東京😀\n', pending: '、いえ、大阪' });
  assert.deepEqual(projectSpans(trace.spans).map((span) => [span.plot_start, span.plot_end]), [[500, 500], [700, 700], [800, 800]]);
  assert.deepEqual(projectSpans(trace.spans, { axis: 'source' }).map((span) => [span.plot_start, span.plot_end]), [[0, 300], [0, 300], [0, 900]]);
  assert.equal(transcriptPresentation(trace.spans[1]).caption, 'Ledger 全文 / 消費');
  const exported = JSON.parse(JSON.stringify(trace.export()));
  assert.equal(exported.spans[0].detail.ledger_segment.pending_text, '東京😀\n');
  trace.reset();
  trace.recordLedger([row]);
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.spans[0].detail.change, 'created');
});

test('Ledger records actual server states for both roles, metadata updates and unchanged empty snapshots', () => {
  const trace = new OperationTimeline(() => 0);
  trace.recordLedger([]);
  assert.equal(trace.spans.length, 0);
  const user = ledgerRow();
  const assistant = ledgerRow({ identifier: 'live:a1', role: 'ASSISTANT', text: 'mhm', pending_text: 'mhm' });
  trace.recordLedger([user, assistant]);
  trace.recordLedger([user, assistant]);
  assert.equal(trace.spans.length, 2);
  trace.recordLedger([{ ...user, end_ms: 400 }, assistant]);
  assert.equal(trace.spans.at(-1).detail.change, 'metadata_updated');
  assert.equal(transcriptPresentation(trace.spans[1]).text, 'mhm');
  assert.equal(transcriptPresentation(trace.spans[1]).role, 'ASSISTANT');
  assert.equal(trace.spans.some((span) => span.component === 'grouper'), false);
});

test('transcript-only search spans raw, Grouper and Ledger without modifying history or source times', () => {
  const trace = new OperationTimeline(() => 0);
  const event = delta('r1', '東京');
  trace.mark('live_input', event.type, { event }, { source_start_ms: 0, source_end_ms: 100 });
  trace.mark('grouper_text', 'segment.updated', { segment: { id: 's1', speaker: 'user', text: '東京、大阪' } }, { source_start_ms: 0, source_end_ms: 200 });
  trace.recordLedger([ledgerRow({ text: '東京、大阪', pending_text: '東京、大阪' })]);
  trace.mark('ledger', 'record_event', { event_id: 'r1' });
  const before = JSON.stringify(trace.export());
  const texts = projectSpans(trace.spans, { textOnly: true, query: '東京' });
  assert.deepEqual(texts.map((span) => span.transcript.kind), ['raw', 'grouper', 'ledger']);
  assert.equal(projectSpans(trace.spans, { component: 'ledger', textOnly: true }).length, 1);
  assert.equal(projectSpans(trace.spans, { lane: 'grouper_text', textOnly: true }).length, 1);
  assert.equal(projectSpans(trace.spans, { textOnly: true, errors: true }).length, 0);
  assert.equal(projectSpans(trace.spans, { textOnly: true, query: '大阪' }).length, 2);
  const display = transcriptLaneLayout(texts, true, 220);
  assert.deepEqual(display, { rowHeight: 78, minimumPx: 220, expanded: true });
  const layout = layoutSpans(texts, 100, display.minimumPx);
  assert.deepEqual(layout.map((span) => span.track), [0, 1, 2]);
  assert.equal(visibleSpans(layout, { start: 200, end: 210, minimumMs: display.minimumPx }).length, 3);
  assert.deepEqual(transcriptLaneLayout(texts, false, 220), { rowHeight: 52, minimumPx: 160, expanded: false });
  assert.deepEqual(transcriptLaneLayout(projectSpans(trace.spans, { lane: 'ledger' }), true, 220), { rowHeight: 52, minimumPx: 160, expanded: false });
  assert.equal(JSON.stringify(trace.export()), before);
});

test('GPT-Live event classification covers lifecycle, transcripts, ACK, usage, responses and unknown types', () => {
  const cases = [
    ['session.started', 'live_session'],
    ['session.updated', 'live_session'],
    ['session.closed', 'live_session'],
    ['session.input_transcript.delta', 'live_input'],
    ['session.output_transcript.delta', 'live_output'],
    ['session.delegation.created', 'live_delegation'],
    ['session.commentary.appended', 'live_context'],
    ['session.thinking.appended', 'live_context'],
    ['session.instructions.appended', 'live_context'],
    ['session.usage.updated', 'live_usage'],
    ['session.input_audio.muted', 'live_audio'],
    ['session.output_audio.delta', 'live_audio'],
    ['error', 'live_error'],
    ['future.public.event', 'live_other'],
  ];
  for (const [type, lane] of cases) {
    const result = liveEventPresentation({ type });
    assert.equal(result.lane, lane, type);
    assert.equal(result.label, type);
    assert.equal(LANE_COMPONENTS[result.lane], 'live');
  }
  const nested = liveEventPresentation({
    type: 'response.event', delegation_id: 'd1', event: { type: 'response.failed' },
  });
  assert.equal(nested.lane, 'live_response');
  assert.equal(nested.label, 'response.event / response.failed');
  assert.equal(nested.status, 'error');
});

test('trace component filters isolate API events, Grouper, Ledger and outbound app commands without mutation', () => {
  const trace = new OperationTimeline(() => 0);
  trace.reset('replay');
  const event = delta('shared-id', 'text');
  const presentation = liveEventPresentation(event);
  trace.mark(presentation.lane, presentation.label, { event }, { source_start_ms: 0, source_end_ms: 100 });
  trace.mark('grouper', 'Grouper.push', { event_id: 'shared-id' });
  trace.mark('segment', 'segment.updated', { segment: { id: 'segment_1' } });
  trace.mark('ledger', 'record_event', { event_id: 'shared-id' });
  trace.mark('handoff', 'd1 / sent', { delegation_id: 'd1' });
  trace.mark('command', 'session.commentary.append', { delegation_id: 'd1' });
  trace.mark('input', 'normalize event_id', { event_id: 'shared-id' });
  const before = JSON.stringify(trace.export());
  assert.equal(projectSpans(trace.spans, { component: 'live' }).length, 1);
  assert.equal(projectSpans(trace.spans, { component: 'grouper' }).length, 2);
  assert.equal(projectSpans(trace.spans, { component: 'ledger' }).length, 2);
  assert.equal(projectSpans(trace.spans, { component: 'app' }).length, 2);
  assert.equal(projectSpans(trace.spans, { component: 'live', lane: 'command' }).length, 0);
  assert.equal(projectSpans(trace.spans, { component: 'grouper', query: 'shared-id' }).length, 1);
  assert.equal(projectSpans(trace.spans, { component: 'live', axis: 'source' })[0].plot_end, 100);
  assert.equal(projectSpans(trace.spans, { component: 'ledger', axis: 'source' }).length, 0);
  assert.equal(JSON.stringify(trace.export()), before);
  assert.equal(trace.export().spans[0].source, 'replay');
  assert.equal(trace.export().spans[0].component, 'live');
});

test('trace server ingestion assigns Ledger delivery states separately from HTTP and WebSocket infrastructure', () => {
  const trace = new OperationTimeline(() => 0);
  const request = trace.begin('inspector', '/ws event', { request_id: 'r1' });
  trace.server({ elapsed_ms: 1, spans: [
    { lane: 'ledger', label: 'record_event', start_ms: 0, end_ms: 1, status: 'ok' },
    { lane: 'delegation', label: 'consume_srt', start_ms: 0, end_ms: 1, status: 'ok' },
    { lane: 'command', label: 'command_status', start_ms: 0, end_ms: 1, status: 'ok' },
    { lane: 'transport', label: 'authentication', start_ms: 0, end_ms: 1, status: 'ok' },
  ] }, request);
  assert.equal(projectSpans(trace.spans, { component: 'ledger' }).length, 3);
  assert.equal(projectSpans(trace.spans, { component: 'app' }).length, 2);
  assert.equal(projectSpans(trace.spans, { component: 'live' }).length, 0);
  const handoff = trace.spans.find((span) => span.lane === 'handoff');
  assert.equal(handoff.detail.request_id, 'r1');
  assert.equal(handoff.parent_id, request.id);
});

test('trace component error filters retain response payloads and do not mix API and local failures', () => {
  const trace = new OperationTimeline(() => 0);
  const event = {
    type: 'response.event', delegation_id: 'd1',
    event: { type: 'response.failed', response: { id: 'response_1', status: 'failed' } },
  };
  const { lane, label, status } = liveEventPresentation(event);
  trace.mark(lane, label, { event }, { status });
  trace.mark('live_error', 'error', { event: { type: 'error', error: { client_event_id: 'c1' } } }, { status: 'error' });
  trace.mark('error', 'Data channel closed', {}, { status: 'error' });
  trace.mark('handoff', 'd1 / send_failed', { delegation_id: 'd1' }, { status: 'send_failed' });
  const live = projectSpans(trace.spans, { component: 'live', errors: true });
  assert.equal(live.length, 2);
  assert.equal(live[0].detail.event, event);
  assert.equal(live[0].detail.event.delegation_id, 'd1');
  assert.equal(projectSpans(trace.spans, { component: 'app', errors: true }).length, 1);
  assert.equal(projectSpans(trace.spans, { component: 'ledger', errors: true, query: 'd1' }).length, 1);
  assert.equal(projectSpans(trace.spans, { component: 'live', errors: true, query: 'response_1' }).length, 1);
});
function capture(options = {}) {
  const grouper = new TranscriptGrouper(options);
  const segments = new Map();
  const closed = [];
  grouper.on('segment.updated', (segment) => segments.set(segment.id, segment));
  grouper.on('segment.closed', (event) => closed.push(event));
  return { grouper, segments, closed };
}

test('official helper settles first fragment and emits full append-only snapshots', async () => {
  const { grouper, segments } = capture();
  try {
    grouper.push(delta('a', 'Hello'));
    assert.equal(readGrouperDiagnostics(grouper).pending.length, 1);
    await sleep(70);
    grouper.push(delta('b', ' there', 100, 200));
    assert.deepEqual([...segments.values()].map((s) => s.text), ['Hello there']);
    assert.equal(readGrouperDiagnostics(grouper).seenIds, 2);
  } finally { grouper.close(); }
});

test('duplicate IDs are ignored, equal text with distinct IDs is preserved', () => {
  const { grouper, segments } = capture();
  grouper.push(delta('a', 'same'));
  grouper.push(delta('a', 'same'));
  grouper.push(delta('b', 'same', 100, 200));
  grouper.close();
  assert.deepEqual([...segments.values()].map((s) => s.text), ['samesame']);
});

test('delegation does not consume or force-close Grouper', async () => {
  const { grouper, segments, closed } = capture();
  try {
    grouper.push(delta('a', 'context'));
    await sleep(70);
    grouper.push({ type: 'session.delegation.created', delegation: { id: 'd1' }, offset_ms: 50 });
    assert.equal(segments.size, 1);
    assert.equal(closed.length, 0);
  } finally { grouper.close(); }
});

test('source timestamp rollback closes the prior segment with timestamp_reset', () => {
  const { grouper, closed } = capture();
  grouper.push(delta('a', 'first', 5000, 5500));
  grouper.push(delta('b', 'earlier', 0, 500));
  grouper.close();
  assert.equal(closed[0].reason, 'timestamp_reset');
  assert.equal(closed[0].segment.text, 'first');
});

test('session.closed flushes pending text; manual close is idempotent; push after close fails', () => {
  const { grouper, closed } = capture();
  grouper.push(delta('a', 'pending'));
  grouper.push({ type: 'session.closed' });
  grouper.close();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'session_closed');
  assert.throws(() => grouper.push(delta('b', 'late')), /closing/);
});

test('assistant inactivity uses local elapsed time, not playback completion', async () => {
  const { grouper, closed } = capture({ assistantSilenceMs: 30 });
  try {
    grouper.push(delta('a', 'A full reply.', 0, 100, 'output'));
    await sleep(120);
    assert.ok(closed.some((event) => event.reason === 'inactivity'));
  } finally { grouper.close(); }
});

test('short overlapping acknowledgment is suppressed only when enabled', async () => {
  for (const enabled of [true, false]) {
    const { grouper, segments } = capture({ backchannelMaxDurationMs: enabled ? 1000 : 0 });
    try {
      grouper.push(delta('u1', 'I want ', 0, 700));
      await sleep(70);
      grouper.push(delta('a1', 'mhm', 350, 650, 'output'));
      await sleep(70);
      grouper.push(delta('u2', 'to travel.', 700, 1700));
      grouper.push(delta('a2', 'Where to?', 2500, 3400, 'output'));
      grouper.close();
      const text = [...segments.values()].map((s) => s.text).join('|');
      assert.equal(text.includes('mhm'), !enabled);
    } finally { grouper.close(); }
  }
});

test('adapter preserves raw objects and supplies unique reception IDs only when missing', () => {
  const adapt = createEventAdapter();
  const raw = { type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 1 };
  const first = adapt(raw);
  const second = adapt(raw);
  assert.equal(raw.event_id, undefined);
  assert.notEqual(first.event_id, second.event_id);
  assert.equal(first._lab_generated_event_id, true);
  const withId = delta('server_id', 'test');
  assert.equal(adapt(withId), withId);
  assert.equal(adapt({ type: 'session.closed' }).event_id, undefined);
  assert.throws(() => adapt(null));
});

test('Python code-point cursors split Unicode without truncating surrogate pairs', () => {
  assert.deepEqual(splitLedgerText({ text: '東京😀大阪', delivered_characters: 3 }),
    { delivered: '東京😀', pending: '大阪' });
});

test('options validate thresholds and additional acknowledgments', () => {
  assert.deepEqual(resolveOptions({ additionalAcknowledgments: 'はい, うん' }).additionalAcknowledgments, ['はい', 'うん']);
  assert.equal(resolveOptions({ backchannelMaxDurationMs: 0 }).backchannelMaxDurationMs, 0);
  for (const value of [-1, Infinity, NaN, 2_147_483_648]) {
    assert.throws(() => resolveOptions({ assistantSilenceMs: value }));
  }
});

test('ICE wait handles completion, cancellation, and a bounded timeout', async () => {
  const peer = new EventTarget();
  peer.iceGatheringState = 'complete';
  await waitForIce(peer);
  peer.iceGatheringState = 'gathering';
  const waiting = waitForIce(peer);
  peer.iceGatheringState = 'complete';
  peer.dispatchEvent(new Event('icegatheringstatechange'));
  await waiting;
  peer.iceGatheringState = 'gathering';
  const abort = new AbortController();
  const aborted = waitForIce(peer, abort.signal);
  abort.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await assert.rejects(waitForIce(peer, undefined, 10), /タイムアウト/);
});

test('all shipped replay fixtures run through the official helper without errors', async () => {
  for (const scenario of scenarios) {
    const { grouper, segments } = capture();
    try {
      for (const entry of scenario.events) {
        grouper.push(entry.event);
        await sleep(60);
      }
      assert.ok(segments.size > 0, scenario.id);
    } finally { grouper.close(); }
  }
});

test('timeline measures nested operations, asynchronous failures and reset isolation', async () => {
  let time = 100;
  const trace = new OperationTimeline(() => time);
  assert.equal(trace.measure('grouper', 'parent', () => {
    time += 5;
    return trace.measure('grouper', 'child', () => { time += 2; return 42; });
  }), 42);
  assert.equal(trace.spans[0].start_ms, 0);
  assert.equal(trace.spans[0].end_ms, 7);
  assert.equal(trace.spans[1].parent_id, trace.spans[0].id);
  await assert.rejects(trace.measureAsync('transport', 'failed HTTP', async () => {
    time += 10; throw new Error('offline');
  }), /offline/);
  assert.equal(trace.spans.at(-1).status, 'error');
  const stale = trace.begin('transport', 'old session');
  trace.reset('live');
  trace.end(stale);
  assert.deepEqual(trace.export().spans, []);
});

test('timeline retains early delegation and all history beyond the former 300 and 20000 limits', () => {
  let now = 0;
  const trace = new OperationTimeline(() => now);
  const active = trace.begin('transport', 'session');
  const delegation = trace.mark('live_delegation', 'session.delegation.created', {
    event: { delegation: { id: 'early-delegation' } },
  });
  const command = trace.mark('command', 'session.commentary.append', { delegation_id: 'early-delegation' });
  for (let i = 0; i < 25_000; i += 1) {
    now += 20;
    trace.mark('live_output', `event ${i}`);
    if (i === 500) {
      assert.ok(visibleSpans(projectSpans(trace.spans)).some((span) => span.id === delegation.id));
    }
  }
  assert.equal(trace.spans.length, 25_003);
  assert.equal(trace.spans[0], active);
  const projected = projectSpans(trace.spans);
  assert.equal(visibleSpans(projected).length, 25_003);
  assert.ok(projected.some((span) => span.id === delegation.id));
  assert.ok(projected.some((span) => span.id === command.id));
  assert.equal(projectSpans(trace.spans, { query: 'early-delegation' }).length, 2);
  const exported = JSON.parse(JSON.stringify(trace.export()));
  assert.equal(exported.spans.length, 25_003);
  assert.equal(exported.spans[1].detail.event.delegation.id, 'early-delegation');
  assert.equal(exported.dropped, 0);
  assert.equal(exported.limit, null);
  assert.equal(exported.retention, 'until-reset');
  trace.end(active);
  assert.equal(trace.spans.length, 25_003);
  trace.reset();
  assert.equal(trace.spans.length, 0);
});

test('timeline virtualizes by time and track viewport without dropping history or focused bars', () => {
  const spans = [
    { id: 'delegate', plot_start: 0, plot_end: 0, track: 0 },
    { id: 'long-running', plot_start: 0, plot_end: null, track: 1 },
    { id: 'later', plot_start: 1000, plot_end: 1200, track: 0 },
    { id: 'lower-track', plot_start: 1000, plot_end: 1300, track: 40 },
  ];
  const before = JSON.stringify(spans);
  assert.deepEqual(visibleSpans(spans, { start: 900, end: 1100, now: 1500, firstTrack: 0, lastTrack: 5 })
    .map((span) => span.id), ['long-running', 'later']);
  assert.deepEqual(visibleSpans(spans, { start: 0, end: 10, now: 1500 }).map((span) => span.id), ['delegate', 'long-running']);
  assert.deepEqual(visibleSpans(spans, { start: 900, end: 1100, firstTrack: 39, lastTrack: 45 }).map((span) => span.id), ['lower-track']);
  assert.ok(visibleSpans(spans, { start: 5, end: 10, minimumMs: 7 }).some((span) => span.id === 'delegate'));
  assert.ok(visibleSpans(spans, { start: 900, end: 1100, pinnedId: 'delegate' }).some((span) => span.id === 'delegate'));
  assert.equal(JSON.stringify(spans), before);
});

test('readable timeline labels fit range edges and reserve non-overlapping tracks without changing event times', () => {
  const spans = [
    { id: 'first', plot_start: 0, plot_end: 0 },
    { id: 'second', plot_start: 10, plot_end: 10 },
    { id: 'late', plot_start: 950, plot_end: 950 },
    { id: 'last', plot_start: 980, plot_end: 980 },
    { id: 'running', plot_start: 500, plot_end: null },
  ];
  const before = JSON.stringify(spans);
  const layout = layoutSpans(spans, 1100, 200, { range: { start: 0, end: 1000 }, gapMs: 6 });
  const late = layout.find((span) => span.id === 'late');
  const last = layout.find((span) => span.id === 'last');
  assert.equal(late.display_start, 800);
  assert.equal(late.display_end, 1000);
  assert.equal(late.plot_start, 950);
  assert.equal(late.plot_end, 950);
  assert.notEqual(late.track, last.track);
  assert.notEqual(layout[0].track, layout[1].track);
  assert.deepEqual(visibleSpans(layout, { start: 820, end: 850 }).map((span) => span.id), ['running', 'late', 'last']);
  const narrow = layoutSpans(spans.slice(2, 4), 1100, 200, { range: { start: 900, end: 1000 } });
  assert.ok(narrow.every((span) => span.display_start === 900 && span.display_end === 1000));
  assert.equal(JSON.stringify(spans), before);
});

test('full-history bounds and dense layouts handle large histories without argument or quadratic-layout limits', () => {
  const spans = Array.from({ length: 150_000 }, (_, index) => ({ plot_start: index, plot_end: index + 1 }));
  assert.deepEqual(timelineBounds(spans, 0), { start: 0, last: 150_000 });
  const dense = layoutSpans(spans.slice(0, 25_000).map((span) => ({ ...span, plot_start: 0, plot_end: 30_000 })), 30_000, 7);
  assert.equal(dense.length, 25_000);
  assert.equal(dense.at(-1).track, 24_999);
  const trackReuse = layoutSpans([
    { plot_start: 0, plot_end: 100 }, { plot_start: 1, plot_end: 10 },
    { plot_start: 10, plot_end: 90 }, { plot_start: 100, plot_end: 110 },
  ], 110);
  assert.deepEqual(trackReuse.map((span) => span.track), [0, 1, 1, 0]);
});

test('waveform updates do not invalidate cached span projections but event changes and reset do', () => {
  const trace = new OperationTimeline(() => 100);
  const version = trace.spanVersion;
  trace.waveforms.append('input', envelope(0));
  trace.version += 1;
  assert.equal(trace.spanVersion, version);
  const span = trace.begin('delegation', 'delegate');
  assert.ok(trace.spanVersion > version);
  const created = trace.spanVersion;
  trace.end(span);
  assert.ok(trace.spanVersion > created);
  const ended = trace.spanVersion;
  trace.reset();
  assert.ok(trace.spanVersion > ended);
  assert.equal(trace.waveforms.channels.input.samples.length, 0);
});

test('source and local axes stay separate and overlapping spans occupy separate tracks', () => {
  const trace = new OperationTimeline(() => 0);
  trace.mark('input', 'later source', { event_id: 'x' }, { source_start_ms: 5000, source_end_ms: 5600 });
  trace.mark('input', 'rollback', { event_id: 'y' }, { source_start_ms: 100, source_end_ms: 800 });
  trace.mark('error', 'failed', {}, { status: 'error' });
  assert.deepEqual(projectSpans(trace.spans, { axis: 'source' }).map((s) => s.plot_start), [5000, 100]);
  assert.equal(projectSpans(trace.spans, { query: 'rollback', lane: 'input' }).length, 1);
  assert.equal(projectSpans(trace.spans, { errors: true }).length, 1);
  const layout = layoutSpans(projectSpans(trace.spans), 10, 1);
  assert.deepEqual(layout.map((s) => s.track), [0, 1, 2]);
});

test('server timings retain measured durations and label cross-clock placement as estimated', () => {
  let now = 0;
  const trace = new OperationTimeline(() => now);
  const request = trace.begin('inspector', 'request', { request_id: 'r1' });
  now = 100;
  const timing = parseServerTiming('authentication;dur=5.250;desc="1.000:ok", upstream_session;dur=10.000;desc="6.500:error", total;dur=20.000');
  trace.server(timing, request);
  const [auth, upstream] = trace.spans.slice(1);
  assert.equal(auth.end_ms - auth.start_ms, 5.25);
  assert.equal(auth.start_ms, 81);
  assert.match(auth.timing, /estimated/);
  assert.equal(auth.parent_id, request.id);
  assert.equal(upstream.status, 'error');
  assert.equal(parseServerTiming(null), null);
});

test('instrumentation captures timer-only pending flush and inactivity without changing output', async () => {
  const trace = new OperationTimeline();
  const grouper = instrumentGrouper(new TranscriptGrouper({ assistantSilenceMs: 100 }), trace);
  const closed = [];
  grouper.on('segment.closed', (event) => closed.push(event));
  try {
    grouper.push(delta('trace1', 'A reply.', 0, 100, 'output'));
    assert.ok(trace.spans.some((s) => s.lane === 'pending' && s.end_ms === null));
    await sleep(200);
    assert.ok(trace.spans.some((s) => s.label === 'Grouper.flushPending'));
    assert.ok(trace.spans.some((s) => s.label === 'Grouping.advance'));
    assert.ok(trace.spans.filter((s) => s.lane === 'pending').every((s) => s.end_ms !== null));
    assert.equal(closed[0].reason, 'inactivity');
    assert.equal(closed[0].segment.text, 'A reply.');
    assert.throws(() => grouper.push(delta('invalid', 'x', -1, 2)));
    assert.equal(trace.spans.findLast((s) => s.label === 'Grouper.push').status, 'error');
  } finally { grouper.close(); }
});

test('instrumented Grouper preserves every replay result including suppression and timestamp reset', async () => {
  for (const scenario of scenarios) {
    const trace = new OperationTimeline();
    const plain = capture();
    const observed = capture();
    instrumentGrouper(observed.grouper, trace);
    try {
      for (const entry of scenario.events) {
        plain.grouper.push(entry.event);
        observed.grouper.push(entry.event);
        await sleep(65);
      }
      const summarize = (run) => run.closed.map(({ segment, reason }) => ({
        text: segment.text, speaker: segment.speaker, reason,
        start: segment.startMs, end: segment.endMs,
      }));
      assert.deepEqual(summarize(observed), summarize(plain), scenario.id);
      assert.ok(trace.spans.every((span) => span.end_ms !== null), scenario.id);
    } finally { plain.grouper.close(); observed.grouper.close(); }
  }
});

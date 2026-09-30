import { TranscriptGrouper } from './vendor/grouper.js';
import {
  DEFAULT_OPTIONS, GROUPER_TYPES, createEventAdapter, resolveOptions,
  readGrouperDiagnostics, sourceTime, splitLedgerText, waitForIce,
} from './lab-model.js';
import { scenarios } from './scenarios.js';
import { OperationTimeline, parseServerTiming, liveEventPresentation } from './trace-model.js';
import { instrumentGrouper } from './grouper-trace.js';
import { mountTimeline } from './trace-view.js';
import { LiveWaveformCapture } from './audio-waveform.js';
import { t, language, switchLanguage, translateDocument } from './i18n.js';

// Translate the Japanese static markup before anything reads or extends the DOM.
translateDocument();

const $ = (id) => document.getElementById(id);
const json = (value) => JSON.stringify(value, null, 2);
const emptyState = () => ({ ledger: [], pending_srt: '', handoffs: [], trace: [], closed: false });
let config = null;
let socket = null;
let mode = 'live';
let epoch = 0;
let sequence = 0;
let originTime = performance.now();
let rawEvents = [];
let updates = [];
let segments = new Map();
let state = emptyState();
let grouper;
let adaptEvent;
let grouperClosed = false;
let cursor = 0;
let replayTimer;
let playing = false;
let busy = false;
let inputStarted = false;
let sessionClosed = false;
let incomingCount = 0;
let live = null;
let eventQueue = Promise.resolve();
const pending = new Map();
const operations = new OperationTimeline();
operations.reset(mode);
const traceView = mountTimeline(operations);
const handoffSpans = new Map();
const executionSpans = new Map();
const ackTimers = new Map();
let configuringPlayground = false;
let replayWait = null;
let audioSpan = null;
const responsesMode = () => $('delegation-mode').value === 'responses';

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(message) {
  operations.mark('ui', 'Notification', { message }, { status: 'warning' });
  $('notice-text').textContent = message;
  $('notice').hidden = false;
}

function report(error) {
  operations.mark('error', error instanceof Error ? error.name : 'Error',
    { message: error instanceof Error ? error.message : String(error) }, { status: 'error' });
  notice(error instanceof Error ? error.message : String(error));
}

function options() {
  const values = {};
  for (const key of Object.keys(DEFAULT_OPTIONS)) values[key] = $(key).value;
  if (!$('suppress-backchannels').checked) values.backchannelMaxDurationMs = 0;
  return resolveOptions(values);
}

function updateMuteControl(muted) {
  const button = $('mute');
  const label = muted ? t('マイクを再開') : t('マイクをミュート');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-pressed', String(muted));
}

function makeGrouper() {
  grouper?.close();
  grouperClosed = false;
  adaptEvent = createEventAdapter();
  grouper = instrumentGrouper(new TranscriptGrouper(options()), operations);
  operations.mark('grouper', 'Grouper initialized', { options: options() });
  grouper.on('segment.updated', (segment) => {
    segments.set(segment.id, { ...segment, reason: null });
    recordUpdate('segment.updated', segment);
  });
  grouper.on('segment.closed', ({ segment, reason }) => {
    segments.set(segment.id, { ...segment, reason });
    recordUpdate('segment.closed', segment, reason);
  });
}

function closeGrouper() {
  if (grouper && !grouperClosed) {
    grouper.close();
    grouperClosed = true;
  }
}

function recordUpdate(type, segment, reason) {
  operations.mark('grouper_text', `${type}${reason ? ` / ${reason}` : ''}`, { segment: { ...segment }, reason }, {
    source_start_ms: segment.startMs, source_end_ms: segment.endMs,
  });
  updates.push({ type, segment, ...(reason ? { reason } : {}), arrival_ms: performance.now() - originTime });
  if (updates.length > 10_000) updates.shift();
  operations.measure('ui', 'renderGrouper', renderGrouper);
}

function jsonDetails(title, value, className = 'event-row') {
  const details = element('details', className);
  details.append(element('summary', '', title), element('pre', '', json(value)));
  return details;
}

function renderGrouper() {
  $('segment-count').textContent = String(segments.size);
  const bubbles = [...segments.values()].slice(-200).map((segment) => {
    const box = element('div', `bubble-row ${segment.speaker}`);
    const content = element('div', 'bubble-content');
    const heading = element('div', 'bubble-header');
    heading.append(element('strong', '', segment.speaker),
      element('span', `reason ${segment.reason ? '' : 'open'}`, segment.reason ?? 'updating'));
    content.append(heading, element('p', 'bubble-text', segment.text),
      element('div', 'bubble-meta', `${segment.id} · ${sourceTime(segment.startMs)} → ${sourceTime(segment.endMs)}`));
    box.append(element('span', 'speaker-avatar', segment.speaker === 'user' ? 'U' : 'AI'), content);
    return box;
  });
  $('segments').replaceChildren(...(bubbles.length ? bubbles : [element('p', 'empty-text', t('イベントを待っています。'))]));
  $('update-count').textContent = String(updates.length);
  $('group-updates').replaceChildren(...updates.slice(-100).reverse().map((item) =>
    jsonDetails(`${item.type} · ${item.segment.id} ${item.reason ?? ''}`, item)));
  renderDiagnostics();
}

function renderDiagnostics() {
  if (!grouper) return;
  const debug = readGrouperDiagnostics(grouper);
  $('buffer-badge').textContent = `pending ${debug.pending.length} / buffered ${debug.buffered ? 1 : 0}`;
  if ($('debug-details').open) $('grouper-debug').textContent = json(debug);
}

const backendLabel = (backend) => backend === 'responses' ? 'Responses delegation' : backend === 'jev' ? 'Jev' : 'Azure OpenAI';
function renderBackendConfiguration() {
  const selected = responsesMode() ? 'responses' : $('playground-backend').value;
  const settings = config?.backends?.[selected];
  $('playground-model').textContent = settings?.model ?? t('設定を確認中');
  $('playground-backend-status').textContent = !settings ? t('設定を確認中')
    : !settings.available ? t('利用できません：{0}', settings.error)
      : selected === 'jev' ? t('Jev 設定済み · 実行閾値 {0}（天気検索での精度は未検証）', settings.threshold)
        : selected === 'responses' ? t('Responses delegation · ライブ接続')
        : t('利用 API：Azure OpenAI Responses API · 設定済み');
  $('playground-backend-description').textContent = selected === 'jev'
    ? t('Ledger の累積 SRT・今回消費した SRT と事前定義の選択肢を渡します。候補と信頼度を検証し、実行可能なら天気を取得します。結果はコードで日本語に整形し、2 回目のモデル呼び出しは行いません。低信頼度の場合は実行せず、都市と現在の天気を明示した依頼を求めます。')
    : t('Azure OpenAI Responses API を通じて Ledger の SRT と関数の JSON Schema をモデルに渡します。モデルが生成した search_weather の引数を検証し、アプリが関数を実行します。実行結果をモデルに戻して回答を作ります。');
  $('playground-data-notice').textContent = selected === 'jev'
    ? t('送信先：TypeSafe。今回までに消費した Ledger の会話文脈（USER / ASSISTANT）と選択肢を送信します。音声は Jev に送りません。Jev の認証情報はサーバー側の TYPESAFE_API_KEY で設定してください。参考サンプルの設定ファイルは読み込みません。')
    : t('送信先：設定した Azure OpenAI リソースの Responses API。今回までに消費した Ledger の会話文脈と関数定義を送信します。');
  if (selected === 'responses') {
    $('playground-backend-description').textContent = t('GPT-Live の会話文脈 → Function Calling → 天気関数');
    $('playground-data-notice').textContent = t('送信先：{0} / {1}。Ledger は未使用。', config?.provider ?? '', settings?.model ?? '');
  }
}

function renderDelegationMode() {
  const responses = responsesMode();
  for (const id of ['client-playground-actions', 'client-playground-notice', 'ledger-stat',
    'transcript-view-note', 'client-handoff-note', 'client-causal-warning']) $(id).hidden = responses;
  document.querySelectorAll('button[data-view]').forEach((button) => {
    button.hidden = responses && button.dataset.view !== 'grouper';
  });
  if (responses) {
    $('compare-grid').dataset.view = 'grouper';
    $('grouper-panel').hidden = false;
    $('ledger-panel').hidden = true;
  }
  $('transcript-panels-title').textContent = responses ? t('Grouper の状態') : t('Grouper / Ledger の状態');
  $('workspace-title').textContent = $('transcript-panels-title').textContent;
  $('handoffs-summary').textContent = responses ? t('委譲・関数結果・Responses の状態') : t('委譲・SRT・コマンド送信状態');
  $('handoffs-title').textContent = $('handoffs-summary').textContent;
  traceView.setDelegationMode(responses ? 'responses' : 'client');
}

function renderState() {
  renderDelegationMode();
  renderBackendConfiguration();
  const backend = responsesMode() ? 'responses' : state.playground?.backend ?? 'azure';
  const label = backendLabel(backend);
  const available = config?.backends?.[backend]?.available;
  $('playground-badge').textContent = state.playground ? available ? t('実行 ON') : t('設定が必要') : t('実行 OFF');
  $('playground-status').textContent = state.playground
    ? available
      ? backend === 'responses' ? t('有効：Responses → 関数実行 → 結果送信 → 処理再開')
        : t('有効：Ledger → {0} → {1} → 実関数 → 結果返却', label, backend === 'jev' ? t('候補判定・信頼度検証') : 'Function Calling')
      : t('{0} の設定が未完了のため実行できません。上の設定状況を確認してください。', label)
    : t('無効：検索は実行しません。');
  $('handoff-mode').textContent = `${mode === 'live' ? 'LIVE' : t('音声なし')} / ${state.playground ? t('実関数') : t('実行 OFF')}`;
  $('source-badge').textContent = mode === 'live' ? t('LIVE · 音声接続')
    : state.playground ? t('合成発話 · {0} 推論 / Live 未送信', label) : t('REPLAY · 外部通信なし');
  const latest = state.handoffs.at(-1);
  if (mode === 'replay' && latest?.function_call && latest.status === 'not_sent') {
    $('playback-status').textContent = latest.backend?.status === 'failed'
      ? t('判断バックエンド失敗 · 詳細を確認してください / Live 未送信')
      : latest.function_call.status === 'not_called'
        ? t('モデルからの確認回答 · 関数は未実行 / Live 未送信')
        : latest.function_call.status === 'succeeded'
      ? t('関数実行完了 · Live 未送信 / 音声なし')
      : t('関数実行失敗 · 詳細を確認してください / Live 未送信');
  }
  for (const handoff of state.handoffs) {
    if (['cancelled', 'superseded'].includes(handoff.status)) {
      for (const [key, span] of executionSpans) {
        if (span.detail.delegation_id === handoff.id) {
          operations.end(span, handoff.status);
          executionSpans.delete(key);
        }
      }
    }
    const previous = handoffSpans.get(handoff.id);
    if (previous?.status === handoff.status) continue;
    operations.end(previous?.span, handoff.status);
    const detail = {
      delegation_id: handoff.id, command_id: handoff.command?.event_id,
      status: handoff.status, offset_ms: handoff.offset_ms,
      synthetic_input: mode === 'replay', srt: handoff.srt, function_call: handoff.function_call,
      transcript_event_ids: handoff.transcript_event_ids,
      command: handoff.command, backend: handoff.backend,
    };
    const span = operations.begin(handoff.backend_mode === 'responses' ? 'responses_handoff' : 'handoff', `${handoff.id} / ${handoff.status}`, detail);
    if (!['queued', 'awaiting_transcript', 'executing', 'prepared', 'sent', 'awaiting_model', 'awaiting_response', 'sending_results'].includes(handoff.status)) {
      operations.end(span, handoff.status);
    }
    if (['acknowledged', 'rejected', 'send_failed'].includes(handoff.status)) {
      clearTimeout(ackTimers.get(handoff.command?.event_id));
      ackTimers.delete(handoff.command?.event_id);
    }
    if (['cancelled', 'superseded', 'failed'].includes(handoff.status)) {
      for (const [key, running] of executionSpans) {
        if (running.detail.delegation_id === handoff.id) {
          operations.end(running, handoff.status);
          executionSpans.delete(key);
        }
      }
    }
    handoffSpans.set(handoff.id, { span, status: handoff.status });
  }
  $('pending-count').textContent = String(state.ledger.reduce((total, row) => total + Array.from(row.pending_text).length, 0));
  $('handoff-count').textContent = String(state.handoffs.length);
  $('pending-srt').textContent = state.pending_srt || t('（未消費テキストなし）');
  const rows = state.ledger.slice(-200).map((row) => {
    const tr = element('tr');
    const who = element('td');
    who.append(element('strong', '', row.role), element('small', 'row-id', row.identifier));
    const text = element('td');
    const parts = splitLedgerText(row);
    text.append(element('span', 'delivered-text', parts.delivered), element('mark', 'pending-text', parts.pending));
    tr.append(who, element('td', '', `${sourceTime(row.start_ms)} – ${sourceTime(row.end_ms)}`),
      text, element('td', '', `${row.delivered_characters} / ${Array.from(row.text).length}`));
    return tr;
  });
  $('ledger-rows').replaceChildren(...rows);
  const openIds = new Set([...$('handoffs').querySelectorAll('details[open]')].map((node) => node.dataset.id));
  $('handoffs').replaceChildren(...state.handoffs.slice(-200).map((handoff) => {
    const card = element('details', 'handoff-card');
    card.dataset.id = handoff.id;
    card.open = openIds.has(handoff.id);
    const heading = element('summary');
    heading.append(element('strong', '', handoff.id),
      element('span', '', `offset ${sourceTime(handoff.offset_ms)}`),
      handoff.function_call ? element('span', 'status-tag', handoff.function_call.model_selected
        ? `${handoff.backend_mode === 'jev' ? t('Jev 選択') : 'Function Calling'}: ${handoff.function_call.name}`
        : `${backendLabel(handoff.backend_mode)} / ${handoff.function_call.status}`) : '',
      element('span', `status-tag ${['send_failed', 'rejected'].includes(handoff.status) ? 'failure' : ''}`,
        handoff.status));
    const body = element('div', 'handoff-body');
    if (handoff.backend_mode === 'responses') {
      body.append(element('h4', '', t('Responses / 関数実行・送信状態')), element('pre', '', json({
        response_id: handoff.response_id, backend: handoff.backend,
        function_calls: handoff.function_calls, commands: handoff.commands,
      })));
      if (handoff.error) body.append(element('p', '', handoff.error));
      card.append(heading, body);
      return card;
    }
    body.append(element('h4', '', t('このハンドオフで消費した SRT')),
      element('pre', '', handoff.srt || t('（未消費テキストなし）')));
    if (handoff.backend) {
      body.append(element('h4', '', t('{0} / 判断・モデル応答と使用量', backendLabel(handoff.backend_mode))),
        element('pre', '', json(handoff.backend)));
    }
    if (handoff.function_call) {
      body.append(
        element('h4', '', t('実際の関数呼び出し・引数・取得結果')),
        element('pre', '', json(handoff.function_call)),
      );
    }
    body.append(
      element('h4', '', handoff.function_call ? t('関数呼び出し → append コマンド') : t('固定 stub コマンド（Jev・外部操作なし）')),
      element('pre', '', json(handoff.command)),
      element('p', '', t('消費カーソルはネットワーク送信の成功を示しません。')));
    if (handoff.error) body.append(element('p', '', handoff.error));
    card.append(heading, body);
    return card;
  }));
  $('backend-trace').replaceChildren(...state.trace.slice().reverse().map((trace) =>
    jsonDetails(`#${trace.seq} ${trace.action} · ${trace.event_type}`, trace)));
  updateControls();
}

function logEvent(event, direction, note = '', adapted) {
  const entry = {
    seq: ++sequence, arrival_ms: Math.round(performance.now() - originTime),
    direction, source: mode, event, note,
    ...(adapted && adapted !== event ? { adapted_event: adapted } : {}),
  };
  rawEvents.push(entry);
  const presentation = direction === 'inbound'
    ? liveEventPresentation(event)
    : { lane: 'command', label: event.type, status: 'ok' };
  operations.mark(presentation.lane, presentation.label, entry, {
    ...(Number.isFinite(event.start_ms) && Number.isFinite(event.end_ms)
      ? { source_start_ms: event.start_ms, source_end_ms: event.end_ms } : {}),
    status: direction === 'outbound' && mode === 'replay' ? 'not_sent' : presentation.status,
  });
  if (rawEvents.length > 10_000) rawEvents.shift();
  const row = element('details', `event-row ${direction}`);
  const heading = element('summary');
  heading.append(element('span', 'event-seq', String(entry.seq)),
    element('span', 'event-arrival', `${entry.arrival_ms} ms`),
    element('span', 'event-direction', direction),
    element('span', 'event-type', event.type),
    element('span', 'event-source', event.start_ms !== undefined
      ? `${sourceTime(event.start_ms)} → ${sourceTime(event.end_ms)}` : ''));
  row.append(heading);
  if (note) row.append(element('p', 'event-note', note));
  row.append(element('pre', '', json(entry)));
  if (!rawEvents.slice(0, -1).length) $('timeline').replaceChildren();
  $('timeline').prepend(row);
  while ($('timeline').children.length > 200) $('timeline').lastElementChild.remove();
  $('timeline-count').textContent = t('{0} events · 表示は最新 200 件', rawEvents.length);
  $('event-count').textContent = String(incomingCount);
}

function request(type, fields = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(t('観察サーバーが未接続です。リセットして再接続してください。')));
  const request_id = `${epoch}:${crypto.randomUUID()}`;
  const span = operations.begin('inspector', `/ws ${type} / round trip`, {
    request_id, event_id: fields.event?.event_id ?? fields.event_id, type: fields.event?.type,
    delegation_id: fields.event?.delegation?.id ?? fields.event?.delegation_id,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      operations.end(span, 'timeout');
      reject(new Error(t('観察サーバーの応答がタイムアウトしました。')));
    }, 10_000);
    pending.set(request_id, {
      span, timer,
      resolve: (value) => { operations.end(span); resolve(value); },
      reject: (error) => { operations.end(span, 'error'); reject(error); },
    });
    let sent = false;
    try {
      operations.measure('inspector', 'WebSocket.send', () =>
        socket.send(JSON.stringify({ type, ...fields, request_id })), { request_id });
      sent = true;
    } finally {
      if (!sent) {
        clearTimeout(timer);
        pending.delete(request_id);
        operations.end(span, 'error');
      }
    }
  });
}

async function connectInspector() {
  if (socket?.readyState === WebSocket.OPEN) return;
  await operations.measureAsync('inspector', 'Connect /ws', () => new Promise((resolve, reject) => {
    const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?lang=${language}`);
    socket = connection;
    let initialized = false;
    const timeout = setTimeout(() => { connection.close(); reject(new Error(t('観察サーバーに接続できません。'))); }, 10_000);
    connection.addEventListener('message', ({ data }) => {
      if (socket !== connection) return;
      try {
        const message = JSON.parse(data);
        if (message.request_id && !message.request_id.startsWith(`${epoch}:`)) return;
        const waiting = pending.get(message.request_id);
        if (waiting && (message.type === 'state' || message.type === 'error')) {
          operations.server(message.timing, waiting.span);
          clearTimeout(waiting.timer);
          pending.delete(message.request_id);
          if (message.type === 'error') waiting.reject(new Error(message.message));
          else waiting.resolve(message);
        }
        if (message.type === 'state') {
          if (message.ledger_enabled !== false) operations.recordLedger(message.ledger, {
            request_id: message.request_id,
            event_id: waiting?.span.detail.event_id,
            parent_id: waiting?.span.id,
          });
          state = message;
          operations.measure('ui', 'renderState', renderState, { request_id: message.request_id });
          if (!initialized) {
            initialized = true;
            clearTimeout(timeout);
            $('connection-status').textContent = t('観察サーバー接続済み');
            $('connection-dot').classList.add('connected');
            resolve();
          }
        }
        if (!waiting && message.type === 'error') report(message.message);
        if (message.type === 'execution') recordExecution(message);
        if (message.type === 'command' && (message.request_id?.startsWith(`${epoch}:`)
          || (message.protocol === 'responses' && state.delegation_mode === 'responses'))) {
          handleCommand(message.event, message.protocol).catch(report);
        }
      } catch (error) { report(error); }
    });
    connection.addEventListener('close', () => {
      clearTimeout(timeout);
      if (socket !== connection) return;
      operations.mark('inspector', 'WebSocket closed', {}, { status: 'error' });
      $('connection-status').textContent = t('切断 · リセットで再接続');
      $('connection-dot').classList.remove('connected');
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(t('観察サーバーとの接続が切れました。')));
      }
      pending.clear();
      stopReplay();
      if (live) {
        notice(t('観察接続が切れたため音声接続も終了しました。最終 usage は未確認です。'));
        emergencyClose();
      }
      if (!initialized) reject(new Error(t('観察サーバーに接続できません。')));
      updateControls();
    });
    connection.addEventListener('error', () => notice(t('WebSocket 接続エラー。サーバーの起動状態を確認してください。')));
  }));
}

async function handleCommand(command, protocol = 'client') {
  if (mode === 'replay') {
    logEvent(command, 'outbound', t('生成済み / Live 未送信。音声なし検証のため ACK・音声出力はありません。'));
    await request('not_sent', { event_id: command.event_id });
    return;
  }
  if (!live?.ready || live.closing || sessionClosed || live.channel?.readyState !== 'open') {
    await request('send_failed', { event_id: command.event_id, detail: 'Live session is not ready or is closing.' });
    notice(t('バックエンドの結果は未送信です。ライブ接続が準備できていません。'));
    return;
  }
  try {
    operations.measure('command', `RTCDataChannel.send / ${command.type}`, () =>
      live.channel.send(JSON.stringify(command)), { event_id: command.event_id, delegation_id: command.delegation_id });
  } catch (error) {
    await request('send_failed', { event_id: command.event_id, detail: String(error) });
    throw error;
  }
  logEvent(command, 'outbound', protocol === 'responses' ? t('送信済み / Responses の完了は別途確認') : t('実送信。受理の確認は別の ACK です。'));
  if (protocol === 'responses') {
    await request('sent', { event_id: command.event_id });
    return;
  }
  ackTimers.set(command.event_id, setTimeout(() => {
    ackTimers.delete(command.event_id);
    operations.mark('handoff', t('Append ACK 未確認'), {
      event_id: command.event_id, delegation_id: command.delegation_id,
    }, { status: 'timeout' });
    notice(t('結果は送信しましたが、対応する ACK を確認できません。音声出力と API エラーを確認してください。'));
  }, 15_000));
  await request('sent', { event_id: command.event_id });
}

function recordExecution(message) {
  const { stage, call_id, ...detail } = message;
  detail.stage = stage;
  detail.call_id = call_id;
  const modelKey = `${message.delegation_id}:model:${message.model_round}`;
  const functionKey = `${message.delegation_id}:function:${call_id}`;
  if (message.provider === 'responses' && stage.startsWith('responses_')) {
    const responseKey = `${message.delegation_id}:responses`;
    const titles = {
      responses_started: t('Responses 処理 / 文脈は GPT-Live が供給'),
      responses_round_completed: t('Responses 応答完了 / 関数要求または回答'),
      responses_command: message.command?.type === 'response.create' ? t('Responses の処理再開を送信') : t('関数結果を Responses へ送信'),
      responses_continued: t('Responses の続行要求を送信済み'),
      responses_completed: t('Responses 完了 / 回答は Live に自動注入'),
      responses_failed: t('Responses 失敗 / 完了未確認'),
    };
    if (stage === 'responses_started' || stage === 'responses_continued') {
      operations.end(executionSpans.get(responseKey));
      executionSpans.set(responseKey, operations.begin('responses_model', titles[stage], detail));
    } else {
      if (stage !== 'responses_command') {
        operations.end(executionSpans.get(responseKey), stage === 'responses_failed' ? 'error' : 'ok');
        executionSpans.delete(responseKey);
      }
      operations.mark(stage === 'responses_command' ? 'responses_command' : 'responses_result', titles[stage], detail,
        { status: stage === 'responses_failed' ? 'error' : 'ok' });
    }
    if (stage === 'responses_failed') notice(message.error);
    return;
  }
  if (stage === 'model_started') {
    operations.mark('backend_request', t('Ledger → {0} / round {1} / 送信開始', message.model, message.model_round), detail,
      { timing: 'browser / backend request notification (not an acceptance ACK)' });
    executionSpans.set(modelKey, operations.begin('backend_model',
      `${backendLabel(message.provider)} ${message.model} / ${message.provider === 'jev' ? t('候補判定') : message.model_round === 1 ? t('関数選択') : t('結果の回答作成')}`, { ...detail },
      { timing: 'browser / backend stage received' }));
  } else if (stage === 'model_completed') {
    operations.end(executionSpans.get(modelKey), 'ok', detail);
    executionSpans.delete(modelKey);
    operations.mark('backend_response', t('{0} / round {1} / 応答受信', message.model, message.model_round), detail);
  } else if (stage === 'decision_evaluated') {
    const decision = message.decision;
    operations.mark('jev_decision', t('Jev / {0} / 信頼度 {1} / {2}', decision.choice, decision.confidence.toFixed(3), decision.approved ? t('実行可') : t('実行しない')),
      detail, { status: decision.approved ? 'ok' : 'warning' });
  } else if (stage === 'function_requested') {
    operations.mark('backend_tools', `${message.provider === 'jev' ? t('Jev 選択 → 検証済み引数') : 'Function Calling'} / ${message.function_name}`, detail);
  } else if (stage === 'function_output') {
    operations.mark('function_result', t('function_call_output → Azure OpenAI のモデル'), detail);
  } else if (stage === 'result_formatted') {
    operations.mark('backend_reply', t('実結果をコードで日本語に整形（追加推論なし）'), detail);
  } else if (stage === 'backend_failed') {
    for (const [key, span] of executionSpans) {
      if (span.detail.delegation_id === message.delegation_id) {
        operations.end(span, 'error', detail);
        executionSpans.delete(key);
      }
    }
    operations.mark('backend_model', t('{0} バックエンド失敗', backendLabel(message.provider)), detail, { status: 'error' });
    notice(message.error);
  } else if (stage === 'function_started') {
    const span = operations.begin('function_call', t('{0} / 実関数', message.function_name), detail,
      { timing: 'browser / backend stage received' });
    executionSpans.set(functionKey, span);
  } else if (stage === 'function_completed' || stage === 'function_failed') {
    operations.end(executionSpans.get(functionKey), stage === 'function_failed' ? 'error' : 'ok', detail);
    executionSpans.delete(functionKey);
    operations.mark('function_result', stage === 'function_completed' ? t('関数の実行結果') : t('関数の実行失敗'),
      detail, { status: stage === 'function_failed' ? 'error' : 'ok' });
    if (stage === 'function_failed') notice(message.error);
  } else {
    operations.mark(stage === 'result_ready' ? 'backend_reply' : 'backend_context', {
      context: t('Ledger SRT の準備（未送信）'),
      awaiting_transcript: t('発話未到着 / 最大 2 秒待機'),
      result_ready: t('実行結果 → session.commentary.append'),
      superseded: t('新しい委譲を優先 / 古い結果は送信しない'),
      no_function_call: t('確認回答 / 関数呼び出しなし'),
    }[stage] ?? stage, detail);
  }
}

async function ingest(raw, note = '') {
  if (incomingCount >= (config?.max_events ?? 5000)) throw new Error(t('イベント上限に達しました。JSON を保存してリセットしてください。'));
  const event = operations.measure('input', 'normalize event_id', () => adaptEvent(raw), {
    event_id: raw.event_id, type: raw.type,
  });
  incomingCount += 1;
  logEvent(raw, 'inbound', event._lab_generated_event_id
    ? t('{0} server event_id なし → ローカル受信 ID: {1}', note, event.event_id) : note, event);
  if (GROUPER_TYPES.has(event.type)) {
    if (grouperClosed) throw new Error(t('Grouper は閉じています。リセットしてください。'));
    grouper.push(event);
    if (event.type === 'session.closed') grouperClosed = true;
  }
  if (event.type === 'session.closed') {
    sessionClosed = true;
    $('usage').textContent = json(event);
  }
  await request('event', { event });
}

function scenario() {
  return scenarios.find((item) => item.id === $('scenario').value) ?? scenarios[0];
}

function updateControls() {
  const connected = socket?.readyState === WebSocket.OPEN;
  const active = Boolean(live);
  const finished = cursor >= scenario().events.length || sessionClosed;
  const executing = state.handoffs.some((handoff) => ['queued', 'awaiting_transcript', 'executing'].includes(handoff.status));
  $('step').disabled = !connected || busy || playing || active || finished;
  $('play').disabled = $('step').disabled;
  $('stop').disabled = !playing;
  $('scenario').disabled = busy || playing || active;
  $('reset').disabled = busy || active;
  $('mode-replay').disabled = busy || playing || active || responsesMode();
  $('mode-live').disabled = busy || playing || active;
  $('delegation-mode').disabled = !connected || busy || playing || active || configuringPlayground || executing;
  $('grouper-options').disabled = inputStarted || busy || active;
  $('connect-live').disabled = !connected || busy || active || !config?.live_available;
  $('stop-live').disabled = !active || live?.closing;
  $('mute').disabled = !live?.ready || live.closing;
  $('instructions').disabled = active;
  $('language-toggle').disabled = active;
  $('consume').disabled = responsesMode() || !connected || busy || active || playing || state.closed || !state.pending_srt;
  $('playground-enabled').disabled = !connected || busy || configuringPlayground || state.closed;
  $('playground-backend').disabled = responsesMode() || !connected || busy || playing || configuringPlayground || state.closed || executing;
  $('playground-run').disabled = responsesMode() || !connected || busy || active || playing || configuringPlayground || executing || !state.playground
    || !config?.backends?.[state.playground.backend ?? 'azure']?.available;
  $('playground-utterance').disabled = busy || active;
  $('download').disabled = operations.spans.length === 0;
  $('replay-progress').max = scenario().events.length;
  $('replay-progress').value = cursor;
  $('replay-position').textContent = `${cursor} / ${scenario().events.length}`;
}

function stopReplay() {
  clearTimeout(replayTimer);
  operations.end(replayWait, 'cancelled');
  replayWait = null;
  playing = false;
  $('playback-status').textContent = sessionClosed ? t('再生完了') : t('停止中 · SDK のタイマーは進みます');
  updateControls();
}

async function reset() {
  if (live) throw new Error(t('ライブ接続を終了してからリセットしてください。'));
  stopReplay();
  busy = true;
  updateControls();
  try {
    await eventQueue;
    await connectInspector();
    epoch += 1;
    await request('reset', { playground: readPlaygroundForm(), delegation_mode: $('delegation-mode').value });
    for (const timer of ackTimers.values()) clearTimeout(timer);
    ackTimers.clear();
    executionSpans.clear();
    closeGrouper();
    segments = new Map();
    updates = [];
    rawEvents = [];
    sequence = 0;
    incomingCount = 0;
    cursor = 0;
    inputStarted = false;
    sessionClosed = false;
    originTime = performance.now();
    operations.reset(mode);
    handoffSpans.clear();
    makeGrouper();
    operations.mark('inspector', 'Inspector ready / reset complete');
    traceView.reset();
    $('timeline').replaceChildren(element('p', 'empty-text', t('イベントを待っています。')));
    $('timeline-count').textContent = '0 events';
    $('event-count').textContent = '0';
    $('usage').textContent = t('（まだセッションは閉じていません）');
    $('playback-status').textContent = t('準備完了');
    $('scenario-description').textContent = scenario().description;
    $('scenario-expect').textContent = scenario().expect;
    renderGrouper();
  } finally {
    busy = false;
    updateControls();
  }
}

function readPlaygroundForm() {
  return $('playground-enabled').checked
    ? { function_name: 'search_weather', backend: responsesMode() ? 'azure' : $('playground-backend').value } : null;
}

async function applyPlayground() {
  configuringPlayground = true;
  updateControls();
  try {
    await request('configure_playground', { playground: readPlaygroundForm() });
  } catch (error) {
    $('playground-enabled').checked = Boolean(state.playground);
    if (state.playground) $('playground-backend').value = state.playground.backend ?? 'azure';
    renderBackendConfiguration();
    throw error;
  } finally {
    configuringPlayground = false;
    updateControls();
  }
}

async function runPlayground() {
  if (responsesMode()) throw new Error(t('Responses delegation はライブ接続で実行してください。'));
  if (live) throw new Error(t('音声接続中です。マイクで依頼するか、接続を終了してから音声なしで検証してください。'));
  const utterance = $('playground-utterance').value.trim();
  if (!utterance || utterance.length > 300) throw new Error(t('検証用の発話を 1 ～ 300 文字で入力してください。'));
  await switchMode('replay');
  busy = true;
  updateControls();
  try {
    const id = crypto.randomUUID();
    inputStarted = true;
    await ingest({ type: 'session.started', event_id: `local_start_${id}`, session: { id: 'local_weather' } },
      t('合成セッション。Live API 接続ではありません。'));
    await ingest({
      type: 'session.input_transcript.delta', event_id: `local_input_${id}`,
      delta: utterance, start_ms: 0, end_ms: 1000,
    }, t('画面入力から作った合成 transcript。関数と天気 HTTP は実行します。'));
    await ingest({
      type: 'session.delegation.created', event_id: `local_delegate_${id}`, offset_ms: 1000,
      delegation: { id: `local_delegation_${id}`, type: 'delegation', target: 'client' },
    }, t('検証用の合成 delegation。実行結果を Live API へは送りません。'));
    $('playback-status').textContent = t('{0} → 判断・関数実行中 / Live 音声なし', backendLabel(state.playground?.backend));
    traceView.focusFlow();
  } finally {
    busy = false;
    updateControls();
  }
}

async function nextStep() {
  busy = true;
  updateControls();
  try {
    if (!inputStarted) { makeGrouper(); inputStarted = true; }
    const entry = scenario().events[cursor];
    if (!entry) throw new Error(t('シナリオは完了しています。リセットしてください。'));
    operations.mark('replay', `Replay step ${cursor + 1}`, {
      scheduled_arrival_ms: entry.arrival_ms, note: entry.note,
    });
    await ingest(entry.event, entry.note);
    cursor += 1;
    $('playback-status').textContent = sessionClosed ? t('再生完了') : t('ステップ完了 · SDK タイマーは進行中');
  } finally {
    busy = false;
    updateControls();
  }
}

async function playNext() {
  if (!playing) return;
  operations.end(replayWait);
  replayWait = null;
  try {
    await nextStep();
    if (cursor >= scenario().events.length) { stopReplay(); return; }
    const entries = scenario().events;
    const delay = entries[cursor].arrival_ms - entries[cursor - 1].arrival_ms;
    replayWait = operations.begin('replay', 'Replay timer wait', { scheduled_delay_ms: delay });
    replayTimer = setTimeout(playNext, delay);
  } catch (error) { stopReplay(); report(error); }
}

function cleanupLive(run) {
  if (!run || live !== run) return;
  operations.end(run.startSpan, 'cancelled');
  operations.end(run.sessionSpan, sessionClosed ? 'ok' : 'unconfirmed');
  operations.end(run.closeSpan, sessionClosed ? 'ok' : 'unconfirmed');
  operations.end(run.microphoneSpan);
  operations.end(audioSpan);
  audioSpan = null;
  for (const item of handoffSpans.values()) operations.end(item.span, 'unconfirmed');
  for (const span of executionSpans.values()) operations.end(span, 'cancelled');
  executionSpans.clear();
  for (const timer of ackTimers.values()) clearTimeout(timer);
  ackTimers.clear();
  if (socket?.readyState === WebSocket.OPEN) request('cancel_execution').catch(report);
  operations.mark('transport', 'Release microphone / data channel / peer', {
    final_usage_received: sessionClosed,
  });
  live = null;
  clearTimeout(run.startTimer);
  clearTimeout(run.closeTimer);
  run.abort.abort();
  run.waveforms?.stop().catch(report);
  $('resume-waveforms').hidden = true;
  run.microphone?.getTracks().forEach((track) => track.stop());
  run.channel?.close();
  run.peer?.close();
  $('remote-audio').srcObject = null;
  $('resume-audio').hidden = true;
  closeGrouper();
  updateMuteControl(false);
  updateControls();
}

function waveformFailure(run, error) {
  if (live !== run || run.waveformFailed) return;
  run.waveformFailed = true;
  run.waveforms?.stop().catch(report);
  $('resume-waveforms').hidden = true;
  report(new Error(t('音声波形を計測できません: {0}。音声接続は継続します。', error.message ?? String(error))));
}

async function attachWaveform(run, channel, stream) {
  if (live !== run || run.waveformFailed) return;
  if (!run.waveforms) {
    run.waveforms = new LiveWaveformCapture(operations, {
      onError: (error) => waveformFailure(run, error),
      onStateChange: (status) => {
        if (live === run) $('resume-waveforms').hidden = status === 'running' || status === 'closed';
      },
    });
    run.waveforms.resume().catch((error) => waveformFailure(run, error));
  }
  await run.waveforms.attach(channel, stream);
}

function emergencyClose() {
  const run = live;
  try {
    if (run?.ready && run.channel?.readyState === 'open') {
      const command = { type: 'session.close' };
      operations.measure('command', 'Emergency session.close', () =>
        run.channel.send(JSON.stringify(command)));
      logEvent(command, 'outbound', t('緊急終了。最終 usage は未確認です。'));
    }
  } catch (error) {
    report(error);
  } finally {
    if (run) $('live-status').textContent = t('接続終了 · 最終 usage は未確認');
    cleanupLive(run);
  }
}

async function startLive() {
  await reset();
  inputStarted = true;
  const run = { abort: new AbortController(), ready: false, closing: false };
  live = run;
  run.startSpan = operations.begin('transport', 'Live startup / waiting for session.started');
  $('live-status').textContent = t('接続準備中…');
  updateControls();
  run.startTimer = setTimeout(() => {
    operations.end(run.startSpan, 'timeout');
    notice(t('接続開始がタイムアウトしました。初期化課金が発生している可能性があります。'));
    emergencyClose();
  }, 60_000);
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('HTTPS または localhost とマイク対応ブラウザーが必要です。'));
    run.microphone = await operations.measureAsync('audio', 'getUserMedia / permission', () =>
      navigator.mediaDevices.getUserMedia({ audio: true }));
    if (live !== run) { run.microphone.getTracks().forEach((track) => track.stop()); return; }
    attachWaveform(run, 'input', run.microphone).catch((error) => waveformFailure(run, error));
    run.microphoneSpan = operations.begin('audio', 'Microphone track enabled');
    run.peer = new RTCPeerConnection();
    for (const track of run.microphone.getAudioTracks()) run.peer.addTrack(track, run.microphone);
    run.peer.addEventListener('track', ({ track }) => {
      if (live !== run) return;
      operations.mark('audio', 'Remote media track received', { kind: track.kind });
      $('remote-audio').srcObject = new MediaStream([track]);
      if (track.kind === 'audio') {
        attachWaveform(run, 'output', $('remote-audio').srcObject).catch((error) => waveformFailure(run, error));
      }
      operations.measureAsync('audio', 'HTMLMediaElement.play', () => $('remote-audio').play()).catch(() => {
        $('resume-audio').hidden = false;
        notice(t('音声の自動再生がブロックされました。「音声を再生」を押してください。'));
      });
    });
    run.peer.addEventListener('connectionstatechange', () => {
      if (live !== run) return;
      operations.mark('transport', `Peer connection: ${run.peer.connectionState}`, {},
        { status: ['failed', 'disconnected'].includes(run.peer.connectionState) ? 'error' : 'ok' });
      if (['failed', 'disconnected'].includes(run.peer.connectionState)) {
        notice(t('音声接続が切れました。最終 usage は未確認です。'));
        emergencyClose();
      }
    });
    run.channel = run.peer.createDataChannel('oai-events');
    run.channel.addEventListener('open', () => {
      if (live === run) operations.mark('transport', 'RTCDataChannel open');
    });
    run.channel.addEventListener('message', ({ data }) => {
      if (live !== run) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'session.started') {
          operations.end(run.startSpan);
          run.sessionSpan = operations.begin('transport', 'Live session active', { session_id: event.session?.id });
          clearTimeout(run.startTimer);
          run.ready = true;
          $('live-status').textContent = t('接続済み · {0}', event.session?.id ?? '');
          updateControls();
        }
        // Feed the SDK immediately: a local server round trip must not alter its 50 ms settle window.
        const processing = ingest(event);
        eventQueue = Promise.all([eventQueue, processing]).then(() => {
          if (event.type === 'error') {
            notice(`Live API error: ${event.error?.message ?? json(event)}`);
            if (!run.ready) emergencyClose();
          }
          if (event.type === 'session.closed') {
            $('live-status').textContent = t('接続終了 · 最終 usage を受信');
            cleanupLive(run);
          }
        }).catch((error) => { report(error); emergencyClose(); });
      } catch (error) { report(error); emergencyClose(); }
    });
    run.channel.addEventListener('close', () => {
      if (live !== run) return;
      operations.mark('transport', 'RTCDataChannel closed');
      // Let already-received session.closed finish its local Ledger round trip.
      eventQueue.then(() => {
        if (live === run) {
          notice(t('イベント接続が切れました。最終 usage は未確認です。'));
          cleanupLive(run);
        }
      });
    });
    run.channel.addEventListener('error', () => {
      if (live === run) {
        operations.mark('transport', 'RTCDataChannel error', {}, { status: 'error' });
        notice(t('音声イベントチャネルでエラーが発生しました。')); emergencyClose();
      }
    });
    await operations.measureAsync('transport', 'SDP createOffer / setLocalDescription', async () =>
      run.peer.setLocalDescription(await run.peer.createOffer()));
    await operations.measureAsync('transport', 'ICE gathering', () => waitForIce(run.peer, run.abort.signal));
    const sdp = run.peer.localDescription?.sdp;
    if (!sdp) throw new Error(t('SDP offer を作成できませんでした。'));
    $('live-status').textContent = t('認証・セッション作成中…');
    const result = await operations.measureAsync('transport', 'POST /api/session', async (span) => {
      const response = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp, instructions: $('instructions').value, delegation_mode: $('delegation-mode').value, language,
        }),
        signal: run.abort.signal,
      });
      operations.server(parseServerTiming(response.headers.get('Server-Timing')), span);
      operations.mark('transport', `HTTP ${response.status} / session`, {
        server_timing: response.headers.get('Server-Timing'),
        meaning: 'Server durations and relative offsets; placement inside HTTP RTT is estimated. No credentials or SDP recorded.',
      }, { status: response.ok ? 'ok' : 'error' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
      return body;
    });
    if (live !== run) return;
    await operations.measureAsync('transport', 'SDP setRemoteDescription', () =>
      run.peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp }));
    if (!run.ready) $('live-status').textContent = t('session.started 待機中 · {0}', result.session.id);
  } catch (error) {
    if (live === run) {
      operations.end(run.startSpan, 'error');
      $('live-status').textContent = t('接続に失敗しました');
      report(error);
      cleanupLive(run);
    }
  }
}

function stopLive() {
  const run = live;
  if (!run) return;
  if (!run.ready || run.channel?.readyState !== 'open') {
    notice(t('接続準備を中止しました。セッション作成済みの場合は初期化課金が発生する可能性があります。'));
    cleanupLive(run);
    $('live-status').textContent = t('接続準備を中止');
    return;
  }
  run.closing = true;
  run.closeSpan = operations.begin('transport', 'Wait for session.closed');
  const command = { type: 'session.close', event_id: `close_${crypto.randomUUID()}` };
  try {
    operations.measure('command', 'RTCDataChannel.send / session.close', () =>
      run.channel.send(JSON.stringify(command)), { event_id: command.event_id });
  } catch (error) {
    cleanupLive(run);
    throw error;
  }
  logEvent(command, 'outbound');
  $('live-status').textContent = t('session.closed を待機中…');
  run.closeTimer = setTimeout(() => {
    operations.end(run.closeSpan, 'timeout');
    notice(t('終了応答が 15 秒以内に届きませんでした。最終 usage は未確認です。'));
    $('live-status').textContent = t('応答なしで接続終了 · 最終 usage は未確認');
    cleanupLive(run);
  }, 15_000);
  updateControls();
}

async function switchMode(next) {
  if (next === 'replay' && responsesMode()) throw new Error(t('Responses delegation はライブ接続で実行してください。'));
  mode = next;
  $('replay-controls').hidden = next !== 'replay';
  $('live-controls').hidden = next !== 'live';
  $('replay-settings').hidden = next !== 'replay';
  $('live-settings').hidden = next !== 'live';
  $('scenario-expect').hidden = next !== 'replay';
  for (const name of ['replay', 'live']) {
    $(`mode-${name}`).classList.toggle('active', name === next);
    $(`mode-${name}`).setAttribute('aria-pressed', String(name === next));
  }
  $('source-badge').textContent = next === 'replay' ? t('SIMULATION · API 通信なし') : t('LIVE · 音声接続');
  $('handoff-mode').textContent = next === 'replay' ? 'SIMULATED' : 'LIVE / STUB';
  await reset();
}

function bind(id, callback) {
  $(id).addEventListener('click', () => Promise.resolve().then(callback).catch(report));
}

for (const item of scenarios) {
  const option = element('option', '', item.title);
  option.value = item.id;
  $('scenario').append(option);
}
bind('step', nextStep);
bind('play', () => { playing = true; updateControls(); return playNext(); });
bind('stop', stopReplay);
bind('reset', reset);
bind('mode-replay', () => switchMode('replay'));
bind('mode-live', () => switchMode('live'));
bind('consume', () => request('consume'));
bind('playground-run', runPlayground);
bind('playground-timeline', () => traceView.focusFlow());
$('delegation-mode').addEventListener('change', async () => {
  try {
    if (live) throw new Error(t('接続を終了してから委譲モードを変更してください。'));
    if (responsesMode()) $('playground-backend').value = 'azure';
    await switchMode('live');
    document.querySelector(`button[data-view="${responsesMode() ? 'grouper' : 'compare'}"]`).click();
    traceView.focusFlow({ scroll: false });
  } catch (error) {
    $('delegation-mode').value = state.delegation_mode ?? 'client';
    renderState();
    report(error);
  }
});
$('playground-enabled').addEventListener('change', () => applyPlayground().catch(report));
$('playground-backend').addEventListener('change', () => {
  renderBackendConfiguration();
  applyPlayground().catch(report);
});
bind('connect-live', startLive);
bind('stop-live', stopLive);
bind('open-settings', () => {
  $('session-settings').open = true;
  $('session-settings').scrollIntoView({ block: 'start' });
  $('session-settings').focus({ preventScroll: true });
});
bind('dismiss-notice', () => { $('notice').hidden = true; });
// The toggle names the other language in that language so it can be found from either UI.
const otherLanguage = language === 'en' ? 'ja' : 'en';
$('language-toggle').textContent = otherLanguage === 'ja' ? '日本語' : 'English';
$('language-toggle').lang = otherLanguage;
$('language-toggle').setAttribute('aria-label', otherLanguage === 'ja' ? '日本語に切り替え' : 'Switch to English');
$('language-toggle').title = $('language-toggle').getAttribute('aria-label');
bind('language-toggle', () => {
  if (live) throw new Error(t('接続を終了してから言語を切り替えてください。'));
  if (rawEvents.length && !window.confirm(t('言語を切り替えるとページを再読み込みします。保存していない記録は失われます。切り替えますか？'))) return;
  switchLanguage(otherLanguage);
});
bind('mute', () => {
  const tracks = live.microphone.getAudioTracks();
  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = enabled; });
  operations.end(live.microphoneSpan);
  live.microphoneSpan = operations.begin('audio', enabled ? 'Microphone track enabled' : 'Microphone muted');
  updateMuteControl(!enabled);
});
bind('resume-audio', async () => {
  await operations.measureAsync('audio', 'Resume HTMLMediaElement.play', () => $('remote-audio').play());
  $('resume-audio').hidden = true;
});
bind('resume-waveforms', () => {
  const run = live;
  return run?.waveforms?.resume().catch((error) => waveformFailure(run, error));
});
bind('download', () => {
  const blob = new Blob([json({ format: 'transcript-lab-v1', source: mode, delegation_mode: state.delegation_mode, options: options(),
    raw_events: rawEvents, grouper_updates: updates, ledger: state,
    operation_timeline: operations.export() })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `transcript-lab-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('scenario').addEventListener('change', () => reset().catch(report));
$('debug-details').addEventListener('toggle', renderDiagnostics);
for (const type of ['playing', 'pause', 'waiting', 'ended', 'error']) {
  $('remote-audio').addEventListener(type, () => {
    if (!live) return;
    operations.end(audioSpan);
    audioSpan = null;
    if (type === 'playing') audioSpan = operations.begin('audio', 'HTML audio playing (not speech detection)');
    else operations.mark('audio', `HTML audio ${type}`, {}, { status: type === 'error' ? 'error' : 'ok' });
  });
}
document.querySelectorAll('[data-view]').forEach((button) => {
  if (button.tagName !== 'BUTTON') return;
  button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (responsesMode() && view !== 'grouper') return;
    $('compare-grid').dataset.view = view;
    $('grouper-panel').hidden = view === 'ledger';
    $('ledger-panel').hidden = view === 'grouper';
    document.querySelectorAll('button[data-view]').forEach((other) => {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
  });
});
window.addEventListener('pagehide', () => {
  stopReplay();
  emergencyClose();
  socket?.close();
});
setInterval(renderDiagnostics, 100);

async function initialize() {
  const response = await fetch(`/api/config?lang=${language}`);
  if (!response.ok) throw new Error(t('設定取得に失敗: HTTP {0}', response.status));
  config = await response.json();
  if (config.playground_protocol !== 5) {
    throw new Error(t('サーバーが旧版です。Python サーバーを再起動してページを再読み込みしてください。旧版では実関数を実行できません。'));
  }
  $('playground-fields').disabled = false;
  $('playground-cities').textContent = (config.weather_cities ?? []).join(t('・'));
  renderBackendConfiguration();
  $('instructions').value = config.instructions;
  $('key-status').textContent = config.config_error
    ?? `${config.provider ?? 'openai'} · ${config.model} · ${config.auth_mode === 'entra' ? 'Azure CLI / Entra' : config.api_key_configured ? t('API key 設定済み') : t('API key 未設定')}`;
  if (config.config_error) notice(config.config_error);
  await switchMode(mode);
}
initialize().catch(report);

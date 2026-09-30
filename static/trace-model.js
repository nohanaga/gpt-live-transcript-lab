import { WaveformHistory } from './audio-waveform.js';
import { t } from './i18n.js';

export const LANES = Object.freeze({
  live_session: 'Session lifecycle',
  live_input: 'Input transcript',
  live_output: 'Output transcript',
  live_delegation: 'Delegation events',
  live_response: 'Responses backend events',
  live_context: 'Context append ACK',
  live_usage: 'Usage snapshots',
  live_audio: 'Audio control events',
  live_error: 'API errors',
  live_other: 'Other API events',
  transport: 'Connection / WebRTC',
  audio: 'Microphone / playback',
  replay: 'Replay scheduler',
  input: 'Event adapter',
  grouper: 'Grouper operations',
  grouper_text: 'Grouper transcript / full snapshots',
  pending: 'Grouper pending / settle',
  buffered: 'Grouper buffered',
  segment: 'Grouper segments',
  inspector: 'Inspector WebSocket',
  ledger: 'Python Ledger',
  ledger_text: 'Ledger transcript / full snapshots',
  delegation: 'Delegation / consume',
  backend_context: t('Ledger → バックエンド'),
  backend_request: t('後段へ送信した Ledger / HTTP 入力'),
  backend_model: t('判断モデルの推論'),
  backend_response: t('モデル応答 / 関数要求・回答'),
  backend_tools: t('実行する関数 / 検証済み引数'),
  jev_decision: t('Jev の選択・確率・信頼度'),
  function_call: t('実関数の実行'),
  function_result: t('実行結果 / 失敗'),
  backend_reply: t('LIVE への返送内容（送信前）'),
  responses_model: t('Responses / 応答待機'),
  responses_command: t('関数結果送信 / 明示的続行'),
  responses_result: t('Responses / 完了・失敗'),
  responses_handoff: t('Responses / 委譲状態'),
  handoff: 'Handoff / delivery state',
  command: 'Outgoing commands',
  ui: 'UI render',
  error: 'Errors',
});

export const TRACE_COMPONENTS = Object.freeze({
  live: {
    label: 'GPT-Live',
    lanes: ['live_session', 'live_input', 'live_output', 'live_delegation', 'live_response',
      'live_context', 'live_usage', 'live_audio', 'live_error', 'live_other'],
    sourceTime: true,
  },
  grouper: {
    label: 'TranscriptGrouper',
    lanes: ['grouper_text', 'grouper', 'pending', 'buffered', 'segment'],
    sourceTime: true,
  },
  ledger: {
    label: 'TranscriptLedger',
    lanes: ['ledger_text', 'backend_request', 'ledger', 'delegation', 'handoff'],
    sourceTime: true,
  },
  backend: {
    label: t('判断モデル / 実関数'),
    lanes: ['backend_context', 'backend_model', 'backend_response',
      'responses_model', 'responses_command', 'responses_result', 'responses_handoff',
      'jev_decision', 'backend_tools', 'function_call', 'function_result', 'backend_reply'],
    sourceTime: false,
  },
  app: {
    label: 'App / transport',
    lanes: ['transport', 'audio', 'replay', 'input', 'inspector', 'command', 'ui', 'error'],
    sourceTime: false,
  },
});

export const LANE_COMPONENTS = Object.freeze(Object.fromEntries(
  Object.entries(TRACE_COMPONENTS).flatMap(([component, config]) =>
    config.lanes.map((lane) => [lane, component])),
));

export const FUNCTION_FLOW_GROUPS = [
  { label: t('1 · Ledger の元発話'), key: 'live', lanes: ['live_input'] },
  { label: t('2 · Client delegation / Ledger 消費'), key: 'ledger', lanes: ['live_delegation', 'delegation'] },
  { label: t('3 · Ledger 準備 / モデルへの送信'), key: 'ledger', lanes: ['backend_context', 'backend_request'] },
  { label: t('4 · モデル実行 / 応答 / 判断・引数検証'), key: 'backend', lanes: ['backend_model', 'backend_response', 'jev_decision', 'backend_tools'] },
  { label: t('5 · 実関数 / 取得結果'), key: 'backend', lanes: ['function_call', 'function_result'] },
  { label: t('6 · LIVE 返送 / 受理・失敗'), key: 'app', lanes: ['backend_reply', 'command', 'handoff', 'live_context', 'live_error', 'error'] },
  { label: t('参照 · ID で関連付いた音声イベント'), key: 'live', lanes: ['live_output', 'live_audio', 'audio'] },
];
export const RESPONSES_FLOW_GROUPS = [
  { label: t('1 · 音声会話 / RAW transcript'), key: 'live', lanes: ['live_input', 'live_output'] },
  { label: '2 · Responses delegation', key: 'live', lanes: ['live_delegation', 'responses_handoff'] },
  { label: t('3 · Responses イベント / 関数要求'), key: 'backend', lanes: ['live_response', 'responses_model', 'backend_tools'] },
  { label: t('4 · アプリの関数実行 / 取得結果'), key: 'backend', lanes: ['function_call', 'function_result'] },
  { label: t('5 · 関数結果送信 / 処理再開'), key: 'app', lanes: ['responses_command', 'command'] },
  { label: t('6 · Responses 完了 / Live 自動注入'), key: 'backend', lanes: ['responses_result', 'live_error', 'error'] },
];
const FLOW_LANES = new Set([...FUNCTION_FLOW_GROUPS, ...RESPONSES_FLOW_GROUPS].flatMap((group) => group.lanes));
const CLIENT_ONLY_LANES = new Set(['ledger', 'ledger_text', 'delegation', 'backend_context',
  'backend_request', 'backend_model', 'backend_response', 'jev_decision', 'backend_reply', 'handoff']);
const RESPONSES_ONLY_LANES = new Set(['responses_model', 'responses_command', 'responses_result', 'responses_handoff']);
export const delegationLaneVisible = (lane, mode) => mode === 'responses'
  ? !CLIENT_ONLY_LANES.has(lane) : !RESPONSES_ONLY_LANES.has(lane);
const isFlowCandidate = (span) => FLOW_LANES.has(span.lane)
  && !(span.lane === 'handoff' && span.detail.status === 'consumed_locally');

export function functionFlowIndex(spans) {
  const bySpan = new Map();
  const byEvent = new Map();
  const byCommand = new Map();
  const byRequest = new Map();
  const ids = new Set();
  const add = (map, key, id) => {
    if (typeof key !== 'string' || !key || typeof id !== 'string' || !id) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  for (const span of spans) {
    if (!isFlowCandidate(span)) continue;
    const { detail } = span;
    const event = detail.event;
    const id = detail.delegation_id ?? event?.delegation_id ?? event?.delegation?.id ?? detail.command?.delegation_id;
    if (typeof id !== 'string' || !id) continue;
    ids.add(id);
    add(bySpan, span.id, id);
    add(byRequest, detail.request_id, id);
    if (span.lane === 'live_delegation') add(byEvent, event?.event_id, id);
    for (const eventId of detail.source_event_ids ?? detail.transcript_event_ids ?? []) add(byEvent, eventId, id);
    add(byCommand, detail.command?.event_id ?? detail.command_id, id);
    if (span.lane === 'command') add(byCommand, event?.event_id ?? detail.event_id, id);
  }
  for (const span of spans) {
    if (!isFlowCandidate(span)) continue;
    const { detail } = span;
    const event = detail.event;
    const eventId = detail.adapted_event?.event_id ?? event?.event_id ?? detail.event_id;
    const clientId = event?.client_event_id ?? event?.error?.client_event_id ?? event?.error?.event_id;
    for (const related of [
      byEvent.get(eventId), byCommand.get(clientId),
      span.lane === 'command' || span.lane === 'handoff' ? byCommand.get(eventId) : null,
      byRequest.get(detail.request_id),
    ]) {
      for (const id of related ?? []) add(bySpan, span.id, id);
    }
  }
  return { bySpan, ids: [...ids] };
}

export function liveEventPresentation(event) {
  let lane = 'live_other';
  const kind = event.type;
  if (['session.started', 'session.updated', 'session.closed'].includes(kind)) lane = 'live_session';
  else if (kind === 'session.input_transcript.delta') lane = 'live_input';
  else if (kind === 'session.output_transcript.delta') lane = 'live_output';
  else if (kind.startsWith('session.delegation.')) lane = 'live_delegation';
  else if (kind === 'response.event') lane = 'live_response';
  else if (['session.instructions.appended', 'session.thinking.appended', 'session.commentary.appended'].includes(kind)) lane = 'live_context';
  else if (kind === 'session.usage.updated') lane = 'live_usage';
  else if (kind.startsWith('session.input_audio.') || kind.startsWith('session.output_audio.')) lane = 'live_audio';
  else if (kind === 'error') lane = 'live_error';
  const nested = kind === 'response.event' && typeof event.event?.type === 'string' ? event.event.type : null;
  return {
    lane,
    label: nested ? `${kind} / ${nested}` : kind,
    status: kind === 'error' || ['error', 'response.failed'].includes(nested) ? 'error' : 'ok',
  };
}

function ledgerPresentation(kind, caption, srt) {
  const cues = srt.split(/\r?\n\r?\n(?=(?:\d+\r?\n)?\d{2,}:\d{2}:\d{2},\d{3} --> )/);
  const latest = cues.at(-1).replace(/^(?:\d+\r?\n)?\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}\r?\n/, '');
  return { kind, caption, text: srt, role: 'BACKEND', preview: t('末尾の発話: {0}', latest) };
}

export function transcriptPresentation(span) {
  const { event, segment, ledger_segment: ledger, change } = span.detail;
  if (['live_input', 'live_output'].includes(span.lane) && typeof event?.delta === 'string') {
    return {
      kind: 'raw', role: span.lane === 'live_input' ? 'USER' : 'ASSISTANT',
      caption: t('RAW 差分'), text: event.delta,
    };
  }
  if (['grouper_text', 'segment'].includes(span.lane) && typeof segment?.text === 'string') {
    return {
      kind: 'grouper', role: segment.speaker.toUpperCase(), text: segment.text,
      caption: t('Grouper 全文 / {0}', span.label.startsWith('segment.closed') ? t('閉鎖') : t('更新')),
    };
  }
  if (span.lane === 'ledger_text' && typeof ledger?.text === 'string') {
    return {
      kind: 'ledger', role: ledger.role, text: ledger.text,
      caption: t('Ledger 全文 / {0}', {
        created: t('追加'), text_updated: t('更新'), consumed: t('消費'), metadata_updated: t('状態更新'),
      }[change]),
    };
  }
  const detail = span.detail;
  const text = (kind, caption, value, role = 'BACKEND') => ({ kind, caption, text: value, role });
  if (span.lane === 'live_response') {
    const nested = event?.event;
    if (nested?.type === 'response.output_text.delta') return text('model_response', t('Responses 回答差分'), nested.delta);
    if (nested?.item?.type === 'function_call') return text('function_arguments', t('Responses の関数要求'), JSON.stringify(nested.item, null, 2));
  }
  if (span.lane === 'responses_command') {
    return text('function_result', detail.command?.type === 'response.create' ? t('Responses 続行要求') : t('Responses へ返す関数結果'),
      JSON.stringify(detail.command, null, 2), 'APP');
  }
  if (span.lane === 'responses_result' && detail.response) {
    return text('model_response', t('Responses 完了イベント'), JSON.stringify(detail.response, null, 2));
  }
  if (span.lane === 'backend_context' && typeof detail.backend_context === 'string') {
    return ledgerPresentation('ledger_context', t('Ledger 準備 / 累積 SRT（未送信）'), detail.backend_context);
  }
  if (span.lane === 'backend_request') {
    if (typeof detail.ledger_srt === 'string') {
      return ledgerPresentation('ledger_input', t('↑ 後段へ送信開始 / round {0}', detail.model_round), detail.ledger_srt);
    }
    const input = detail.request_body?.input ?? detail.input_items;
    if (Array.isArray(input)) {
      return text('model_input', t('↑ 後段へ送信開始 / SRT を含む入力'), JSON.stringify(input, null, 2));
    }
  }
  if (span.lane === 'backend_response') {
    if (detail.function_calls?.length) {
      return text('model_response', t('モデル応答 / function_call / round {0}', detail.model_round), JSON.stringify(detail.function_calls, null, 2));
    }
    if (typeof detail.output_text === 'string') {
      return text('model_response', t('モデルの回答 / round {0}', detail.model_round), detail.output_text);
    }
  }
  if (span.lane === 'backend_tools' && detail.arguments) {
    return text('function_arguments', t('検証済み引数 / {0}', detail.function_name), JSON.stringify(detail.arguments, null, 2));
  }
  if (span.lane === 'jev_decision' && detail.decision) {
    const { choice, confidence, threshold, approved, probabilities } = detail.decision;
    return text('jev_decision', t('Jev 判定 / {0}', approved ? t('実行可') : t('実行しない')),
      t('選択: {0}\n信頼度: {1} / 閾値: {2}\n', choice, confidence, threshold)
      + Object.entries(probabilities).sort((a, b) => b[1] - a[1])
        .map(([option, probability]) => `${option}: ${(probability * 100).toFixed(1)}%`).join('\n'));
  }
  if (span.lane === 'function_result') {
    const result = detail.tool_output ?? detail.result ?? detail.error;
    if (result !== undefined) return text('function_result', detail.tool_output ? t('関数結果 → モデル') : t('実関数の結果'),
      typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }
  if (span.lane === 'backend_reply' && typeof detail.command?.content === 'string') {
    return text('live_reply', t('LIVE への返送内容（送信前）'), detail.command.content);
  }
  if (span.lane === 'backend_reply' && typeof detail.content === 'string') {
    return text('live_reply', t('コードによる結果整形 / 追加推論なし'), detail.content);
  }
  if (span.lane === 'command' && event?.type === 'session.commentary.append' && typeof event.content === 'string') {
    return text('live_reply', span.status === 'not_sent' ? t('LIVE 未送信') : t('LIVE へ送信 / ACK は別途確認'), event.content, 'APP');
  }
  return null;
}

export function transcriptLaneLayout(spans, showText, textWidth, operationWidth = 160) {
  const expanded = showText && spans.some((span) => span.transcript);
  return { rowHeight: expanded ? 78 : 52, minimumPx: expanded ? Math.max(textWidth, operationWidth) : operationWidth, expanded };
}

export class OperationTimeline {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.sequence = 0;
    this.generation = 0;
    this.reset();
  }

  reset(source = 'replay') {
    this.origin = this.clock();
    this.source = source;
    this.generation += 1;
    this.spans = [];
    this.waveforms = new WaveformHistory();
    this.ledgerSnapshots = new Map();
    this.parent = null;
    this.version = (this.version ?? 0) + 1;
    this.spanVersion = (this.spanVersion ?? 0) + 1;
  }

  now() { return this.clock() - this.origin; }

  begin(lane, label, detail = {}, extra = {}) {
    const span = {
      id: `span_${++this.sequence}`, generation: this.generation,
      lane, label, detail, component: LANE_COMPONENTS[lane] ?? 'app',
      source: this.source, parent_id: this.parent?.id ?? null,
      start_ms: this.now(), end_ms: null, status: 'running', timing: 'browser', ...extra,
    };
    this.spans.push(span);
    this.version += 1;
    this.spanVersion += 1;
    return span;
  }

  end(span, status = 'ok', detail = {}) {
    if (!span || span.generation !== this.generation || span.end_ms !== null) return;
    span.end_ms = this.now();
    span.status = status;
    Object.assign(span.detail, detail);
    this.version += 1;
    this.spanVersion += 1;
  }

  mark(lane, label, detail = {}, extra = {}) {
    const span = this.begin(lane, label, detail, extra);
    this.end(span, extra.status ?? 'ok');
    span.end_ms = span.start_ms;
    return span;
  }

  measure(lane, label, operation, detail = {}) {
    const span = this.begin(lane, label, detail);
    const parent = this.parent;
    this.parent = span;
    let status = 'error';
    try {
      const result = operation();
      status = 'ok';
      return result;
    } finally {
      this.parent = parent;
      this.end(span, status);
    }
  }

  async measureAsync(lane, label, operation, detail = {}) {
    const span = this.begin(lane, label, detail);
    let status = 'error';
    try {
      const result = await operation(span);
      status = 'ok';
      return result;
    } finally { this.end(span, status); }
  }

  recordLedger(rows, correlation = {}) {
    for (const row of rows) {
      const previous = this.ledgerSnapshots.get(row.identifier);
      if (previous && JSON.stringify(previous) === JSON.stringify(row)) continue;
      const snapshot = { ...row };
      const change = !previous ? 'created'
        : previous.text !== row.text ? 'text_updated'
          : previous.delivered_characters !== row.delivered_characters ? 'consumed' : 'metadata_updated';
      this.ledgerSnapshots.set(row.identifier, snapshot);
      this.mark('ledger_text', `Ledger snapshot / ${change}`, {
        ...correlation, ledger_segment: snapshot, change,
      }, {
        parent_id: correlation.parent_id ?? null,
        source_start_ms: row.start_ms, source_end_ms: row.end_ms,
        timing: 'browser / Ledger snapshot received (not server execution)',
      });
    }
  }

  server(timing, requestSpan) {
    if (!timing || requestSpan.generation !== this.generation) return;
    // Server durations are measured; their placement inside the RTT is only estimated.
    const anchor = Math.max(requestSpan.start_ms, this.now() - timing.elapsed_ms);
    for (const item of timing.spans) {
      const span = this.begin(item.lane === 'command' ? 'handoff' : item.lane, item.label, {
        request_id: requestSpan.detail.request_id, event_id: requestSpan.detail.event_id,
        delegation_id: requestSpan.detail.delegation_id,
        server_start_ms: item.start_ms, server_end_ms: item.end_ms, action: item.detail,
      }, {
        parent_id: requestSpan.id, start_ms: anchor + item.start_ms,
        timing: 'server-relative (placement estimated)',
      });
      span.end_ms = anchor + item.end_ms;
      span.status = item.status;
    }
    this.version += 1;
    this.spanVersion += 1;
  }

  export() {
    return {
      clock: 'performance.now() relative to reset', exported_at_ms: this.now(),
      dropped: 0, limit: null, retention: 'until-reset', spans: this.spans,
      audio_waveforms: this.waveforms.export(),
    };
  }
}

export function parseServerTiming(header) {
  if (!header) return null;
  const total = header.match(/(?:^|,\s*)total;dur=([\d.]+)/);
  if (!total) return null;
  return {
    elapsed_ms: Number(total[1]),
    spans: [...header.matchAll(/(\w+);dur=([\d.]+);desc="([\d.]+):(ok|error)"/g)].map((match) => ({
      lane: 'transport', label: match[1], start_ms: Number(match[3]),
      end_ms: Number(match[3]) + Number(match[2]), status: match[4],
    })),
  };
}

export function projectSpans(spans, {
  axis = 'local', component = 'all', lane = '', query = '', errors = false, textOnly = false, flowOnly = false,
  delegationId = '', flowIndex = flowOnly ? functionFlowIndex(spans) : null,
  delegationMode = 'client',
} = {}) {
  const search = query.trim().toLowerCase();
  return spans.filter((span) => (component === 'all'
    || (component === 'default' && span.component !== 'grouper')
    || span.component === component)
    && delegationLaneVisible(span.lane, delegationMode)
    && (!lane || span.lane === lane)
    && (!textOnly || transcriptPresentation(span) !== null)
    && (!flowOnly || (isFlowCandidate(span)
      && (flowIndex.bySpan.has(span.id) || span.component === 'backend'
        || span.lane === 'backend_request' || span.lane === 'live_delegation'
        || (delegationMode === 'responses' && !delegationId && ['live_input', 'live_output'].includes(span.lane)))))
    && (!flowOnly || !delegationId || flowIndex.bySpan.get(span.id)?.has(delegationId))
    && (!errors || ['error', 'rejected', 'send_failed', 'timeout'].includes(span.status))
    && (!search || `${span.label} ${JSON.stringify(span.detail)}`.toLowerCase().includes(search))
    && (axis !== 'source' || span.source_start_ms !== undefined))
    .map((span) => ({
      ...span,
      ...(flowOnly ? { flow_ids: [...(flowIndex.bySpan.get(span.id) ?? [])] } : {}),
      transcript: transcriptPresentation(span),
      plot_start: axis === 'source' ? span.source_start_ms : span.start_ms,
      plot_end: axis === 'source' ? span.source_end_ms : span.end_ms,
    }));
}

class MinHeap {
  constructor(compare) { this.items = []; this.compare = compare; }
  get size() { return this.items.length; }
  peek() { return this.items[0]; }
  push(value) {
    let index = this.items.length;
    this.items.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.compare(this.items[parent], value) <= 0) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = value;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.compare(this.items[child + 1], this.items[child]) < 0) child += 1;
        if (this.compare(last, this.items[child]) <= 0) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

export function layoutSpans(spans, now, minimumMs = 0, { range = null, gapMs = 0 } = {}) {
  const busy = new MinHeap((a, b) => a.end - b.end || a.track - b.track);
  const available = new MinHeap((a, b) => a - b);
  let trackCount = 0;
  const cards = spans.map((span) => {
    const start = range ? Math.max(range.start, span.plot_start) : span.plot_start;
    const end = range ? Math.min(range.end, span.plot_end ?? now) : span.plot_end ?? now;
    const duration = Math.max(minimumMs, end - start);
    const width = range ? Math.min(range.end - range.start, duration) : duration;
    // Keep the label inside the selected range without changing the event's actual timestamps.
    const left = range ? Math.max(range.start, Math.min(start, range.end - width)) : start;
    return { ...span, display_start: left, display_end: left + width };
  });
  return cards.sort((a, b) => a.display_start - b.display_start).map((span) => {
    while (busy.size && busy.peek().end <= span.display_start) available.push(busy.pop().track);
    const track = available.size ? available.pop() : trackCount++;
    busy.push({ track, end: span.display_end + gapMs });
    return { ...span, track };
  });
}

export function visibleSpans(spans, {
  start = -Infinity, end = Infinity, now = 0, minimumMs = 0,
  firstTrack = 0, lastTrack = Infinity, pinnedId = null,
} = {}) {
  return spans.filter((span) => span.id === pinnedId || (
    (span.display_start ?? span.plot_start) <= end
    && (span.display_end ?? Math.max(span.plot_end ?? now, span.plot_start + minimumMs)) >= start
    && (span.track ?? 0) >= firstTrack && (span.track ?? 0) <= lastTrack
  ));
}

export function timelineBounds(spans, now) {
  let start = 0;
  let last = 100;
  for (const span of spans) {
    start = Math.min(start, span.plot_start);
    last = Math.max(last, span.plot_end ?? now);
  }
  return { start, last };
}

export function timelineGeometry(start, end, availableWidth, pixelsPerSecond) {
  const duration = Math.max(1, end - start);
  const scale = pixelsPerSecond > 0 ? pixelsPerSecond / 1000 : availableWidth / duration;
  const width = pixelsPerSecond > 0 ? Math.max(availableWidth, duration * scale) : availableWidth;
  const targetStep = 100 / scale;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const tickStep = [1, 2, 5, 10].find((factor) => factor * magnitude >= targetStep) * magnitude;
  return { width, scale, tickStep };
}

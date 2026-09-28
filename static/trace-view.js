import {
  LANES, TRACE_COMPONENTS, LANE_COMPONENTS, FUNCTION_FLOW_GROUPS, RESPONSES_FLOW_GROUPS, functionFlowIndex,
  delegationLaneVisible,
  layoutSpans, projectSpans, visibleSpans, timelineGeometry, timelineBounds, transcriptLaneLayout,
} from './trace-model.js';
import { WAVEFORM_CHANNELS, waveformColumns } from './audio-waveform.js';
import { splitLedgerText } from './lab-model.js';

const WAVEFORM_LABELS = { input: 'マイク入力', output: 'AI 出力（受信）' };

const COMPONENT_GUIDES = {
  default: {
    label: '標準',
    description: 'GPT-Liveの受信イベント、Ledger、判断モデル、接続・描画などのアプリ処理を同じ時間軸に表示します。表示用のTranscriptGrouperは既定では除外し、「TranscriptGrouper」または「すべて」で確認できます。',
  },
  all: {
    label: 'すべて',
    description: 'GPT-Liveの受信イベント、Grouper、Ledger、接続・描画などのアプリ処理を、発生元別にまとめて同じ時間軸に表示します。件数は保持中の計測レコード数です。',
  },
  live: {
    description: 'GPT-Liveの公開APIから受信したイベントのみ。セッション、入出力transcript、delegation、context ACK、usage、errorを分離します。response.eventは内側のevent.typeも表示します。リプレイでは合成イベントであり、非公開の推論過程は表示しません。',
    url: 'https://learn.microsoft.com/azure/foundry/openai/gpt-live-reference',
  },
  grouper: {
    description: 'アプリ内で動作する公式SDK helperの観測結果です。push・flush・grouping、pending / buffered、segment.updated / segment.closedと閉鎖理由を表示します。GPT-Liveサーバーが発出するイベントとは別です。',
    url: 'https://github.com/openai/openai-node/blob/5d258e4e82d7655fa82a4688fc04c53359417d27/src/lib/live/transcript-grouper.ts',
  },
  ledger: {
    description: 'Ledger の記録は緑、消費しただけの snapshot は黄・破線、後段モデルへの送信開始はオレンジ・太枠です。「後段へ送信した Ledger」レーンには、HTTP 入力として記録された SRT を表示します。consume_srt は送信ではありません。送信レーンはローカル経過時間で確認できます。',
    url: 'https://github.com/openai/openai-cookbook/blob/5986832a554169dc87285b1b0b396941f235a62e/examples/audio/duplex_voice_agent_evaluation/assistants/client/memory.py',
  },
  backend: {
    description: 'Function Calling 方式は Azure OpenAI Responses API を利用し、Ledger → モデルの関数呼び出し要求 → アプリで実関数を実行 → 結果をモデルへ戻して回答します。Jev 方式は Ledger と候補 → 選択・信頼度検証 → アプリで実関数を実行 → コードによる結果整形です。Jev の確認・低信頼度では実行せず、追加推論も行いません。区間は通知のブラウザー受信時刻です。',
  },
  app: {
    description: 'アプリが送信するコマンド、WebRTC・HTTP・観察用WebSocket、マイク・再生状態、IDの正規化、リプレイ制御、UI描画を表示します。アプリからの送信をモデルの発出イベントには分類しません。',
  },
};

const node = (tag, className, text) => {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const ms = (value) => `${value.toFixed(2)} ms`;

export function mountTimeline(timeline) {
  const $ = (id) => document.getElementById(id);
  const viewport = $('operation-chart');
  const workspace = $('operation-workspace');
  const fullscreenButton = $('trace-fullscreen');
  const fullscreenStatus = $('trace-fullscreen-status');
  const sessionControls = $('trace-session-controls');
  const movableControls = ['live-controls', 'replay-controls', 'notice'].map((id) => {
    const element = $(id);
    return { element, parent: element.parentNode, next: element.nextSibling };
  });
  const syncFullscreen = () => {
    const active = document.fullscreenElement === workspace;
    sessionControls.hidden = !active;
    for (const { element, parent, next } of movableControls) {
      if (active) {
        if (element.parentNode !== sessionControls) sessionControls.append(element);
      } else if (element.parentNode === sessionControls) {
        parent.insertBefore(element, next);
      }
    }
    const label = active ? '全画面表示を終了' : 'タイムラインを全画面表示';
    fullscreenButton.setAttribute('aria-pressed', String(active));
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.title = label;
  };
  if (!document.fullscreenEnabled || !workspace.requestFullscreen) {
    fullscreenButton.disabled = true;
    fullscreenButton.title = 'このブラウザーでは全画面表示を利用できません';
    fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
  }
  fullscreenButton.addEventListener('click', async () => {
    fullscreenStatus.hidden = true;
    fullscreenButton.disabled = true;
    try {
      if (document.fullscreenElement === workspace) await document.exitFullscreen();
      else await workspace.requestFullscreen();
    } catch (error) {
      const message = `全画面表示を切り替えられませんでした: ${error instanceof Error ? error.message : String(error)}`;
      fullscreenStatus.textContent = message;
      fullscreenStatus.hidden = false;
      timeline.mark('error', 'Fullscreen error', { message }, { status: 'error' });
    } finally {
      fullscreenButton.disabled = false;
      syncFullscreen();
      fullscreenButton.focus({ preventScroll: true });
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreen);
  const axisButtons = [...$('trace-axis').querySelectorAll('button')];
  const zoomButtons = [...$('trace-zoom').querySelectorAll('button')];
  let axis = 'local';
  let zoom = 1000;
  let selected = null;
  let component = 'default';
  let delegationMode = 'client';
  const clientFlowNote = $('trace-flow-note').textContent;
  let paused = false;
  let renderedVersion = -1;
  let matches = [];
  let projectionKey = null;
  let projectionVersion = -1;
  let layoutScale = null;
  let laneLayouts = new Map();
  let barRows = [];
  let rulerState = null;
  let waveformRows = [];
  let frame = null;
  let detailText = null;
  let timeRange = null;
  let rangeDrag = null;
  let panDrag = null;
  let panInertia = null;
  let panAnimation = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let displayedSpans = [];
  let flowIndex = null;
  let flowVersion = -1;
  const componentButtons = new Map();
  const componentLabel = (key) => COMPONENT_GUIDES[key]?.label ?? TRACE_COMPONENTS[key].label;
  for (const key of ['default', 'all', ...Object.keys(TRACE_COMPONENTS)]) {
    const button = node('button', `trace-component component-${key}`);
    button.type = 'button';
    button.dataset.traceComponent = key;
    button.setAttribute('aria-pressed', String(key === component));
    button.setAttribute('aria-controls', 'operation-chart');
    const count = node('strong', 'trace-component-count', '0');
    button.append(node('span', '', componentLabel(key)), count);
    $('trace-components').append(button);
    componentButtons.set(key, { button, count });
    button.addEventListener('click', () => {
      component = key;
      selected = null;
      updateComponentControls();
      render(true);
    });
  }
  const updateComponentControls = () => {
    const groups = Object.entries(TRACE_COMPONENTS).filter(([key]) =>
      (delegationMode !== 'responses' || key !== 'ledger')
      && (component === 'all' || (component === 'default' && key !== 'grouper') || key === component));
    const allLanes = node('option', '', 'すべてのレーン');
    allLanes.value = '';
    $('trace-lane').replaceChildren(allLanes);
    for (const [, config] of groups) {
      const group = document.createElement('optgroup');
      group.label = config.label;
      for (const lane of config.lanes) {
        if (!delegationLaneVisible(lane, delegationMode)) continue;
        const option = node('option', '', LANES[lane]);
        option.value = lane;
        group.append(option);
      }
      $('trace-lane').append(group);
    }
    const sourceAllowed = !$('trace-flow-only').checked
      && (component === 'all' || component === 'default' || TRACE_COMPONENTS[component].sourceTime);
    $('trace-axis').querySelector('[data-axis="source"]').disabled = !sourceAllowed;
    if (!sourceAllowed) axis = 'local';
    for (const [key, { button }] of componentButtons) {
      button.setAttribute('aria-pressed', String(key === component));
      button.hidden = delegationMode === 'responses' && key === 'ledger';
    }
    $('trace-component-description').textContent = delegationMode === 'responses' && ['default', 'all', 'backend'].includes(component)
      ? 'Responses delegation / GPT-Live の会話文脈・関数要求・実行結果・処理再開・完了'
      : COMPONENT_GUIDES[component].description;
    const link = $('trace-component-docs');
    link.hidden = !COMPONENT_GUIDES[component].url;
    if (!link.hidden) link.href = COMPONENT_GUIDES[component].url;
    viewport.setAttribute('aria-label', `${componentLabel(component)}のガントチャート。バーを選択して詳細表示。縦横スクロール可能。`);
    $('trace-ledger-legend').hidden = delegationMode === 'responses' || (component !== 'all' && component !== 'default' && component !== 'ledger');
    $('trace-flow-note').textContent = delegationMode === 'responses'
      ? 'Responses delegation → 関数要求 → アプリの関数実行 → 関数結果送信 → 処理再開 → Responses 完了。Ledger 未使用。'
      : clientFlowNote;
  };
  const renderRuler = () => {
    if (!rulerState) return;
    const { ruler, start, scale, tickStep, width, labelWidth } = rulerState;
    const stepPixels = tickStep * scale;
    const first = Math.max(0, Math.floor(viewport.scrollLeft / stepPixels));
    const last = Math.ceil(Math.min(width, viewport.scrollLeft + viewport.clientWidth - labelWidth) / stepPixels);
    const ticks = [];
    for (let i = first; i <= last; i += 1) {
      const tick = node('span', 'gantt-tick', `${((start + tickStep * i) / 1000).toFixed(2)} s`);
      tick.style.left = `${i * stepPixels}px`;
      ticks.push(tick);
    }
    ruler.replaceChildren(...ticks);
  };
  const renderWaveforms = () => {
    if (!rulerState) return;
    const { start, scale, width, labelWidth } = rulerState;
    const left = Math.min(width, viewport.scrollLeft);
    const canvasWidth = Math.max(1, Math.ceil(Math.min(width - left, viewport.clientWidth - labelWidth)));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const colors = getComputedStyle(document.documentElement);
    for (const { canvas, channel, samples, count } of waveformRows) {
      canvas.style.left = `${left}px`;
      canvas.style.width = `${canvasWidth}px`;
      canvas.width = Math.ceil(canvasWidth * ratio);
      canvas.height = Math.ceil(64 * ratio);
      const context = canvas.getContext('2d');
      context.scale(ratio, ratio);
      const columns = waveformColumns(samples, start + left / scale, scale, canvasWidth, count);
      const amplitude = (value) => Math.max(-1, Math.min(1, value)) * 28;
      context.fillStyle = colors.getPropertyValue(`--waveform-${channel}`).trim();
      for (let x = 0; x < columns.length; x += 1) {
        const column = columns[x];
        if (!column) continue;
        context.globalAlpha = 0.5;
        context.fillRect(x, 32 - amplitude(column.max), 1, Math.max(1, amplitude(column.max) - amplitude(column.min)));
        context.globalAlpha = 1;
        context.fillRect(x, 32 - amplitude(column.rms), 1, Math.max(1, amplitude(column.rms) * 2));
      }
    }
  };
  const renderBars = (pinnedId) => {
    if (!rulerState) return;
    const { start, scale, labelWidth, now, showText } = rulerState;
    const focused = pinnedId ?? (viewport.contains(document.activeElement) ? document.activeElement.dataset.spanId : null);
    const bounds = viewport.getBoundingClientRect();
    let count = 0;
    for (const { track, items, key, rowHeight, minimumPx } of barRows) {
      const top = track.getBoundingClientRect().top;
      const drawn = visibleSpans(items, {
        start: start + (viewport.scrollLeft - 100) / scale,
        end: start + (viewport.scrollLeft + viewport.clientWidth - labelWidth + 100) / scale,
        now, minimumMs: minimumPx / scale,
        firstTrack: Math.floor((bounds.top - top - rowHeight) / rowHeight),
        lastTrack: Math.ceil((bounds.bottom - top + rowHeight) / rowHeight),
        pinnedId: focused,
      });
      const bars = drawn.map((item) => {
        const duration = (item.plot_end ?? now) - item.plot_start;
        const left = (item.display_start - start) * scale;
        const barWidth = (item.display_end - item.display_start) * scale;
        const visibleDuration = timeRange
          ? Math.max(0, Math.min(item.plot_end ?? now, timeRange.end) - Math.max(item.plot_start, start))
          : duration;
        const transcript = item.transcript;
        const expanded = showText && transcript;
        const sendingLedger = item.lane === 'backend_request';
        const consumedLedger = item.lane === 'ledger_text' && item.detail.change === 'consumed';
        const delivery = sendingLedger ? '↑ 後段へ送信開始' : consumedLedger ? '消費のみ（送信ではない）' : '';
        const title = `${componentLabel(key)} | ${delivery ? `${delivery} | ` : ''}${item.label} | ${ms(item.plot_start)} → ${item.plot_end === null ? '実行中' : ms(item.plot_end)} | ${ms(duration)} | ${item.status}${transcript ? `\n${transcript.caption} / ${transcript.role}\n${transcript.text}` : ''}`;
        const bar = node('button', `gantt-bar status-${item.status}`);
        if (sendingLedger || consumedLedger) {
          bar.classList.add(sendingLedger ? 'ledger-transfer' : 'ledger-consumed');
          bar.dataset.ledgerDelivery = sendingLedger ? 'sending' : 'consumed';
        }
        const timing = node('span', `gantt-time-marker${duration === 0 ? ' point' : ''}`);
        const offset = Math.max(0, (Math.max(item.plot_start, start) - item.display_start) * scale);
        timing.style.left = `${Math.min(Math.max(0, barWidth - 2), offset)}px`;
        timing.style.width = `${Math.max(2, visibleDuration * scale)}px`;
        timing.setAttribute('aria-hidden', 'true');
        bar.append(timing);
        if (expanded) {
          bar.classList.add('gantt-transcript');
          bar.dataset.transcriptKind = transcript.kind;
          const caption = `${consumedLedger ? delivery : transcript.caption} · ${transcript.role}${transcript.text === '' ? ' · 空文字' : !transcript.text.trim() ? ' · 空白のみ' : ''}`;
          const preview = node('span', 'gantt-transcript-text', transcript.preview ?? transcript.text);
          bar.append(node('span', 'gantt-transcript-caption', caption), preview);
        } else {
          bar.classList.add('gantt-operation');
          bar.append(node('span', 'gantt-operation-name', delivery ? `${delivery} · ${item.label}` : item.label));
        }
        bar.dataset.spanId = item.id;
        bar.dataset.component = key;
        bar.title = title;
        bar.setAttribute('aria-label', title);
        bar.setAttribute('aria-pressed', String(item.id === selected));
        bar.style.left = `${left}px`;
        bar.style.width = `${barWidth}px`;
        bar.style.top = `${item.track * rowHeight + 4}px`;
        return bar;
      });
      count += bars.length;
      track.replaceChildren(...bars);
    }
    if (focused) viewport.querySelector(`[data-span-id="${focused}"]`)?.focus({ preventScroll: true });
    $('trace-count').textContent = `対象 ${matches.length} 件${timeRange ? ` / 範囲内 ${displayedSpans.length} 件` : ''} / 保存 ${timeline.spans.length} 件（全履歴） · 画面内描画 ${count} 件`;
  };
  const details = () => {
    const span = displayedSpans.find((item) => item.id === selected);
    const now = frame?.now ?? timeline.now();
    const json = span ? JSON.stringify({
      ...span, duration_ms: (span.end_ms ?? now) - span.start_ms,
      plotted_duration_ms: (span.plot_end ?? now) - span.plot_start,
    }, null, 2) : 'バーを選択すると開始・終了・所要時間・状態・関連 ID・処理内容を表示します。';
    if (json === detailText) return;
    detailText = json;
    const summary = $('trace-selection');
    summary.replaceChildren();
    if (span) {
      const heading = node('div', 'trace-selection-heading');
      heading.append(node('span', `trace-origin component-${span.component}`, componentLabel(span.component)),
        node('strong', '', span.label),
        node('span', `status-tag ${['error', 'rejected', 'send_failed', 'timeout'].includes(span.status) ? 'failure' : ''}`, span.status));
      const values = node('dl', 'trace-selection-values');
      const event = span.detail.event;
      const fields = {
        '開始': ms(span.start_ms),
        '終了': span.end_ms === null ? '実行中 / 待機中' : ms(span.end_ms),
        '所要時間': ms((span.end_ms ?? now) - span.start_ms),
        '実行ソース': span.component === 'backend' || span.lane === 'backend_request' ? 'バックエンドからの処理通知'
          : span.source === 'replay' ? '音声なし / 入力は合成' : 'ライブ接続',
        'event_id': event?.event_id ?? span.detail.event_id,
        'local event_id': span.detail.adapted_event?._lab_generated_event_id ? span.detail.adapted_event.event_id : undefined,
        'client_event_id': event?.error?.client_event_id ?? event?.client_event_id,
        'request_id': span.detail.request_id,
        'delegation_id': event?.delegation_id ?? event?.delegation?.id ?? span.detail.delegation_id,
        '関連する委譲': span.flow_ids?.join(', ') || undefined,
        'execution_id': span.detail.execution_id,
        'call_id': span.detail.call_id ?? undefined,
        'call_id の発行元': span.detail.call_id_source === 'local' ? 'アプリが発行（Jev の応答 ID ではありません）' : undefined,
        '判断方式': span.detail.provider,
        'モデル / デプロイ': span.detail.model,
        '実モデル': span.detail.actual_model,
        'モデル呼び出し': span.detail.model_round === undefined ? undefined : `round ${span.detail.model_round}`,
        'stage': span.detail.stage,
        'response_id': span.detail.response_id ?? event?.event?.response_id ?? event?.event?.response?.id,
        'Ledger 元 event_id': span.detail.source_event_ids?.join(', '),
        'segment_id': span.detail.segment?.id ?? span.detail.ledger_segment?.identifier ?? span.detail.state?.id,
        '文字列の種類': span.transcript?.caption,
        '話者': span.transcript?.role,
        '音声区間': span.source_start_ms === undefined ? undefined : `${ms(span.source_start_ms)} → ${ms(span.source_end_ms)}`,
        '計測時計': span.timing,
        'サーバー経過時間': typeof span.detail.elapsed_ms === 'number' ? ms(span.detail.elapsed_ms) : undefined,
      };
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) values.append(node('dt', '', name), node('dd', '', value));
      }
      summary.append(heading, values);
      if (span.detail.decision) {
        const decision = span.detail.decision;
        const section = node('section', 'trace-decision');
        section.append(node('h3', '', 'Jev の判断'),
          node('p', '', `選択: ${decision.choice} · ${decision.approved ? '実行可' : '実行しない'}`),
          node('p', '', `信頼度 ${decision.confidence} / 実行閾値 ${decision.threshold}`),
          node('p', 'muted', '候補の選択確率と confidence は別の値です。実行可でも天気取得の成功を意味しません。'));
        const distribution = node('dl', 'trace-decision-probabilities');
        for (const [choice, probability] of Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1])) {
          const value = node('dd', '');
          const meter = node('meter', '');
          meter.min = 0;
          meter.max = 1;
          meter.value = probability;
          meter.setAttribute('aria-label', `${choice} の選択確率`);
          value.append(meter, node('span', '', `${(probability * 100).toFixed(1)}%`));
          distribution.append(node('dt', '', choice), value);
        }
        section.append(distribution);
        summary.append(section);
      }
      if (span.lane === 'backend_request') {
        summary.append(node('p', 'ledger-delivery-note ledger-transfer', '↑ この Ledger を後段モデルの HTTP 入力に使用（送信開始の記録）'));
      } else if (span.lane === 'ledger_text' && span.detail.change === 'consumed') {
        summary.append(node('p', 'ledger-delivery-note ledger-consumed',
          'このカードは消費カーソルの変更記録です。後段への送信とは別です。オレンジの「後段へ送信した Ledger」で送信入力を確認してください。'));
      }
      if (span.transcript) {
        const text = node('section', 'trace-transcript');
        text.append(node('h4', '', `${span.transcript.caption}（省略なし）`),
          node('pre', 'trace-transcript-full', span.transcript.text));
        if (span.transcript.kind === 'ledger') {
          const parts = splitLedgerText(span.detail.ledger_segment);
          text.append(node('h4', '', '消費済み'), node('pre', 'trace-transcript-delivered', parts.delivered),
            node('h4', '', '未消費'), node('pre', 'trace-transcript-pending', parts.pending));
        }
        summary.append(text);
      }
      if (span.lane === 'backend_request') {
        if (typeof span.detail.consumed_srt === 'string' && span.detail.consumed_srt !== span.detail.ledger_srt) {
          const current = node('section', 'trace-transcript');
          current.append(node('h4', '', '今回消費した SRT（上の送信 Ledger は過去分を含む累積）'),
            node('pre', '', span.detail.consumed_srt));
          summary.append(current);
        }
        if (span.detail.request_body) {
          const payload = node('details', 'trace-details trace-request');
          payload.append(node('summary', '', 'HTTP に渡したリクエスト本文（認証情報なし）'),
            node('pre', '', JSON.stringify(span.detail.request_body, null, 2)));
          summary.append(payload);
        } else {
          summary.append(node('p', 'muted', '送信本文の記録がない旧形式の通知です。サーバー再起動後の実行で確認してください。'));
        }
        summary.append(node('p', 'muted', 'このマーカーは送信開始の通知です。受理・完了はモデルの応答または失敗イベントで確認してください。'));
      }
    } else {
      summary.append(node('p', 'muted', 'バーを選択すると発生元・イベント名・所要時間・関連IDを表示します。'));
    }
    $('trace-detail').textContent = json;
  };
  const render = (force = false) => {
    if (rangeDrag || panDrag || panInertia) {
      if (!force) return;
      cancelRangeDrag();
      stopPan();
    }
    if (paused && !force) return;
    const active = timeline.spans.some((item) => item.end_ms === null);
    if (!force && renderedVersion === timeline.version && !active) return;
    renderedVersion = timeline.version;
    if (frame && (frame.axis !== axis || frame.generation !== timeline.generation)) clearTimeRange();
    const flowOnly = $('trace-flow-only').checked;
    $('trace-flow-scope').hidden = !flowOnly;
    $('trace-flow-note').hidden = !flowOnly;
    if (flowOnly && flowVersion !== timeline.spanVersion) {
      flowIndex = functionFlowIndex(timeline.spans);
      flowVersion = timeline.spanVersion;
      const current = $('trace-delegation').value;
      const all = node('option', '', 'すべての委譲');
      all.value = '';
      $('trace-delegation').replaceChildren(all, ...flowIndex.ids.map((id) => {
        const option = node('option', '', id);
        option.value = id;
        return option;
      }));
      $('trace-delegation').value = flowIndex.ids.includes(current) ? current : '';
    }
    for (const [key, { count }] of componentButtons) {
      count.textContent = String(key === 'all' ? timeline.spans.length
        : key === 'default' ? timeline.spans.filter((span) => span.component !== 'grouper').length
          : timeline.spans.filter((span) => span.component === key).length);
    }
    $('trace-source').textContent = timeline.source === 'replay'
      ? '音声入力は合成 / バックエンド実行は個別に確認' : 'LIVE · API受信とローカル処理';
    $('trace-axis-note').textContent = axis === 'source'
      ? 'ソース時刻では公開区間を持つイベントとsegmentのみ表示します。session / ACK / usageなど区間のないイベントはローカル経過時間で確認してください。'
      : '受信イベントは到着時点のマーカー、ローカル処理は実測区間です。pending / buffered / currentは状態の保持期間です。';
    const filters = {
      axis, component, delegationMode, lane: $('trace-lane').value, query: $('trace-query').value,
      errors: $('trace-errors').checked, textOnly: $('trace-text-only').checked,
      flowOnly, delegationId: flowOnly ? $('trace-delegation').value : '',
    };
    const key = JSON.stringify(filters);
    if (projectionKey !== key || projectionVersion !== timeline.spanVersion) {
      matches = projectSpans(timeline.spans, { ...filters, flowIndex });
      projectionKey = key;
      projectionVersion = timeline.spanVersion;
      layoutScale = null;
    }
    const showWaveforms = !flowOnly && $('trace-waveforms').checked && axis === 'local' && timeline.source === 'live';
    const histories = Object.values(timeline.waveforms.channels);
    const waveformCount = histories.reduce((sum, channel) => sum + channel.samples.length, 0);
    $('trace-waveform-note').textContent = timeline.source === 'replay'
      ? '音声波形: リプレイは合成イベントのみで、音声データはありません。'
      : axis === 'source'
        ? '音声波形はローカル経過時間で表示します。API の音声ソース時刻とは同期していません。'
        : `音声波形: ${waveformCount} 点 · 20 ms ごとのピーク / RMS · 記録開始からの全履歴を保持（自動削除なし）。全コンポーネント共通の参照レーンです。`;
    frame = {
      axis, flowOnly, generation: timeline.generation, now: timeline.now(), showWaveforms,
      showText: $('trace-text').checked,
      zoom: timeRange ? 0 : zoom,
      histories: Object.fromEntries(WAVEFORM_CHANNELS.map((channel) => {
        const { samples } = timeline.waveforms.channels[channel];
        return [channel, { samples, count: samples.length, endMs: samples.at(-1)?.end_ms ?? 0 }];
      })),
    };
    drawChart();
    details();
  };
  const drawChart = (resizing = false) => {
    if (!frame) return;
    // Resize the last rendered snapshot, without advancing a paused recording.
    const { axis, now, showWaveforms, histories, showText, zoom } = frame;
    const scrollLeft = viewport.scrollLeft;
    const scrollTop = viewport.scrollTop;
    const { start: fullStart, last: spanEnd } = timelineBounds(matches, now);
    const start = timeRange?.start ?? fullStart;
    const last = Math.max(spanEnd,
      ...(showWaveforms ? Object.values(histories).map((channel) => channel.endMs) : []));
    const labelWidth = viewport.clientWidth < 600 ? 110 : 190;
    const available = Math.max(1, viewport.clientWidth - labelWidth);
    const textWidth = Math.min(available, 220, Math.max(96, available * 0.6));
    const operationWidth = Math.min(available, 220, Math.max(160, available * 0.6));
    const textTail = !timeRange && matches.length
      ? Math.min(available / 2, Math.max(operationWidth, showText ? textWidth : 0) + 8) : 0;
    // A duration-proportional margin must not scroll the latest event out of the viewport.
    const padding = Math.max(100, (last - start) * 0.02);
    const end = timeRange?.end ?? last + (zoom > 0 ? Math.min(padding, available * 0.15 / (zoom / 1000)) : padding);
    const { width: plotWidth, scale, tickStep } = timelineGeometry(start, end, Math.max(1, available - textTail), zoom);
    const width = plotWidth + textTail;
    const layoutRange = timeRange ?? { start, end: start + width / scale };
    displayedSpans = timeRange ? matches.filter((span) =>
      span.plot_start <= timeRange.end && (span.plot_end ?? now) >= timeRange.start) : matches;
    const layoutKey = `${scale}:${width}:${showText}:${textWidth}:${operationWidth}:${timeRange?.start}:${timeRange?.end}:${displayedSpans.length}`;
    if (layoutScale !== layoutKey) {
      const lanes = new Map();
      for (const span of displayedSpans) {
        if (!lanes.has(span.lane)) lanes.set(span.lane, []);
        lanes.get(span.lane).push(span);
      }
      laneLayouts = new Map([...lanes].map(([lane, spans]) => {
        const config = transcriptLaneLayout(spans, showText, textWidth, operationWidth);
        return [lane, { ...config, items: layoutSpans(spans, now, config.minimumPx / scale, { range: layoutRange, gapMs: 6 / scale }) }];
      }));
      layoutScale = layoutKey;
    } else {
      for (const layout of laneLayouts.values()) {
        if (layout.items.some((item) => item.plot_end === null)) {
          layout.items = layoutSpans(layout.items, now, layout.minimumPx / scale, { range: layoutRange, gapMs: 6 / scale });
        }
      }
    }
    const chart = node('div', timeRange ? 'gantt gantt-range' : 'gantt');
    chart.style.width = `${width + labelWidth}px`;
    chart.style.setProperty('--lane-width', `${labelWidth}px`);
    chart.style.setProperty('--grid-step', `${tickStep * scale}px`);
    const header = node('div', 'gantt-row gantt-header');
    header.title = 'ドラッグで縦横スクロール。横方向に移動すると最新時刻の追従を解除します。';
    header.append(node('div', 'gantt-label', axis === 'source' ? '音声ソース時刻' : 'リセットからの経過時間'));
    const ruler = node('div', 'gantt-track gantt-ruler');
    rulerState = { ruler, start, scale, tickStep, width, labelWidth, now, showText, textWidth };
    header.append(ruler);
    chart.append(header);
    waveformRows = [];
    barRows = [];
    if (showWaveforms) {
      const heading = node('div', 'gantt-component component-app');
      heading.append(node('span', '', '音声波形 / ブラウザーで計測'));
      chart.append(heading);
      for (const channel of WAVEFORM_CHANNELS) {
        const { samples, count } = histories[channel];
        const row = node('div', `gantt-row waveform-row waveform-${channel}`);
        row.append(node('div', 'gantt-label', WAVEFORM_LABELS[channel]));
        const track = node('div', 'gantt-track waveform-track');
        if (zoom === 0 && count) {
          track.dataset.rangeSelectable = 'true';
          track.title = '左右にドラッグして時間範囲を拡大。Escape で選択を取り消します。';
        }
        const canvas = node('canvas', 'waveform-canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${WAVEFORM_LABELS[channel]}の振幅波形（${count} 点）。縦軸は -1 から 1、中央が無音。`);
        canvas.dataset.waveformChannel = channel;
        track.append(canvas);
        if (!count) track.append(node('span', 'waveform-empty',
          channel === 'input' ? 'マイク接続後に表示します' : 'AI の音声受信後に表示します'));
        waveformRows.push({ canvas, channel, samples, count });
        row.append(track);
        chart.append(row);
      }
    }
    const groups = frame.flowOnly ? (delegationMode === 'responses' ? RESPONSES_FLOW_GROUPS : FUNCTION_FLOW_GROUPS)
      : Object.entries(TRACE_COMPONENTS).map(([key, config]) => ({ key, ...config }));
    for (const config of groups) {
      if (!config.lanes.some((lane) => laneLayouts.has(lane))) continue;
      const groupHeader = node('div', `gantt-component component-${config.key}`);
      groupHeader.append(node('span', '', config.label));
      chart.append(groupHeader);
      for (const lane of config.lanes) {
        const key = LANE_COMPONENTS[lane];
        const layout = laneLayouts.get(lane);
        if (!layout?.items.length) continue;
        const { items, rowHeight } = layout;
        const row = node('div', `gantt-row lane-${lane} component-${key}`);
        row.append(node('div', 'gantt-label', `${LANES[lane]} (${items.length})`));
        const track = node('div', 'gantt-track');
        track.style.height = `${(items.reduce((max, item) => Math.max(max, item.track), 0) + 1) * rowHeight + 8}px`;
        barRows.push({ track, ...layout, key });
        row.append(track);
        chart.append(row);
      }
    }
    const focused = viewport.contains(document.activeElement) ? document.activeElement.dataset.spanId : null;
    if (!displayedSpans.length && !showWaveforms) {
      viewport.replaceChildren(node('p', 'empty-text', `${componentLabel(component)}: 条件に一致する記録はありません。絞り込みを解除するか、イベントを入力してください。`));
    } else viewport.replaceChildren(chart);
    if (timeRange || resizing) {
      viewport.scrollLeft = timeRange ? 0 : scrollLeft;
      viewport.scrollTop = scrollTop;
    } else if ($('trace-follow').checked && !focused) viewport.scrollLeft = viewport.scrollWidth;
    renderRuler();
    renderWaveforms();
    renderBars(focused);
    updateRangeControls();
  };
  const rangeLabel = ({ start, end }) => `${ms(start)} → ${ms(end)}（${ms(end - start)}）`;
  const updateRangeControls = () => {
    const canSelect = frame?.showWaveforms && frame.zoom === 0
      && waveformRows.some(({ count }) => count > 0);
    $('trace-range-tools').hidden = !timeRange && !canSelect;
    $('trace-range-reset').hidden = !timeRange;
    $('trace-range-status').textContent = timeRange
      ? `選択範囲: ${rangeLabel(timeRange)} · 最新時刻の追従を停止中`
      : '波形を左右にドラッグすると、その時間範囲を拡大表示します。';
    for (const button of axisButtons) button.setAttribute('aria-pressed', String(button.dataset.axis === axis));
    for (const button of zoomButtons) {
      button.setAttribute('aria-pressed', String(!timeRange && Number(button.dataset.zoom) === zoom));
    }
    $('trace-range-zoom').hidden = !timeRange;
    $('trace-follow').disabled = !!timeRange;
  };
  const clearTimeRange = () => {
    timeRange = null;
  };
  const showFullRange = () => {
    cancelRangeDrag();
    stopPan();
    clearTimeRange();
    zoom = 0;
    frame.zoom = 0;
    viewport.scrollLeft = 0;
    drawChart(true);
    details();
  };
  const cancelRangeDrag = () => {
    if (!rangeDrag) return;
    const { id, overlays } = rangeDrag;
    rangeDrag = null;
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    for (const overlay of overlays) overlay.remove();
    viewport.classList.remove('range-selecting');
    updateRangeControls();
  };
  const moveRangeDrag = (clientX) => {
    const { left, width, from, start, scale, overlays } = rangeDrag;
    rangeDrag.to = Math.max(0, Math.min(width, clientX - left));
    const low = Math.min(from, rangeDrag.to);
    const high = Math.max(from, rangeDrag.to);
    for (const overlay of overlays) {
      overlay.style.left = `${low}px`;
      overlay.style.width = `${high - low}px`;
    }
    $('trace-range-status').textContent = `選択中: ${rangeLabel({ start: start + low / scale, end: start + high / scale })} · 離して拡大 / Escape で取り消し`;
  };
  const stopInertia = () => {
    if (panAnimation !== null) cancelAnimationFrame(panAnimation);
    panAnimation = null;
    panInertia = null;
  };
  const stopPan = () => {
    stopInertia();
    if (!panDrag) return;
    const { id } = panDrag;
    panDrag = null;
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    viewport.classList.remove('timeline-panning');
  };
  const animatePan = (now) => {
    panAnimation = null;
    if (!panInertia) return;
    if (document.hidden || reducedMotion.matches) {
      stopInertia();
      return;
    }
    const motion = panInertia;
    const elapsed = Math.max(0, now - motion.time);
    const decay = Math.exp(-elapsed / 220);
    // Integrate exponential deceleration so travel is independent of frame rate.
    const distance = 220 * (1 - decay);
    motion.time = now;
    for (const [position, velocity, scroll, extent, size] of [
      ['x', 'vx', 'scrollLeft', 'scrollWidth', 'clientWidth'],
      ['y', 'vy', 'scrollTop', 'scrollHeight', 'clientHeight'],
    ]) {
      const next = motion[position] + motion[velocity] * distance;
      const max = Math.max(0, viewport[extent] - viewport[size]);
      motion[position] = Math.max(0, Math.min(max, next));
      viewport[scroll] = motion[position];
      motion[velocity] *= decay;
      if (next <= 0 || next >= max || Math.abs(motion[velocity]) < 0.02) motion[velocity] = 0;
    }
    if (!motion.vx && !motion.vy) stopInertia();
    else panAnimation = requestAnimationFrame(animatePan);
  };
  const movePan = (event) => {
    const dx = event.clientX - panDrag.x;
    const dy = event.clientY - panDrag.y;
    if (!panDrag.moved && Math.hypot(dx, dy) < 3) return;
    panDrag.moved = true;
    viewport.scrollLeft = panDrag.left - dx;
    viewport.scrollTop = panDrag.top - dy;
    if (viewport.scrollLeft !== panDrag.left && !timeRange) $('trace-follow').checked = false;
    panDrag.samples.push({ time: event.timeStamp, x: viewport.scrollLeft, y: viewport.scrollTop });
    panDrag.samples = panDrag.samples.filter((sample) => event.timeStamp - sample.time <= 100);
  };
  workspace.addEventListener('pointerdown', stopInertia, { capture: true });
  workspace.addEventListener('wheel', stopInertia, { capture: true, passive: true });
  workspace.addEventListener('keydown', (event) => {
    if (panInertia && event.key === 'Escape') event.preventDefault();
    stopInertia();
  }, { capture: true });
  const stopHiddenPan = () => { if (document.hidden) stopPan(); };
  document.addEventListener('visibilitychange', stopHiddenPan);
  viewport.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.gantt-header') || !event.isPrimary || event.button !== 0 || rangeDrag || panDrag) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    panDrag = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop, moved: false,
      samples: [{ time: event.timeStamp, x: viewport.scrollLeft, y: viewport.scrollTop }],
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('timeline-panning');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (panDrag?.id === event.pointerId) movePan(event);
  });
  viewport.addEventListener('pointerup', (event) => {
    if (panDrag?.id !== event.pointerId) return;
    movePan(event);
    const { moved, samples } = panDrag;
    stopPan();
    if (!moved || reducedMotion.matches || samples.length < 2) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const duration = last.time - first.time;
    if (duration <= 0) return;
    const vx = Math.max(-3, Math.min(3, (last.x - first.x) / duration));
    const vy = Math.max(-3, Math.min(3, (last.y - first.y) / duration));
    if (Math.hypot(vx, vy) < 0.05) return;
    panInertia = { x: viewport.scrollLeft, y: viewport.scrollTop, vx, vy, time: performance.now() };
    panAnimation = requestAnimationFrame(animatePan);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(type, (event) => {
      if (panDrag?.id === event.pointerId) stopPan();
    });
  }
  viewport.addEventListener('pointerdown', (event) => {
    const track = event.target.closest('.waveform-track[data-range-selectable]');
    if (!track || !event.isPrimary || event.button !== 0 || rangeDrag || panDrag) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    const { start, scale, width } = rulerState;
    const left = track.getBoundingClientRect().left;
    const from = Math.max(0, Math.min(width, event.clientX - left));
    const overlays = waveformRows.map(({ canvas }) => {
      const overlay = node('div', 'trace-range-brush');
      overlay.setAttribute('aria-hidden', 'true');
      canvas.parentElement.append(overlay);
      return overlay;
    });
    rangeDrag = { id: event.pointerId, left, width, from, to: from, start, scale, overlays };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('range-selecting');
    moveRangeDrag(event.clientX);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (rangeDrag?.id === event.pointerId) moveRangeDrag(event.clientX);
  });
  viewport.addEventListener('pointerup', (event) => {
    if (rangeDrag?.id !== event.pointerId) return;
    moveRangeDrag(event.clientX);
    const { from, to, start, scale } = rangeDrag;
    cancelRangeDrag();
    // Ignore clicks and sub-pixel time ranges rather than creating an unusable zoom.
    if (Math.abs(to - from) < 6 || Math.abs(to - from) / scale < 1) return;
    timeRange = { start: start + Math.min(from, to) / scale, end: start + Math.max(from, to) / scale };
    zoom = 0;
    frame.zoom = 0;
    layoutScale = null;
    drawChart(true);
    if (!displayedSpans.some((span) => span.id === selected)) selected = null;
    details();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(type, (event) => {
      if (rangeDrag?.id === event.pointerId) cancelRangeDrag();
    });
  }
  viewport.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || (!rangeDrag && !panDrag)) return;
    event.preventDefault();
    cancelRangeDrag();
    stopPan();
  });
  $('trace-range-reset').addEventListener('click', () => {
    $('trace-zoom').querySelector('[data-zoom="0"]').focus({ preventScroll: true });
    showFullRange();
  });
  for (const button of axisButtons) {
    button.addEventListener('click', () => {
      if (axis === button.dataset.axis) return;
      axis = button.dataset.axis;
      render(true);
    });
  }
  for (const button of zoomButtons) {
    button.addEventListener('click', () => {
      const next = Number(button.dataset.zoom);
      if (!timeRange && zoom === next) return;
      cancelRangeDrag();
      stopPan();
      clearTimeRange();
      zoom = next;
      frame.zoom = zoom;
      drawChart();
      details();
    });
  }
  viewport.addEventListener('click', (event) => {
    const button = event.target.closest('[data-span-id]');
    if (!button) return;
    const changed = selected !== button.dataset.spanId;
    selected = button.dataset.spanId;
    details();
    setSidebarVisible(true);
    if (changed) $('trace-sidebar-content').scrollTop = 0;
    viewport.querySelectorAll('[data-span-id]').forEach((bar) =>
      bar.setAttribute('aria-pressed', String(bar.dataset.spanId === selected)));
  });
  viewport.addEventListener('scroll', () => { renderRuler(); renderWaveforms(); renderBars(); }, { passive: true });
  for (const id of ['trace-lane', 'trace-errors', 'trace-follow', 'trace-waveforms', 'trace-text', 'trace-text-only']) {
    $(id).addEventListener('change', () => render(true));
  }
  $('trace-query').addEventListener('input', () => render(true));
  $('trace-flow-only').addEventListener('change', () => {
    if ($('trace-flow-only').checked) focusFlow();
    else {
      updateComponentControls();
      render(true);
    }
  });
  $('trace-delegation').addEventListener('change', () => {
    clearTimeRange();
    zoom = 0;
    selected = null;
    render(true);
  });
  $('trace-clear-filters').addEventListener('click', () => {
    $('trace-lane').value = '';
    $('trace-query').value = '';
    $('trace-errors').checked = false;
    $('trace-text-only').checked = false;
    $('trace-flow-only').checked = false;
    $('trace-delegation').value = '';
    component = 'default';
    updateComponentControls();
    axis = 'local';
    selected = null;
    clearTimeRange();
    render(true);
  });
  $('trace-pause').addEventListener('click', () => {
    paused = !paused;
    const label = paused ? '表示を再開' : '表示を一時停止';
    $('trace-pause').setAttribute('aria-label', label);
    $('trace-pause').title = label;
    $('trace-pause').setAttribute('aria-pressed', String(paused));
    if (!paused) render(true);
  });
  const split = $('trace-split');
  const sidebar = $('trace-sidebar');
  const splitter = $('trace-splitter');
  const sidebarToggle = $('trace-sidebar-toggle');
  let sidebarWidth = 360;
  let drag = null;
  const sidebarLimits = () => {
    const overlay = split.clientWidth < 700;
    const max = Math.max(0, Math.floor(split.clientWidth - (overlay ? 32 : 330)));
    return { min: Math.min(260, max), max, overlay };
  };
  const sizeSidebar = () => {
    const { min, max, overlay } = sidebarLimits();
    const width = Math.round(Math.min(max, Math.max(min, sidebarWidth)));
    split.dataset.sidebarOverlay = String(overlay);
    split.style.setProperty('--sidebar-width', `${width}px`);
    splitter.setAttribute('aria-valuemin', String(min));
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(width));
    splitter.setAttribute('aria-valuetext', `${width} px`);
  };
  const stopDrag = () => {
    if (drag && splitter.hasPointerCapture(drag.id)) splitter.releasePointerCapture(drag.id);
    drag = null;
    split.classList.remove('resizing');
  };
  const setSidebarVisible = (show) => {
    if (!show) {
      if (sidebar.contains(document.activeElement) || document.activeElement === splitter) {
        sidebarToggle.focus({ preventScroll: true });
      }
      stopDrag();
    }
    sidebar.hidden = !show;
    splitter.hidden = !show;
    sidebarToggle.setAttribute('aria-expanded', String(show));
    const label = show ? '詳細サイドバーを隠す' : '詳細サイドバーを表示';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.title = label;
    sizeSidebar();
  };
  sidebarToggle.addEventListener('click', () => setSidebarVisible(sidebar.hidden));
  $('trace-sidebar-close').addEventListener('click', () => setSidebarVisible(false));
  sidebar.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setSidebarVisible(false);
  });
  splitter.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    splitter.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    splitter.setPointerCapture(event.pointerId);
    split.classList.add('resizing');
  });
  splitter.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { min, max } = sidebarLimits();
    sidebarWidth = Math.min(max, Math.max(min, drag.width + drag.x - event.clientX));
    sizeSidebar();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    splitter.addEventListener(type, stopDrag);
  }
  splitter.addEventListener('keydown', (event) => {
    const { min, max } = sidebarLimits();
    const width = Number(splitter.getAttribute('aria-valuenow'));
    const step = event.shiftKey ? 50 : 20;
    if (event.key === 'ArrowLeft') sidebarWidth = Math.min(max, width + step);
    else if (event.key === 'ArrowRight') sidebarWidth = Math.max(min, width - step);
    else if (event.key === 'Home') sidebarWidth = min;
    else if (event.key === 'End') sidebarWidth = max;
    else if (event.key === 'Enter') setSidebarVisible(false);
    else return;
    event.preventDefault();
    sizeSidebar();
  });
  const resizeObserver = new ResizeObserver(() => {
    cancelRangeDrag();
    stopPan();
    sizeSidebar();
    drawChart(true);
  });
  const focusFlow = ({ scroll = true } = {}) => {
    component = 'all';
    axis = 'local';
    zoom = 0;
    selected = null;
    clearTimeRange();
    $('trace-flow-only').checked = true;
    $('trace-delegation').value = '';
    updateComponentControls();
    $('trace-query').value = '';
    $('trace-errors').checked = false;
    $('trace-text-only').checked = false;
    $('trace-text').checked = true;
    $('trace-follow').checked = false;
    render(true);
    if (scroll) $('operation-workspace').scrollIntoView({ block: 'start' });
  };
  resizeObserver.observe(split);
  resizeObserver.observe(viewport);
  const timer = setInterval(render, 150);
  window.addEventListener('themechange', renderWaveforms);
  window.addEventListener('pagehide', () => {
    document.removeEventListener('fullscreenchange', syncFullscreen);
    document.removeEventListener('visibilitychange', stopHiddenPan);
    clearInterval(timer);
    resizeObserver.disconnect();
    stopDrag();
    cancelRangeDrag();
    stopPan();
  }, { once: true });
  sizeSidebar();
  updateComponentControls();
  render(true);
  return {
    focusFlow,
    setDelegationMode(value) {
      if (delegationMode === value) return;
      delegationMode = value;
      if (component === 'ledger') component = 'default';
      flowVersion = -1;
      projectionKey = null;
      updateComponentControls();
      render(true);
    },
    reset() {
      cancelRangeDrag();
      stopPan();
      clearTimeRange();
      selected = null;
      $('trace-delegation').value = '';
      paused = false;
      $('trace-pause').setAttribute('aria-label', '表示を一時停止');
      $('trace-pause').title = '表示を一時停止';
      $('trace-pause').setAttribute('aria-pressed', 'false');
      render(true);
    },
  };
}

import { t } from './i18n.js';

export const DEFAULT_OPTIONS = Object.freeze({
  minTurnSeparationMs: 500,
  assistantSilenceMs: 2000,
  backchannelMaxDurationMs: 1000,
  backchannelIsolationMs: 2000,
  additionalAcknowledgments: [],
});

export const GROUPER_TYPES = new Set([
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.closed',
]);

export function createEventAdapter() {
  const prefix = `local_${crypto.randomUUID()}`;
  let sequence = 0;
  return (event) => {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new Error(t('イベントには文字列の type が必要です。'));
    }
    if (GROUPER_TYPES.has(event.type) && event.type !== 'session.closed' && event.event_id == null) {
      return { ...event, event_id: `${prefix}_${++sequence}`, _lab_generated_event_id: true };
    }
    return event;
  };
}

export function resolveOptions(values) {
  const resolved = { ...DEFAULT_OPTIONS, ...values };
  for (const key of Object.keys(DEFAULT_OPTIONS).filter((key) => key !== 'additionalAcknowledgments')) {
    const value = Number(resolved[key]);
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
      throw new Error(t('{0}: 0 ～ 2147483647 ms を入力してください。', key));
    }
    resolved[key] = value;
  }
  resolved.additionalAcknowledgments = Array.isArray(resolved.additionalAcknowledgments)
    ? [...resolved.additionalAcknowledgments]
    : String(resolved.additionalAcknowledgments).split(',').map((word) => word.trim()).filter(Boolean);
  return resolved;
}

export function readGrouperDiagnostics(grouper) {
  // Deliberately read-only: these are pinned SDK implementation details, not public API.
  return JSON.parse(JSON.stringify({
    pending: grouper.pending ?? [],
    anchor: grouper.anchor ?? null,
    lastStartMs: grouper.lastStartMs ?? null,
    seenIds: grouper.seenIds?.size ?? 0,
    current: grouper.grouping?.current ?? null,
    buffered: grouper.grouping?.buffered ?? null,
    deadline_source_ms: grouper.grouping?.deadline() ?? null,
  }));
}

export function sourceTime(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(3)} s` : '—';
}

export function splitLedgerText(row) {
  // The Python ledger cursor counts Unicode code points, not UTF-16 code units.
  const characters = Array.from(row.text ?? '');
  const cursor = Math.max(0, Number(row.delivered_characters) || 0);
  return { delivered: characters.slice(0, cursor).join(''), pending: characters.slice(cursor).join('') };
}

export function waitForIce(peer, signal, timeoutMs = 10_000) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal?.removeEventListener('abort', aborted);
    };
    const changed = () => {
      if (peer.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t('ICE 候補の収集がタイムアウトしました。ネットワークを確認してください。')));
    }, timeoutMs);
    peer.addEventListener('icegatheringstatechange', changed);
    signal?.addEventListener('abort', aborted, { once: true });
    changed();
  });
}

import { readGrouperDiagnostics } from './lab-model.js';

export function instrumentGrouper(grouper, timeline) {
  const slots = new Map();
  const observe = () => {
    const debug = readGrouperDiagnostics(grouper);
    const states = {
      pending: debug.pending.length ? debug.pending : null,
      buffered: debug.buffered,
      current: debug.current,
    };
    for (const [name, value] of Object.entries(states)) {
      const key = JSON.stringify(value);
      const previous = slots.get(name);
      if (previous?.key === key) continue;
      timeline.end(previous?.span, 'ok', { next_state: value });
      slots.set(name, {
        key,
        span: value ? timeline.begin(name === 'current' ? 'segment' : name, name, {
          state: value, deadline_source_ms: debug.deadline_source_ms,
          meaning: 'State residency, not CPU time or audio playback',
        }) : null,
      });
    }
  };
  // Pinned private-method boundaries: forward this, arguments, result and exceptions unchanged.
  // No SDK timers or grouping state are replaced; timer-driven transitions are observed too.
  for (const [target, names, prefix] of [
    [grouper, ['push', 'close', 'flushPending', 'commit', 'schedule'], 'Grouper'],
    [grouper.grouping, ['process', 'advance', 'close', 'maybeDropBackchannel', 'promote'], 'Grouping'],
  ]) {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') throw new Error(`Unsupported pinned SDK: ${prefix}.${name}`);
      target[name] = function (...args) {
        return timeline.measure('grouper', `${prefix}.${name}`, () => {
          try { return original.apply(this, args); }
          finally { observe(); }
        }, name === 'push' ? { event_id: args[0]?.event_id, type: args[0]?.type } : {});
      };
    }
  }
  return grouper;
}

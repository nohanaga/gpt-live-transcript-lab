/*! OpenAI TranscriptGrouper · openai-node@5d258e4e82d7655fa82a4688fc04c53359417d27 · Apache-2.0 · see LICENSE.openai-node */

// vendor/openai-node/src/core/EventEmitter.ts
var EventEmitter = class {
  #listeners = /* @__PURE__ */ Object.create(null);
  #emittedListenerRegistrations = /* @__PURE__ */ new WeakMap();
  #pendingListenerCleanup = /* @__PURE__ */ new Set();
  #listenerDispatchDepth = 0;
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this, so that calls can be chained
   */
  on(event, listener) {
    const listeners = this.#listeners[event] ||= [];
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this, so that calls can be chained
   */
  off(event, listener) {
    const listeners = this.#listeners[event];
    if (!listeners) {
      return this;
    }
    const emittedRegistration = this.#emittedListenerRegistrations.get(listener);
    if (emittedRegistration?.event === event && !emittedRegistration.registration.removed && !emittedRegistration.registration.detached) {
      this.#removeEmittedListener(
        event,
        emittedRegistration.registration
      );
      return this;
    }
    const index = listeners.findIndex(
      (registration) => !registration.removed && registration.listener === listener
    );
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this, so that calls can be chained
   */
  once(event, listener) {
    const listeners = this.#listeners[event] ||= [];
    listeners.push({ listener, once: true });
    return this;
  }
  #onceForEmitted(event, listener) {
    const previousListeners = this.#listeners[event];
    const previousLength = previousListeners?.length ?? 0;
    this.once(event, listener);
    const listeners = this.#listeners[event];
    const [registration] = listeners?.slice(-1) ?? [];
    if ((previousListeners === void 0 || listeners === previousListeners) && listeners?.length === previousLength + 1 && registration?.listener === listener && registration.once) {
      this.#emittedListenerRegistrations.set(listener, { event, registration });
    }
  }
  #removeEmittedListener(event, registration) {
    if (registration.removed) {
      return;
    }
    registration.removed = true;
    this.#emittedListenerRegistrations.delete(registration.listener);
    this.#pendingListenerCleanup.add(event);
    if (this.#listenerDispatchDepth === 0) {
      this.#cleanupEmittedListeners();
    }
  }
  #cleanupEmittedListeners() {
    for (const event of this.#pendingListenerCleanup) {
      const eventType = event;
      const listeners = this.#listeners[eventType];
      if (listeners) {
        this.#listeners[eventType] = listeners.filter((listener) => !listener.removed);
      }
    }
    this.#pendingListenerCleanup.clear();
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * Events without arguments resolve to `undefined`, single-argument events resolve
   * to that argument, and events with multiple arguments resolve to an argument tuple.
   *
   * @returns A promise for the next event, or a rejection if an error occurs first.
   * Requesting the `error` event resolves with the emitted error instead.
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve, reject) => {
      const listeners = {
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Failures and rejection reasons can be arbitrary JavaScript values; preserve them until inspection or forwarding.
        onError: (error) => {
          this.off(event, listeners.onEvent);
          reject(error);
        },
        onEvent: (...values) => {
          if (event !== "error") {
            this.off("error", listeners.onError);
          }
          resolve(values.length > 1 ? values : values[0]);
        }
      };
      if (event !== "error") {
        this.#onceForEmitted("error", listeners.onError);
      }
      this.#onceForEmitted(event, listeners.onEvent);
    });
  }
  _emit(event, ...args) {
    const listeners = this.#listeners[event];
    if (listeners) {
      this.#listeners[event] = listeners.filter((listener) => {
        if (listener.once) {
          listener.detached = true;
        }
        return !listener.once && !listener.removed;
      });
      let listenerThrew = false;
      let firstListenerError;
      this.#listenerDispatchDepth += 1;
      try {
        for (const registration of listeners) {
          if (!registration.removed) {
            try {
              const { listener } = registration;
              listener(...args);
            } catch (error) {
              if (!listenerThrew) {
                listenerThrew = true;
                firstListenerError = error;
              }
            }
          }
        }
      } finally {
        this.#listenerDispatchDepth -= 1;
        if (this.#listenerDispatchDepth === 0) {
          this.#cleanupEmittedListeners();
        }
      }
      if (listenerThrew) {
        throw firstListenerError;
      }
    }
  }
  _hasListener(event) {
    const listeners = this.#listeners[event];
    return listeners && listeners.some((listener) => !listener.removed);
  }
};

// vendor/openai-node/src/core/error.ts
var OpenAIError = class extends Error {
};

// vendor/openai-node/src/lib/live/transcript-grouping.ts
var ACKNOWLEDGMENTS = [
  "aha",
  "alright",
  "gotcha",
  "hm",
  "hmm",
  "mhm",
  "mm",
  "mm hmm",
  "okay",
  "ok",
  "right",
  "sure",
  "uh huh",
  "yeah",
  "yep",
  "yes"
];
function normalizeAcknowledgment(text) {
  const normalized = text.toLowerCase().split("-").join(" ").replace(/^[\s.,!?;:"'()[\]{}]+/u, "");
  let end = normalized.length;
  while (end > 0 && /[\s.,!?;:"'()[\]{}]/u.test(normalized.charAt(end - 1))) {
    end -= 1;
  }
  return normalized.slice(0, end).split(/\s+/u).join(" ");
}
var TranscriptGrouping = class _TranscriptGrouping {
  current;
  buffered;
  lastId = null;
  nextId = 0;
  lastAssistantEnd;
  options;
  idPrefix;
  acknowledgments;
  maxAcknowledgmentLength;
  constructor(options, idPrefix) {
    this.options = options;
    this.idPrefix = idPrefix;
    this.acknowledgments = [
      ...ACKNOWLEDGMENTS,
      ...options.additionalAcknowledgments.map(normalizeAcknowledgment).filter(Boolean)
    ];
    let maxLength = 0;
    for (const acknowledgment of this.acknowledgments) {
      maxLength = Math.max(maxLength, acknowledgment.length);
    }
    this.maxAcknowledgmentLength = maxLength;
  }
  get speaker() {
    return this.current?.speaker;
  }
  process(fragments) {
    const events = [];
    const preferred = this.current?.speaker ?? "user";
    const ordered = [
      ...fragments.filter((fragment) => fragment.speaker === preferred),
      ...fragments.filter((fragment) => fragment.speaker !== preferred)
    ];
    const [first] = ordered;
    if (!first) {
      return events;
    }
    let deadline = this.deadline();
    while (deadline !== void 0 && deadline < first.startMs) {
      events.push(...this.advance(deadline));
      deadline = this.deadline();
    }
    if (this.current && !ordered.some((fragment) => fragment.speaker === this.current?.speaker)) {
      events.push(
        ...this.advance(
          first.startMs,
          ordered.some((fragment) => fragment.speaker === "user")
        )
      );
    }
    for (const fragment of ordered) {
      events.push(...this.ingest(fragment));
    }
    return events;
  }
  advance(timeMs, hasIncomingUser = false) {
    if (this.current && this.buffered && timeMs - this.current.endMs >= this.options.minTurnSeparationMs && !this.keepBackchannel(timeMs)) {
      this.buffered = this.maybeDropBackchannel(timeMs);
      if (this.buffered) {
        return this.promote();
      }
    }
    if (this.current?.speaker === "assistant" && !hasIncomingUser && timeMs - this.current.endMs >= this.options.assistantSilenceMs) {
      return this.finishCurrent("inactivity");
    }
    return [];
  }
  deadline() {
    if (!this.current) {
      return void 0;
    }
    if (this.buffered) {
      const separation = this.current.endMs + this.options.minTurnSeparationMs;
      if (this.mightBeBackchannel() && this.buffered.canDropAsBackchannel && !this.userContinued() && !this.recentAssistant()) {
        return Math.max(separation, this.buffered.endMs + this.options.backchannelIsolationMs);
      }
      return separation;
    }
    return this.current.speaker === "assistant" ? this.current.endMs + this.options.assistantSilenceMs : void 0;
  }
  close(timeMs, reason) {
    const buffered = this.maybeDropBackchannel(timeMs);
    const events = this.finishCurrent(reason);
    this.buffered = void 0;
    if (buffered?.text) {
      events.push(...this.emit(buffered), ...this.finish(buffered, reason));
    }
    if (reason === "timestamp_reset") {
      this.lastAssistantEnd = void 0;
    }
    return events;
  }
  ingest(fragment) {
    if (!this.current) {
      this.current = this.newTurn(fragment);
      return this.emit(this.current);
    }
    if (fragment.speaker === this.current.speaker) {
      _TranscriptGrouping.append(this.current, fragment, this.buffered !== void 0);
      return this.emit(this.current);
    }
    if (this.current.speaker === "user" && this.userContinued()) {
      this.buffered = void 0;
    }
    const separation = fragment.startMs - this.current.endMs;
    if (this.current.speaker === "assistant") {
      this.buffer(fragment);
      return this.promote();
    }
    const withinDuration = fragment.endMs - (this.buffered?.startMs ?? fragment.startMs) < this.options.backchannelMaxDurationMs;
    const acknowledgment = this.acknowledgment(fragment, withinDuration);
    const normalized = withinDuration ? acknowledgment.text : void 0;
    if (separation < this.options.minTurnSeparationMs) {
      this.buffer(
        fragment,
        normalized !== void 0 && normalized.length > 0 && this.acknowledgments.some((phrase) => phrase.startsWith(normalized)),
        acknowledgment
      );
      return [];
    }
    if (normalized !== void 0 && this.acknowledgments.includes(normalized)) {
      this.buffer(fragment, this.buffered !== void 0, acknowledgment);
      return [];
    }
    this.buffered = this.maybeDropBackchannel(void 0, fragment);
    const events = this.finishCurrent("speaker_change");
    if (this.buffered) {
      this.current = this.buffered;
      this.buffered = void 0;
      _TranscriptGrouping.append(this.current, fragment);
    } else {
      this.current = this.newTurn(fragment);
    }
    events.push(...this.emit(this.current));
    return events;
  }
  newTurn(fragment) {
    const turn = {
      ...fragment,
      id: `${this.idPrefix}_${this.nextId}`,
      previousId: null,
      emitted: false,
      canDropAsBackchannel: true
    };
    this.nextId += 1;
    return turn;
  }
  static append(turn, fragment, separate = false) {
    const separator = separate && /[\p{L}\p{N}]$/u.test(turn.text) && /^[\p{L}\p{N}]/u.test(fragment.text) ? " " : "";
    turn.text += separator + fragment.text;
    turn.endMs = Math.max(turn.endMs, fragment.endMs);
  }
  buffer(fragment, canDrop, acknowledgment) {
    if (this.buffered) {
      _TranscriptGrouping.append(this.buffered, fragment);
    } else {
      this.buffered = this.newTurn(fragment);
    }
    if (canDrop !== void 0) {
      this.buffered.canDropAsBackchannel = canDrop;
    }
    this.buffered.acknowledgment = acknowledgment;
  }
  promote() {
    if (!this.buffered) {
      return [];
    }
    const events = this.finishCurrent("speaker_change");
    this.current = this.buffered;
    this.buffered = void 0;
    events.push(...this.emit(this.current));
    return events;
  }
  finishCurrent(reason) {
    const { current } = this;
    this.current = void 0;
    return current ? this.finish(current, reason) : [];
  }
  finish(turn, reason) {
    if (turn.speaker === "assistant") {
      this.lastAssistantEnd = turn.endMs;
    }
    return turn.emitted ? [{ type: "closed", segment: _TranscriptGrouping.snapshot(turn), reason }] : [];
  }
  emit(turn) {
    if (!turn.text) {
      return [];
    }
    if (!turn.emitted) {
      turn.previousId = this.lastId;
      this.lastId = turn.id;
      turn.emitted = true;
    }
    return [{ type: "updated", segment: _TranscriptGrouping.snapshot(turn) }];
  }
  static snapshot(turn) {
    return Object.freeze({
      id: turn.id,
      previousId: turn.previousId,
      speaker: turn.speaker,
      text: turn.text,
      startMs: turn.startMs,
      endMs: turn.endMs
    });
  }
  mightBeBackchannel() {
    return this.current?.speaker === "user" && this.buffered?.speaker === "assistant" && this.buffered.endMs - this.buffered.startMs < this.options.backchannelMaxDurationMs;
  }
  userContinued() {
    return this.mightBeBackchannel() && this.buffered?.canDropAsBackchannel === true && this.current !== void 0 && this.current.endMs > this.buffered.endMs;
  }
  recentAssistant() {
    return this.current !== void 0 && this.buffered !== void 0 && this.lastAssistantEnd !== void 0 && this.buffered.startMs - this.lastAssistantEnd < this.options.backchannelIsolationMs && this.buffered.startMs <= this.current.startMs;
  }
  keepBackchannel(timeMs) {
    return this.mightBeBackchannel() && this.buffered?.canDropAsBackchannel === true && !this.userContinued() && !this.recentAssistant() && timeMs - this.buffered.endMs < this.options.backchannelIsolationMs;
  }
  maybeDropBackchannel(timeMs, next) {
    if (!this.mightBeBackchannel() || !this.buffered) {
      return this.buffered;
    }
    if (this.userContinued()) {
      return void 0;
    }
    if (this.recentAssistant()) {
      return this.buffered;
    }
    if (next && next.startMs - this.buffered.endMs < this.options.backchannelIsolationMs) {
      return this.buffered;
    }
    if (!next && (timeMs === void 0 || timeMs - this.buffered.endMs < this.options.backchannelIsolationMs)) {
      return this.buffered;
    }
    return this.buffered.canDropAsBackchannel ? void 0 : this.buffered;
  }
  acknowledgment(fragment, withinDuration) {
    const previous = this.buffered?.acknowledgment;
    const previousCharacters = previous?.characters ?? 0;
    let characters = previousCharacters;
    const separator = /[\s.,!?;:"'()[\]{}-]/u;
    for (let index = 0; index < fragment.text.length && characters <= this.maxAcknowledgmentLength; index += 1) {
      if (!separator.test(fragment.text.charAt(index))) {
        characters += 1;
      }
    }
    let text;
    if (characters === previousCharacters && previous?.text !== void 0) {
      ({ text } = previous);
    } else if (withinDuration && characters <= this.maxAcknowledgmentLength) {
      text = normalizeAcknowledgment((this.buffered?.text ?? "") + fragment.text);
    }
    return { characters, text };
  }
};

// vendor/openai-node/src/lib/live/transcript-grouper.ts
var SETTLE_MS = 50;
var MAX_TIMEOUT_MS = 2147483647;
var nextGrouperId = 0;
function normalizeTranscript(event) {
  const { event_id: id, delta: text, start_ms: startMs, end_ms: endMs } = event;
  const speaker = event.type === "session.input_transcript.delta" ? "user" : "assistant";
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate streamed transcript identifiers and text before grouping, and probe optional timer capabilities.
    typeof id !== "string" || !id || // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate streamed transcript identifiers and text before grouping, and probe optional timer capabilities.
    typeof text !== "string" || !Number.isSafeInteger(startMs) || startMs < 0 || !Number.isSafeInteger(endMs) || endMs < startMs
  ) {
    throw new OpenAIError(
      "Invalid Live transcript delta: expected an event ID, text, and a nonnegative timed interval"
    );
  }
  return { id, speaker, text, startMs, endMs, receivedAt: performance.now() };
}
function optionsWithDefaults(options) {
  const resolved = {
    minTurnSeparationMs: options.minTurnSeparationMs ?? 500,
    assistantSilenceMs: options.assistantSilenceMs ?? 2e3,
    backchannelMaxDurationMs: options.backchannelMaxDurationMs ?? 1e3,
    backchannelIsolationMs: options.backchannelIsolationMs ?? 2e3
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) {
      throw new OpenAIError(`${name} must be a finite number between 0 and ${MAX_TIMEOUT_MS}`);
    }
  }
  return { ...resolved, additionalAcknowledgments: options.additionalAcknowledgments ?? [] };
}
var TranscriptGrouper = class extends EventEmitter {
  grouping;
  seenIds = /* @__PURE__ */ new Set();
  pending = [];
  timer;
  anchor;
  lastStartMs;
  closed = false;
  dispatching = false;
  updates = [];
  /** Create a grouper with speaker-based defaults. Invalid timing options throw OpenAIError. */
  constructor(options = {}) {
    super();
    this.grouping = new TranscriptGrouping(optionsWithDefaults(options), `segment_${nextGrouperId}`);
    nextGrouperId += 1;
  }
  /**
   * Consume one public Live event. Duplicate transcript event IDs and unrelated
   * event types are ignored. Empty text does not count as speech activity.
   * Malformed transcript fields or use after close() throw OpenAIError.
   */
  push(event) {
    if (this.closed) {
      throw new OpenAIError("Cannot push events after closing the transcript grouper");
    }
    if (event.type === "session.closed") {
      this.finish("session_closed");
      return;
    }
    if (event.type !== "session.input_transcript.delta" && event.type !== "session.output_transcript.delta") {
      return;
    }
    const fragment = normalizeTranscript(event);
    const { id, startMs, endMs, speaker } = fragment;
    if (this.seenIds.has(id)) {
      return;
    }
    this.seenIds.add(id);
    if (!fragment.text) {
      return;
    }
    const updates = [];
    const [pending] = this.pending;
    if (pending && pending.startMs === startMs && pending.endMs === endMs) {
      this.pending.push(fragment);
      if (this.pending.some((part) => part.speaker !== speaker)) {
        updates.push(...this.flushPending());
      }
    } else {
      updates.push(...this.flushPending());
      if (this.grouping.speaker === speaker) {
        updates.push(...this.commit([fragment]));
      } else {
        this.pending.push(fragment);
      }
    }
    this.schedule();
    this.dispatch(updates);
  }
  /**
   * Flush buffered text according to the grouping policy, finalize all emitted
   * segments, and cancel timers. Idempotent; further push() calls fail. Does not
   * close the transport. Invoke before discarding the grouper at session teardown.
   */
  close() {
    this.finish("manual");
  }
  finish(reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimer();
    const updates = this.flushPending();
    updates.push(...this.grouping.close(this.sourceNow(), reason));
    this.seenIds.clear();
    this.dispatch(updates);
  }
  commit(fragments) {
    const [first] = fragments;
    if (!first) {
      return [];
    }
    const updates = [];
    if (this.lastStartMs !== void 0 && first.startMs < this.lastStartMs) {
      updates.push(...this.grouping.close(this.sourceNow(), "timestamp_reset"));
      this.anchor = void 0;
    }
    this.lastStartMs = first.startMs;
    this.anchor = {
      sourceMs: Math.max(this.anchor?.sourceMs ?? 0, first.endMs),
      receivedAt: first.receivedAt
    };
    for (const part of fragments) {
      this.anchor.sourceMs = Math.max(this.anchor.sourceMs, part.endMs);
      this.anchor.receivedAt = Math.max(this.anchor.receivedAt, part.receivedAt);
    }
    updates.push(...this.grouping.process(fragments));
    return updates;
  }
  flushPending() {
    const { pending } = this;
    this.pending = [];
    return this.commit(pending);
  }
  sourceNow() {
    return this.anchor ? this.anchor.sourceMs + Math.max(0, performance.now() - this.anchor.receivedAt) : 0;
  }
  clearTimer() {
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
    }
    this.timer = void 0;
  }
  schedule() {
    this.clearTimer();
    if (this.closed) {
      return;
    }
    const [pending] = this.pending;
    const deadline = this.grouping.deadline();
    let delay;
    if (pending) {
      delay = pending.receivedAt + SETTLE_MS - performance.now();
    } else if (deadline !== void 0) {
      delay = deadline - this.sourceNow();
    }
    if (delay === void 0) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = void 0;
        const updates = this.flushPending();
        updates.push(...this.grouping.advance(this.sourceNow()));
        this.schedule();
        this.dispatch(updates);
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.ceil(delay)))
    );
    const timer = this.timer;
    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate streamed transcript identifiers and text before grouping, and probe optional timer capabilities.
      typeof timer === "object" && timer !== null && "unref" in timer && // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate streamed transcript identifiers and text before grouping, and probe optional timer capabilities.
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  }
  dispatch(updates) {
    this.updates.push(...updates);
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      while (this.updates.length) {
        const update = this.updates.shift();
        if (update?.type === "updated") {
          this._emit("segment.updated", update.segment);
        } else if (update) {
          this._emit("segment.closed", { segment: update.segment, reason: update.reason });
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
};
export {
  TranscriptGrouper
};

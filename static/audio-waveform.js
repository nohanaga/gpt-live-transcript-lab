export const WAVEFORM_INTERVAL_MS = 20;
export const WAVEFORM_CHANNELS = ['input', 'output'];

export class WaveformHistory {
  constructor() {
    this.channels = Object.fromEntries(WAVEFORM_CHANNELS.map((channel) => [channel, { samples: [], dropped: 0 }]));
  }

  append(channel, sample) {
    const history = this.channels[channel];
    if (!history) throw new Error(`Unknown waveform channel: ${channel}`);
    const { start_ms, end_ms, min, max, rms } = sample;
    if (![start_ms, end_ms, min, max, rms].every(Number.isFinite)
      || start_ms < 0 || end_ms <= start_ms || min > max || rms < 0
      || start_ms < (history.samples.at(-1)?.end_ms ?? 0) - 0.01) {
      throw new Error('Invalid or out-of-order waveform envelope.');
    }
    history.samples.push({ start_ms, end_ms, min, max, rms });
  }

  export() {
    return {
      clock: 'local elapsed time; Web Audio clock placement estimated',
      interval_ms: WAVEFORM_INTERVAL_MS, limit_per_channel: null, retention: 'until-reset',
      format: 'min/max/RMS amplitude envelopes, not playable audio',
      channels: this.channels,
    };
  }
}

export function waveformColumns(samples, start, scale, width, count = samples.length) {
  const columns = Array.from({ length: Math.max(0, Math.ceil(width)) }, () => null);
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].end_ms <= start) low = middle + 1;
    else high = middle;
  }
  for (let i = low; i < count; i += 1) {
    const sample = samples[i];
    const left = Math.max(0, Math.floor((sample.start_ms - start) * scale));
    const right = Math.min(columns.length, Math.ceil((sample.end_ms - start) * scale));
    if (left >= columns.length) break;
    for (let x = left; x < right; x += 1) {
      const previous = columns[x];
      columns[x] = previous ? {
        min: Math.min(previous.min, sample.min), max: Math.max(previous.max, sample.max),
        rms: Math.max(previous.rms, sample.rms),
      } : { min: sample.min, max: sample.max, rms: sample.rms };
    }
  }
  return columns;
}

export class LiveWaveformCapture {
  constructor(timeline, {
    onStateChange, onError,
    AudioContext = globalThis.AudioContext, AudioWorkletNode = globalThis.AudioWorkletNode,
  }) {
    if (!AudioContext || !AudioWorkletNode) throw new Error('Web Audio / AudioWorklet is unavailable.');
    this.timeline = timeline;
    this.generation = timeline.generation;
    this.context = new AudioContext();
    this.Node = AudioWorkletNode;
    this.onError = onError;
    this.entries = new Map();
    this.stopped = false;
    this.offset = timeline.now() - this.context.currentTime * 1000;
    this.stateChanged = () => {
      if (this.context.state === 'running') {
        this.offset = Math.max(this.offset, timeline.now() - this.context.currentTime * 1000);
      }
      onStateChange(this.context.state);
    };
    this.context.addEventListener('statechange', this.stateChanged);
    this.ready = this.context.audioWorklet.addModule(new URL('./waveform-processor.js', import.meta.url));
    this.stateChanged();
  }

  resume() { return this.context.resume(); }

  async attach(channel, stream) {
    if (!WAVEFORM_CHANNELS.includes(channel)) throw new Error(`Unknown waveform channel: ${channel}`);
    await this.ready;
    if (this.stopped || this.generation !== this.timeline.generation) return;
    this.disconnect(channel);
    const source = this.context.createMediaStreamSource(stream);
    const processor = new this.Node(this.context, 'transcript-waveform', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { intervalMs: WAVEFORM_INTERVAL_MS },
    });
    const entry = { source, processor };
    this.entries.set(channel, entry);
    processor.port.onmessage = ({ data }) => {
      if (this.stopped || this.entries.get(channel) !== entry || this.generation !== this.timeline.generation) return;
      try {
        this.timeline.waveforms.append(channel, {
          ...data, start_ms: Math.max(0, this.offset + data.start_ms),
          end_ms: this.offset + data.end_ms,
        });
      } catch (error) {
        this.onError(error);
        return;
      }
      this.timeline.version += 1;
    };
    processor.addEventListener('processorerror', () => this.onError(new Error('Audio waveform processor failed.')));
    source.connect(processor);
    // The processor outputs silence, so analysis never echoes the microphone or doubles playback.
    processor.connect(this.context.destination);
  }

  disconnect(channel) {
    const entry = this.entries.get(channel);
    if (!entry) return;
    entry.source.disconnect();
    entry.processor.disconnect();
    entry.processor.port.close();
    this.entries.delete(channel);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.context.removeEventListener('statechange', this.stateChanged);
    for (const channel of this.entries.keys()) this.disconnect(channel);
    await this.context.close();
  }
}

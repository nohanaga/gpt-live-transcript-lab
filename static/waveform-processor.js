class TranscriptWaveformProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.windowFrames = Math.max(1, Math.round(sampleRate * processorOptions.intervalMs / 1000));
    this.clear();
  }

  clear() {
    this.frames = 0;
    this.values = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.squares = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) {
      this.clear();
      return true;
    }
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      if (!this.frames) this.startFrame = currentFrame + frame;
      for (const channel of channels) {
        const sample = channel[frame];
        this.min = Math.min(this.min, sample);
        this.max = Math.max(this.max, sample);
        this.squares += sample * sample;
        this.values += 1;
      }
      this.frames += 1;
      if (this.frames === this.windowFrames) {
        this.port.postMessage({
          start_ms: this.startFrame / sampleRate * 1000,
          end_ms: (currentFrame + frame + 1) / sampleRate * 1000,
          min: this.min, max: this.max, rms: Math.sqrt(this.squares / this.values),
        });
        this.clear();
      }
    }
    return true;
  }
}

registerProcessor('transcript-waveform', TranscriptWaveformProcessor);

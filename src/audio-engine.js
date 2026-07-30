/**
 * Audio → 24 band levels, the way audio visualizers actually do it.
 *
 * The mask's native visualizer wants 24 levels of 0-15 at a steady rate; everything hard is on this
 * side of the wire. Both UIs drive this same engine, so the tuning that took an afternoon to get
 * right exists once.
 *
 * The AudioContext is created once and kept for the engine's lifetime, because
 * createMediaElementSource() binds an element to a context permanently — tearing the context down
 * would make the file source unusable on the next start.
 */
import { SPECTRUM_BANDS, SPECTRUM_MAX, SPECTRUM_HZ } from './mask-protocol.js';

export const DEFAULT_SETTINGS = {
  hz: SPECTRUM_HZ,
  /** dB floor: everything below this reads as zero. The single most useful "sensitivity" control. */
  floorDb: -72,
  /** Dynamic range above the floor that maps onto the 16 available levels. */
  rangeDb: 52,
  /**
   * Pink-noise compensation, dB per octave. Music loses ~4-5 dB per octave, so without this the bass
   * bands sit pinned at max and the treble bands never move.
   */
  tilt: 4.5,
  /** Fall time. Instant attack + slow decay is what makes bars read as punchy rather than mushy. */
  fallMs: 220,
};

export const PRESETS = [
  { name: 'Music', floorDb: -72, rangeDb: 52, tilt: 4.5, fallMs: 220 },
  { name: 'Punchy', floorDb: -60, rangeDb: 35, tilt: 3, fallMs: 120 },
  { name: 'Quiet room', floorDb: -85, rangeDb: 65, tilt: 6, fallMs: 400 },
  { name: 'Speech', floorDb: -70, rangeDb: 45, tilt: 5.5, fallMs: 90 },
];

const MIN_HZ = 40;
const MAX_HZ = 14000;

export class AudioEngine {
  /** @param onFrame called with an array of SPECTRUM_BANDS levels, each 0..SPECTRUM_MAX. */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.settings = { ...DEFAULT_SETTINGS };
    this.running = false;
    this._audio = null;
    this._timer = null;
    this._env = new Float32Array(SPECTRUM_BANDS);
  }

  _ensureAudio() {
    if (!this._audio) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      // 8192 -> ~5.4 Hz bins. At 1024 the bins are 43 Hz wide and the lowest log-spaced bands land
      // on the SAME bin, so they were mathematically incapable of differing from each other.
      analyser.fftSize = 8192;
      // Low, because we run our own attack/decay envelope below; stacking both smears transients.
      analyser.smoothingTimeConstant = 0.35;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      this._audio = {
        ctx, analyser, bins: new Float32Array(analyser.frequencyBinCount),
        micStream: null, micNode: null, fileNode: null,
      };
    }
    return this._audio;
  }

  /** Apply a partial settings patch. A rate change re-arms the timer; everything else is read live. */
  update(patch) {
    const hzChanged = patch.hz !== undefined && patch.hz !== this.settings.hz;
    Object.assign(this.settings, patch);
    if (hzChanged && this.running) this._arm();
  }

  /**
   * @param source 'mic' or 'file'
   * @param element the <audio> element, required for 'file'
   */
  async start(source, element) {
    const a = this._ensureAudio();
    await a.ctx.resume();

    if (source === 'mic') {
      a.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      a.micNode = a.ctx.createMediaStreamSource(a.micStream);
      a.micNode.connect(a.analyser);
      // Deliberately NOT connected to ctx.destination — that would feed the mic back to the
      // speakers and howl.
    } else {
      if (!element?.src) throw new Error('choose an audio file first');
      a.fileNode ??= a.ctx.createMediaElementSource(element);
      a.fileNode.connect(a.analyser);
      a.analyser.connect(a.ctx.destination); // so you can actually hear it
      await element.play();
    }

    this.running = true;
    this._arm();
  }

  stop(element) {
    clearInterval(this._timer);
    this._timer = null;
    const a = this._audio;
    if (a) {
      try { a.analyser.disconnect(); } catch {}
      try { a.micNode?.disconnect(); } catch {}
      try { a.fileNode?.disconnect(); } catch {}
      a.micStream?.getTracks().forEach((t) => t.stop());
      a.micStream = null;
      a.micNode = null;
    }
    element?.pause();
    this.running = false;
    this._env.fill(0);
  }

  _arm() {
    clearInterval(this._timer);
    const period = 1000 / this.settings.hz;
    this._timer = setInterval(() => this._tick(period), period);
  }

  /**
   *   1. log-spaced bands (linear bins would pile everything into the low end)
   *   2. work in dB, not linear amplitude — hearing is logarithmic
   *   3. spectral tilt to undo music's ~4.5 dB/octave rolloff, so treble bands move at all
   *   4. map a dB window onto the 16 available levels, rather than a raw multiply
   *   5. instant attack, exponential decay, frame-rate independent
   */
  _tick(period) {
    const a = this._audio;
    if (!a) return;
    a.analyser.getFloatFrequencyData(a.bins); // dBFS

    const { floorDb, rangeDb, tilt, fallMs } = this.settings;
    const nyquist = a.ctx.sampleRate / 2;
    const maxHz = Math.min(MAX_HZ, nyquist);
    const env = this._env;
    // Frame-rate independent decay: same fall time whether we run at 10 Hz or 50 Hz.
    const decay = Math.exp(-period / Math.max(1, fallMs));

    const out = new Array(SPECTRUM_BANDS).fill(0);
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const lo = MIN_HZ * (maxHz / MIN_HZ) ** (b / SPECTRUM_BANDS);
      const hi = MIN_HZ * (maxHz / MIN_HZ) ** ((b + 1) / SPECTRUM_BANDS);
      const i0 = Math.max(1, Math.floor((lo / nyquist) * a.bins.length));
      const i1 = Math.max(i0 + 1, Math.floor((hi / nyquist) * a.bins.length));

      let peak = -Infinity;
      for (let i = i0; i < i1 && i < a.bins.length; i++) {
        if (a.bins[i] > peak) peak = a.bins[i];
      }
      if (!Number.isFinite(peak)) peak = -160;

      // Tilt is referenced to 200 Hz: bands above it get boosted, below it cut.
      const centerHz = Math.sqrt(lo * hi);
      const tilted = peak + tilt * Math.log2(centerHz / 200);

      let v = (tilted - floorDb) / rangeDb;
      v = v < 0 ? 0 : v > 1 ? 1 : v;

      env[b] = v > env[b] ? v : v + (env[b] - v) * decay;
      out[b] = Math.round(env[b] * SPECTRUM_MAX);
    }

    this.onFrame(out);
  }
}

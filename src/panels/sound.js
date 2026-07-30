/**
 * Sound reactive — the mask's own visualizer, driven from this browser.
 *
 * The phone does the FFT and streams 24 band levels; the mask renders one of five built-in effects.
 * Everything hard about that lives in ../audio-engine.js. What's left here is the choice most people
 * actually want to make: microphone or a file, which effect, and how sensitive.
 *
 * The five effects have no names in any source — they're indices — so they're shown as 1-5 with a
 * "try them" nudge rather than invented labels.
 */
import { html, useState, useRef, useEffect } from 'preact';
import { mask } from '../mask.js';
import { command, SPECTRUM_BANDS, SPECTRUM_MAX, VISUALIZER_EFFECTS } from '../mask-protocol.js';
import { AudioEngine, DEFAULT_SETTINGS, PRESETS } from '../audio-engine.js';
import { Card, Chips, Dial, More } from '../ui-kit.js';

export function SoundPanel() {
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState('mic');
  const [effect, setEffect] = useState(0);
  const [cfg, setCfg] = useState(DEFAULT_SETTINGS);
  const [fileName, setFileName] = useState('');
  const [bands, setBands] = useState(() => new Array(SPECTRUM_BANDS).fill(0));
  const [err, setErr] = useState('');

  const elRef = useRef(null);
  const fileRef = useRef(null);
  const effectRef = useRef(effect);
  effectRef.current = effect;

  const engineRef = useRef(null);
  engineRef.current ??= new AudioEngine((levels) => {
    setBands(levels);
    if (!mask.connected) return;
    mask.sendSpectrum(command.spectrum(levels, effectRef.current)).catch((e) =>
      mask.log('sys', `spectrum: ${e.message}`, null, '', 'error'),
    );
  });

  const set = (patch) => {
    setCfg((prev) => ({ ...prev, ...patch }));
    engineRef.current.update(patch);
  };

  const stop = () => {
    engineRef.current.stop(elRef.current);
    setRunning(false);
    setBands(new Array(SPECTRUM_BANDS).fill(0));
  };

  const start = async () => {
    setErr('');
    try {
      await engineRef.current.start(source, elRef.current);
      setRunning(true);
      if (!mask.connected) setErr('Not connected — the bars move, but nothing reaches the mask.');
    } catch (e) {
      setErr(e.message);
      stop();
    }
  };

  // Stopping on unmount is not optional: the interval and the mic stream both outlive the component.
  useEffect(() => () => engineRef.current.stop(elRef.current), []);

  const pickFile = (file) => {
    if (!file) return;
    const el = elRef.current;
    if (el.src) URL.revokeObjectURL(el.src);
    el.src = URL.createObjectURL(file);
    setFileName(file.name);
    setSource('file');
    setErr('');
  };

  const chooseSource = (next) => {
    if (next === 'file' && !fileName) return fileRef.current?.click();
    if (running) stop();
    setSource(next);
  };

  return html`
    <${Card} className="sound-card">
      <div class=${`viz ${running ? 'live' : ''}`}>
        ${bands.map((v, i) => html`
          <div class="viz-bar" key=${i}>
            <div style=${`height:${Math.max(2, (v / SPECTRUM_MAX) * 100)}%`}></div>
          </div>
        `)}
      </div>

      <div class="sound-actions">
        <button class=${`big ${running ? 'stop' : 'go'}`} onClick=${() => (running ? stop() : start())}>
          ${running ? '■ Stop' : '▶ Start'}
        </button>
        <${Chips}
          options=${[
            { value: 'mic', label: '🎤 Microphone' },
            { value: 'file', label: fileName ? `♪ ${fileName.slice(0, 18)}` : '♪ Audio file…' },
          ]}
          value=${source}
          onPick=${chooseSource}
        />
        ${fileName && html`
          <button class="ghost" onClick=${() => fileRef.current?.click()}>Change file</button>
        `}
      </div>
      <input ref=${fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac"
        hidden onChange=${(e) => pickFile(e.target.files?.[0])} />
      <audio ref=${elRef} controls loop class="player"
        style=${source === 'file' && fileName ? '' : 'display:none'}></audio>

      ${err && html`<p class="banner warn">${err}</p>`}
    <//>

    <${Card} title="Effect" hint="Five renderers built into the mask. They have no names — try them.">
      <${Chips} options=${VISUALIZER_EFFECTS.map((e) => ({ value: e, label: `${e + 1}` }))}
        value=${effect} onPick=${setEffect} />
    <//>

    <${Card} title="Response" hint="If every bar looks the same, raise the treble tilt.">
      <${Chips}
        options=${PRESETS.map((p) => ({ value: p.name, label: p.name }))}
        value=${PRESETS.find((p) => p.floorDb === cfg.floorDb && p.fallMs === cfg.fallMs)?.name}
        onPick=${(name) => {
          const { name: _, ...values } = PRESETS.find((p) => p.name === name);
          set(values);
        }}
      />
      <${Dial} label="Sensitivity" display=${`${cfg.floorDb} dB floor`} value=${-cfg.floorDb}
        setValue=${(v) => set({ floorDb: -v })} min=${40} max=${100} />
      <${Dial} label="Treble tilt" display=${`${cfg.tilt.toFixed(1)} dB/oct`}
        value=${Math.round(cfg.tilt * 2)} setValue=${(v) => set({ tilt: v / 2 })} min=${0} max=${20} />

      <${More} label="Fine tuning">
        <${Dial} label="Contrast" display=${`${cfg.rangeDb} dB window`} value=${cfg.rangeDb}
          setValue=${(v) => set({ rangeDb: v })} min=${15} max=${80} />
        <${Dial} label="Fall time" display=${`${cfg.fallMs} ms`} value=${cfg.fallMs}
          setValue=${(v) => set({ fallMs: v })} min=${30} max=${800} />
        <${Dial} label="Frame rate" display=${`${cfg.hz} Hz`} value=${cfg.hz}
          setValue=${(v) => set({ hz: v })} min=${1} max=${50} />
        <p class="hint">
          The official app streams at 10 Hz; the mask accepts 50. Frames are dropped rather than
          queued if the link can't keep up, so a rate that's too high degrades smoothly.
          Attack is always instant — fall time is how fast bars drop.
        </p>
      <//>
    <//>
  `;
}

/**
 * Shining Mask control + protocol test harness.
 *
 * Prototype. Exposes everything we currently believe works, plus the experiments that would settle
 * the remaining unknowns in ../docs/protocol.md. Every byte in both directions lands in the log.
 */
import { html, render, useState, useEffect, useRef, useCallback } from 'preact';
import { MaskTransport } from './mask-transport.js';
import {
  command,
  MODE,
  TEXT_COLOR_MODE,
  DISPLAY_HEIGHT,
  MAX_INDICES_PER_COMMAND,
  encodeBitmap,
  encodeColors,
  buildUploadPayload,
  buildCommandFrame,
  buildFullColorPayload,
  buildImagePayload,
  DIY_WIDTH,
  DIY_HEIGHT,
  DIY_IMAGE_BYTES,
  SPECTRUM_BANDS,
  SPECTRUM_MAX,
  SPECTRUM_HZ,
  VISUALIZER_EFFECTS,
  encryptEcb,
} from './mask-protocol.js';

const mask = new MaskTransport();

// ---------------------------------------------------------------- helpers

const hexToBytes = (str) => {
  const clean = str.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex needs an even number of digits');
  return Uint8Array.from(clean.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
};

const hexOf = (n) => n.toString(16).padStart(2, '0');

/** Render text to a 16px-high canvas and threshold it into on/off columns. */
function textToColumns(text, { fontSize = 13, font = 'sans-serif', threshold = 100 } = {}) {
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px ${font}`;
  const width = Math.max(1, Math.ceil(ctx.measureText(text).width));

  canvas.width = width;
  canvas.height = DISPLAY_HEIGHT;
  ctx = canvas.getContext('2d'); // resizing resets the context, so re-fetch and re-set the font
  ctx.font = `${fontSize}px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 0, DISPLAY_HEIGHT / 2);

  const { data } = ctx.getImageData(0, 0, width, DISPLAY_HEIGHT);
  const columns = [];
  for (let x = 0; x < width; x++) {
    const column = [];
    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      const i = (y * width + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      column.push(luma * (data[i + 3] / 255) > threshold ? 1 : 0);
    }
    columns.push(column);
  }
  return columns;
}

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const rgbToHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Evenly spaced hues at full saturation. h in [0,360). */
function hslToRgb(h, s = 1, l = 0.5) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * A solid fill: every pixel in every column lit, one RGB per column.
 *
 * `columns` is a guess at the display width — no source states it, and text is variable-width and
 * scrolls. Uploading a solid fill at different widths is itself the cheapest way to find the real
 * number: too narrow and it won't cover the face, too wide and it should scroll.
 */
function solidColorPayload(rgb, columns) {
  const cols = Array.from({ length: columns }, () => Array(DISPLAY_HEIGHT).fill(1));
  return buildUploadPayload(encodeBitmap(cols), encodeColors(cols.map(() => rgb)));
}

// ---------------------------------------------------------------- primitives

const Section = ({ title, note, children }) => html`
  <section>
    <h2>${title}</h2>
    ${note && html`<p class="note">${note}</p>`}
    <div class="body">${children}</div>
  </section>
`;

const Btn = ({ onClick, children, kind = '', disabled }) => {
  const [busy, setBusy] = useState(false);
  return html`<button
    class=${kind}
    disabled=${disabled || busy}
    onClick=${async () => {
      setBusy(true);
      try {
        await onClick();
      } catch (err) {
        mask.log('sys', err.message, null, '', 'error');
      } finally {
        setBusy(false);
      }
    }}
  >
    ${children}
  </button>`;
};

/** Slider + numeric readout, fires on release so we don't flood the GATT queue while dragging. */
const Slider = ({ label, value, setValue, onCommit, min = 0, max = 255 }) => html`
  <label class="row">
    <span class="lbl">${label}</span>
    <input
      type="range"
      min=${min}
      max=${max}
      value=${value}
      onInput=${(e) => setValue(+e.target.value)}
      onChange=${() => onCommit(value)}
    />
    <output>${value}</output>
  </label>
`;

/** Index picker: a spinner for the exact value plus a grid for fast probing. */
const IndexGrid = ({ label, count, onPick, note }) => {
  const [value, setValue] = useState(1);
  return html`
    <div class="stack">
      <label class="row">
        <span class="lbl">${label}</span>
        <input type="number" value=${value} min="0" max="255"
               onInput=${(e) => setValue(+e.target.value)} />
        <${Btn} onClick=${() => onPick(value)}>Send<//>
      </label>
      ${note && html`<p class="note">${note}</p>`}
      <div class="grid">
        ${Array.from({ length: count }, (_, i) => html`
          <button class="tiny" onClick=${() => { setValue(i); onPick(i); }}>${i}</button>
        `)}
      </div>
    </div>
  `;
};

// ---------------------------------------------------------------- panels

function Connection({ status }) {
  const connected = status.state === 'connected';
  return html`
    <${Section}
      title="Connection"
      note=${'Filtered on namePrefix MASK + service 0xfff0. The mask connects unbonded — no OS pairing.'}
    >
      <div class="row wrap">
        <${Btn} kind="primary" disabled=${connected}
          onClick=${() => mask.requestAndConnect()}>Connect<//>
        <${Btn} disabled=${connected} onClick=${() => mask.requestAndConnect({ acceptAll: true })}>
          Scan all devices
        <//>
        <${Btn} disabled=${!mask.device || connected} onClick=${() => mask.connect()}>
          Reconnect
        <//>
        <${Btn} disabled=${!connected} onClick=${() => mask.disconnect()}>Disconnect<//>
      </div>
      <p class="status ${status.state}">
        <b>${status.state}</b>${status.message ? ` — ${status.message}` : ''}
      </p>
      ${!navigator.bluetooth &&
        html`<p class="warn">
          Web Bluetooth is unavailable here. Needs Chrome (desktop or Android) over HTTPS — Safari and
          iOS cannot do this at all.
        </p>`}
    <//>
  `;
}

function BuiltIn() {
  return html`
    <${Section} title="Built-in images & animations"
      note="IMAG / ANIM select the mask's factory content. Both declare len=5 (settled from official-app captures).">
      <${IndexGrid} label="IMAG index" count=${20}
        onPick=${(i) => mask.sendCommand(command.image(i), `IMAG ${i}`)} />
      <hr />
      <${IndexGrid} label="ANIM index" count=${20}
        onPick=${(i) => mask.sendCommand(command.animation(i), `ANIM ${i}`)} />
    <//>
  `;
}

function DiySlots() {
  const [seq, setSeq] = useState('1,2,3');
  return html`
    <${Section} title="DIY slots (PLAY)"
      note=${`PLAY only SELECTS a slot — nothing in the known protocol writes one. Slots are probably
              populated by the official app. shining-mask assumes 20.`}>
      <${IndexGrid} label="PLAY slot" count=${21}
        onPick=${(i) => mask.sendCommand(command.play(i), `PLAY ${i}`)} />
      <hr />
      <label class="row">
        <span class="lbl">Sequence</span>
        <input value=${seq} onInput=${(e) => setSeq(e.target.value)} />
        <${Btn} onClick=${() => {
          const idx = seq.split(',').map((s) => +s.trim()).filter((n) => !Number.isNaN(n));
          return mask.sendCommand(command.playSequence(idx), `PLAY seq ${idx.join(',')}`);
        }}>Send<//>
      </label>
      <p class="note">
        Unverified — every known implementation sends a count of exactly 1. Max
        ${MAX_INDICES_PER_COMMAND} indices (single 16-byte command block).
      </p>
    <//>
  `;
}

function Appearance() {
  const [light, setLight] = useState(150);
  const [speed, setSpeed] = useState(50);
  const [fg, setFg] = useState('#ff0000');
  const [bg, setBg] = useState('#000000');
  const [colorMode, setColorMode] = useState(0);

  return html`
    <${Section} title="Appearance">
      <${Slider} label="Brightness (LIGHT)" value=${light} setValue=${setLight}
        onCommit=${(v) => mask.sendCommand(command.brightness(v), `LIGHT ${v}`)} />
      <${Slider} label="Speed (SPEED)" value=${speed} setValue=${setSpeed}
        onCommit=${(v) => mask.sendCommand(command.speed(v), `SPEED ${v}`)} />

      <div class="row wrap">
        <span class="lbl">Scroll mode (MODE)</span>
        ${Object.entries(MODE).map(([name, v]) => html`
          <${Btn} onClick=${() => mask.sendCommand(command.mode(v), `MODE ${name}`)}>${name}<//>
        `)}
      </div>

      <label class="row">
        <span class="lbl">Text foreground (FC)</span>
        <input type="color" value=${fg} onInput=${(e) => setFg(e.target.value)} />
        <${Btn} onClick=${() => mask.sendCommand(command.foregroundColor(...hexToRgb(fg)), `FC ${fg}`)}>
          Send
        <//>
      </label>
      <label class="row">
        <span class="lbl">Text background (BC)</span>
        <input type="color" value=${bg} onInput=${(e) => setBg(e.target.value)} />
        <${Btn} onClick=${() => mask.sendCommand(command.backgroundColor(...hexToRgb(bg)), `BC ${bg}`)}>
          Send
        <//>
      </label>

      <label class="row">
        <span class="lbl">Text color mode (M)</span>
        <select onChange=${(e) => setColorMode(+e.target.value)}>
          ${Object.entries(TEXT_COLOR_MODE).map(([name, v]) =>
            html`<option value=${v}>${v} — ${name}</option>`)}
        </select>
        <${Btn} onClick=${() => mask.sendCommand(command.textColorMode(colorMode), `M ${colorMode}`)}>
          Send
        <//>
      </label>
    <//>
  `;
}

function Upload() {
  const [text, setText] = useState('HELLO');
  const [color, setColor] = useState('#ffffff');
  const [progress, setProgress] = useState('');
  const canvasRef = useRef(null);

  const columns = textToColumns(text || ' ');

  // Preview: scale the 16px-high bitmap up so it's actually legible.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = 6;
    canvas.width = Math.max(1, columns.length * scale);
    canvas.height = DISPLAY_HEIGHT * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    columns.forEach((col, x) =>
      col.forEach((on, y) => on && ctx.fillRect(x * scale, y * scale, scale - 1, scale - 1)),
    );
  }, [text, color]);

  const doUpload = async () => {
    const bitmap = encodeBitmap(columns);
    const colors = encodeColors(columns.map(() => hexToRgb(color)));
    const { payload, bitmapLength } = buildUploadPayload(bitmap, colors);
    setProgress(`uploading ${payload.length} bytes…`);
    const packets = await mask.upload(payload, bitmapLength, {
      onProgress: (n, resp) => setProgress(`packet ${n} — ${resp}`),
    });
    setProgress(`done, ${packets} packets`);
  };

  return html`
    <${Section} title="Upload a bitmap"
      note=${`Text is rendered on a canvas, thresholded to 1 bit, and given one RGB per column — that
              per-column color is a hard protocol constraint, not a simplification.`}>
      <label class="row">
        <span class="lbl">Text</span>
        <input value=${text} onInput=${(e) => setText(e.target.value)} />
        <input type="color" value=${color} onInput=${(e) => setColor(e.target.value)} />
      </label>
      <canvas ref=${canvasRef} class="preview"></canvas>
      <p class="note">
        ${columns.length} columns → ${columns.length * 2} bytes bitmap + ${columns.length * 3} bytes
        color = ${columns.length * 5} bytes total
      </p>
      <div class="row wrap">
        <${Btn} kind="primary" onClick=${doUpload}>Upload (DATS → REOK → DATCP)<//>
        <${Btn} onClick=${async () => {
          // mask-go's captured known-good "text2" payload. If our own encoding fails but this
          // works, the bug is in our encoder, not the transport.
          const bitmap = hexToBytes(
            '020002003ff83ffc020402040000000000f001f8034c0244034401cc00c80000018803cc0244026402240' +
            '33c01180000020002003ff83ffc0204020400000000');
          const colors = hexToBytes('fffffc'.repeat(32));
          const { payload, bitmapLength } = buildUploadPayload(bitmap, colors);
          setProgress('uploading mask-go capture…');
          const n = await mask.upload(payload, bitmapLength, {
            onProgress: (i, r) => setProgress(`packet ${i} — ${r}`),
          });
          setProgress(`done, ${n} packets`);
        }}>Upload mask-go's known-good capture<//>
      </div>
      ${progress && html`<p class="status">${progress}</p>`}
    <//>
  `;
}

/**
 * Colour control.
 *
 * Hardware findings, 2026-07-30, that shape this panel:
 *  - Upload writes the LIVE display buffer, not a PLAY-addressable DIY slot. 20 uploads followed by
 *    PLAY 1..3 still showed the pre-existing official-app DIY images.
 *  - An uploaded bitmap renders, but its per-column RGB is IGNORED — a red fill came out white.
 *    Consistent with the fact that no known implementation ever uploaded a non-white colour array:
 *    mask-go hardcodes 0xFFFFFF, and the official-app capture is 0xFFFFFC.
 *  - So colour most likely comes from FC/BC, gated by their `enable` byte.
 *
 * Which gives a much better architecture than per-pick upload: prime the shape once (slow), then
 * recolour with a single 16-byte command (fast enough for the visualizer).
 */
function ColorBank() {
  const [count, setCount] = useState(20);
  const [width, setWidth] = useState(46); // measured on real hardware
  const [enable, setEnable] = useState(1);
  const [status, setStatus] = useState('');
  const [active, setActive] = useState(null);
  const [lastMs, setLastMs] = useState(null);

  const palette = Array.from({ length: count }, (_, i) => ({
    i,
    hex: rgbToHex(hslToRgb((i * 360) / count)),
  }));

  const timed = async (label, fn) => {
    const t0 = performance.now();
    await fn();
    const ms = Math.round(performance.now() - t0);
    setLastMs(ms);
    setStatus(`${label} — ${ms}ms`);
  };

  /** Upload a full-width, fully-lit white rectangle: the canvas that FC then recolours. */
  const primeCanvas = () =>
    timed(`primed ${width}-column canvas`, async () => {
      await mask.sendCommand(command.mode(MODE.steady), 'MODE steady');
      const { payload, bitmapLength } = solidColorPayload([255, 255, 255], width);
      await mask.upload(payload, bitmapLength);
    });

  const pickFC = (entry) => {
    setActive(entry.i);
    const [r, g, b] = hexToRgb(entry.hex);
    return timed(`FC ${entry.hex}`, () =>
      mask.sendCommand(command.foregroundColor(r, g, b, enable), `FC ${entry.hex} en=${enable}`),
    );
  };

  const pickUpload = (entry) => {
    setActive(entry.i);
    return timed(`upload ${entry.hex}`, async () => {
      const { payload, bitmapLength } = solidColorPayload(hexToRgb(entry.hex), width);
      await mask.upload(payload, bitmapLength);
    });
  };

  return html`
    <${Section} title="Color"
      note=${`Upload writes the live display, not a DIY slot — confirmed on hardware. And an uploaded
              per-column RGB is ignored, so colour has to come from FC. Prime the shape once, then
              recolour with one command.`}>
      <div class="row wrap">
        <label class="row"><span class="lbl">Colors</span>
          <input type="number" min="1" max="64" value=${count}
            onInput=${(e) => setCount(Math.max(1, +e.target.value))} /></label>
        <label class="row"><span class="lbl">Canvas width</span>
          <input type="number" min="1" max="255" value=${width}
            onInput=${(e) => setWidth(Math.max(1, +e.target.value))} /></label>
      </div>

      <div class="row wrap">
        <${Btn} kind="primary" onClick=${primeCanvas}>1. Prime ${width}-col white canvas<//>
        <${Btn} onClick=${() => mask.sendCommand(command.textColorMode(0, 0), 'M enable=0')}>
          Clear color mode (M en=0)
        <//>
      </div>
      <p class="note">
        46 columns measured on hardware — a 32-column upload rendered as a partial rectangle.
      </p>

      <hr />
      <h3 class="sub">2. Pick a color — one FC command</h3>
      <label class="row">
        <span class="lbl">FC enable byte</span>
        <button class=${enable === 1 ? 'primary' : ''} onClick=${() => setEnable(1)}>1</button>
        <button class=${enable === 0 ? 'primary' : ''} onClick=${() => setEnable(0)}>0</button>
        <span class="note">
          The official app sends 0. If 1 does nothing, try 0 — this byte is the whole hypothesis.
        </span>
      </label>
      <div class="swatches pickable">
        ${palette.map((entry) => html`
          <button class=${`swatch ${active === entry.i ? 'active' : ''}`}
            style=${`background:${entry.hex}`} title=${entry.hex}
            onClick=${() => pickFC(entry)}></button>
        `)}
      </div>
      ${lastMs !== null && html`<p class="status">${status}</p>`}
      <p class="note">
        If FC works, this is the visualizer's colour axis: ~30ms per change, so 24 Hz is comfortable.
      </p>

      <hr />
      <h3 class="sub">Fallback — one full upload per pick (~300ms)</h3>
      <div class="swatches pickable">
        ${palette.map((entry) => html`
          <button class="swatch" style=${`background:${entry.hex}`} title=${entry.hex}
            onClick=${() => pickUpload(entry)}></button>
        `)}
      </div>
      <p class="note">
        Uses the per-column RGB, which hardware says is ignored — kept so the two are easy to compare
        side by side. Measured ~300-350ms per upload from your logs.
      </p>
    <//>
  `;
}

/**
 * Upload lab — probes the two open questions:
 *
 *   1. Can we write a persistent DIY slot?
 *   2. Can we address color per pixel (not per column)?
 *
 * Both may hinge on the same byte. DATS's 5th arg is unexplained in every source (all send 0), which
 * makes it the obvious candidate for selecting an upload destination or format. And the original
 * reddit notes described the payload as "raw RGB, 3 bytes per pixel" — a full-color format that
 * mask-go's per-column text format cannot express, yet the official app's DIY images clearly are full
 * color. So both formats are probably real, for different paths.
 *
 * The test pattern varies hue horizontally AND brightness vertically. The vertical variation is the
 * tell: per-column color physically cannot produce it, so if we see it, full-color works.
 */
/**
 * Full-colour DIY image upload — the path decoded from a capture of the official app.
 *
 *   DATS [total:2][slot:2][0x01]  ->  DATSOK
 *   packets                       ->  REOK each
 *   DATCP [unixTimestamp:4]       ->  DATCPOK
 *
 * Payload is raw RGB, 3 bytes per pixel, 46 x 58 = 8004 bytes. Unlike the text path this writes a
 * PERSISTENT slot, addressable afterwards with PLAY.
 */
/**
 * Sound visualizer — the official app's own protocol, decoded from a capture.
 *
 * The phone does the FFT and streams 24 band levels to the …960b characteristic; the mask renders one
 * of 5 built-in effects. Frame is [0x0f][effect][12 bytes = 24 nibbles][00 00], fire-and-forget.
 *
 * Audio comes from the microphone or a local file. The AudioContext is created once and kept for the
 * component's lifetime, because createMediaElementSource() binds an element to a context permanently
 * — tearing the context down would make the file source unusable on the next start.
 */
function Visualizer() {
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState('mic');
  const [effect, setEffect] = useState(0);
  const [hz, setHz] = useState(SPECTRUM_HZ);
  // dB floor: everything below this reads as zero. The single most useful "sensitivity" control.
  const [floorDb, setFloorDb] = useState(-72);
  // Dynamic range above the floor that maps onto the 16 available levels.
  const [rangeDb, setRangeDb] = useState(52);
  // Pink-noise compensation. Music loses ~4-5 dB per octave, so without this the bass bands sit
  // pinned at max and the treble bands never move.
  const [tilt, setTilt] = useState(4.5);
  // Fall time. Instant attack + slow decay is what makes bars read as punchy rather than mushy.
  const [fallMs, setFallMs] = useState(220);
  const [fileName, setFileName] = useState('');
  const [bands, setBands] = useState(() => new Array(SPECTRUM_BANDS).fill(0));
  const [err, setErr] = useState('');

  const audioRef = useRef(null); // {ctx, analyser, bins, micStream, micNode, fileNode}
  const timerRef = useRef(null);
  const elRef = useRef(null); // <audio> for file playback
  const fileInputRef = useRef(null);
  const envRef = useRef(new Float32Array(SPECTRUM_BANDS));
  const live = useRef({});
  live.current = { effect, hz, floorDb, rangeDb, tilt, fallMs };

  const ensureAudio = () => {
    if (!audioRef.current) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      // 8192 -> ~5.4 Hz bins. At 1024 the bins are 43 Hz wide and the lowest log-spaced bands land on
      // the SAME bin, so they were mathematically incapable of differing from each other.
      analyser.fftSize = 8192;
      // Low, because we run our own attack/decay envelope below; stacking both smears transients.
      analyser.smoothingTimeConstant = 0.35;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      audioRef.current = {
        ctx, analyser, bins: new Float32Array(analyser.frequencyBinCount),
        micStream: null, micNode: null, fileNode: null,
      };
    }
    return audioRef.current;
  };

  const stop = () => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    const a = audioRef.current;
    if (a) {
      try { a.analyser.disconnect(); } catch {}
      try { a.micNode?.disconnect(); } catch {}
      try { a.fileNode?.disconnect(); } catch {}
      a.micStream?.getTracks().forEach((t) => t.stop());
      a.micStream = null;
      a.micNode = null;
    }
    elRef.current?.pause();
    if (running) mask.log('sys', 'visualizer stopped');
    setRunning(false);
    setBands(new Array(SPECTRUM_BANDS).fill(0));
  };

  const start = async () => {
    setErr('');
    try {
      const a = ensureAudio();
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
        const el = elRef.current;
        if (!el?.src) throw new Error('choose an audio file first');
        a.fileNode ??= a.ctx.createMediaElementSource(el);
        a.fileNode.connect(a.analyser);
        a.analyser.connect(a.ctx.destination); // so you can actually hear it
        await el.play();
      }

      setRunning(true);
      mask.log('sys', `visualizer started: ${source}, ${live.current.hz}Hz, effect ${live.current.effect}`,
        null, '', 'ok');
      if (!mask.connected) {
        mask.log('sys', 'not connected — bars will move but nothing is sent', null, '', 'warn');
      }
      tick();
    } catch (e) {
      setErr(e.message);
      stop();
    }
  };

  /**
   * Turn the FFT into 24 bar levels the way audio visualizers actually do it:
   *
   *   1. log-spaced bands (linear bins would pile everything into the low end)
   *   2. work in dB, not linear amplitude — hearing is logarithmic
   *   3. spectral tilt to undo music's ~4.5 dB/octave rolloff, so treble bands move at all
   *   4. map a dB window onto the 16 available levels, rather than a raw multiply
   *   5. instant attack, exponential decay, frame-rate independent
   */
  const tick = () => {
    clearInterval(timerRef.current);
    const period = 1000 / live.current.hz;
    timerRef.current = setInterval(async () => {
      const a = audioRef.current;
      if (!a) return;
      a.analyser.getFloatFrequencyData(a.bins); // dBFS

      const { floorDb: fl, rangeDb: rg, tilt: tl, fallMs: fm } = live.current;
      const nyquist = a.ctx.sampleRate / 2;
      const minHz = 40;
      const maxHz = Math.min(14000, nyquist);
      const env = envRef.current;
      // Frame-rate independent decay: same fall time whether we run at 10 Hz or 50 Hz.
      const decay = Math.exp(-period / Math.max(1, fm));

      const out = new Array(SPECTRUM_BANDS).fill(0);
      for (let b = 0; b < SPECTRUM_BANDS; b++) {
        const lo = minHz * (maxHz / minHz) ** (b / SPECTRUM_BANDS);
        const hi = minHz * (maxHz / minHz) ** ((b + 1) / SPECTRUM_BANDS);
        const i0 = Math.max(1, Math.floor((lo / nyquist) * a.bins.length));
        const i1 = Math.max(i0 + 1, Math.floor((hi / nyquist) * a.bins.length));

        let peak = -Infinity;
        for (let i = i0; i < i1 && i < a.bins.length; i++) {
          if (a.bins[i] > peak) peak = a.bins[i];
        }
        if (!Number.isFinite(peak)) peak = -160;

        // Tilt is referenced to 200 Hz: bands above it get boosted, below it cut.
        const centerHz = Math.sqrt(lo * hi);
        const tilted = peak + tl * Math.log2(centerHz / 200);

        let v = (tilted - fl) / rg;
        v = v < 0 ? 0 : v > 1 ? 1 : v;

        env[b] = v > env[b] ? v : v + (env[b] - v) * decay;
        out[b] = Math.round(env[b] * SPECTRUM_MAX);
      }

      setBands(out);
      if (mask.connected) {
        try {
          await mask.sendSpectrum(command.spectrum(out, live.current.effect));
        } catch (e) {
          mask.log('sys', `spectrum: ${e.message}`, null, '', 'error');
        }
      }
    }, period);
  };

  useEffect(() => { if (running) tick(); }, [hz]);
  useEffect(() => stop, []);

  const pickFile = (file) => {
    if (!file) return;
    const el = elRef.current;
    if (el.src) URL.revokeObjectURL(el.src);
    el.src = URL.createObjectURL(file);
    setFileName(file.name);
    setSource('file');
  };

  return html`
    <${Section} title="Sound visualizer — native"
      note=${`The official app's own protocol: it runs the FFT and streams ${SPECTRUM_BANDS} band levels
              (0-${SPECTRUM_MAX}) to the undocumented …960b characteristic; the mask renders. Frame is
              [0x0f][effect][12 bytes of nibbles][00 00], fire-and-forget.`}>
      <div class="bars">
        ${bands.map((v) => html`
          <div class="bar"><div style=${`height:${(v / SPECTRUM_MAX) * 100}%`}></div></div>
        `)}
      </div>

      <div class="row wrap">
        <span class="lbl">Audio source</span>
        <button class=${source === 'mic' ? 'primary' : ''}
          onClick=${() => { if (running) stop(); setSource('mic'); }}>microphone</button>
        <button class=${source === 'file' ? 'primary' : ''}
          onClick=${() => {
            // Switch back to an already-loaded file rather than forcing a re-pick.
            if (fileName && source !== 'file') { if (running) stop(); setSource('file'); }
            else fileInputRef.current?.click();
          }}>
          ${fileName ? `file: ${fileName.slice(0, 24)}` : 'audio file…'}
        </button>
        ${fileName && html`<button onClick=${() => fileInputRef.current?.click()}>change…</button>`}
        <input ref=${fileInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac"
          style="display:none" onChange=${(e) => pickFile(e.target.files?.[0])} />
      </div>
      <audio ref=${elRef} controls loop class="player"
        style=${source === 'file' && fileName ? '' : 'display:none'}></audio>

      <div class="row wrap">
        <${Btn} kind=${running ? '' : 'primary'} onClick=${() => (running ? stop() : start())}>
          ${running ? 'Stop' : `Start (${source})`}
        <//>
        <span class="lbl">Effect</span>
        ${VISUALIZER_EFFECTS.map((e) => html`
          <button class=${effect === e ? 'primary' : ''} onClick=${() => setEffect(e)}>${e}</button>
        `)}
      </div>

      <${Slider} label=${`Rate (${hz} Hz)`} value=${hz} setValue=${setHz}
        onCommit=${() => {}} min=${1} max=${50} />
      <${Slider} label=${`Sensitivity (floor ${floorDb} dB)`} value=${-floorDb}
        setValue=${(v) => setFloorDb(-v)} onCommit=${() => {}} min=${40} max=${100} />
      <${Slider} label=${`Contrast (range ${rangeDb} dB)`} value=${rangeDb}
        setValue=${setRangeDb} onCommit=${() => {}} min=${15} max=${80} />
      <${Slider} label=${`Treble tilt (${tilt.toFixed(1)} dB/oct)`} value=${Math.round(tilt * 2)}
        setValue=${(v) => setTilt(v / 2)} onCommit=${() => {}} min=${0} max=${20} />
      <${Slider} label=${`Fall time (${fallMs} ms)`} value=${fallMs}
        setValue=${setFallMs} onCommit=${() => {}} min=${30} max=${800} />
      <div class="row wrap">
        <span class="lbl">Presets</span>
        <button onClick=${() => { setFloorDb(-72); setRangeDb(52); setTilt(4.5); setFallMs(220); }}>
          music
        </button>
        <button onClick=${() => { setFloorDb(-60); setRangeDb(35); setTilt(3); setFallMs(120); }}>
          punchy
        </button>
        <button onClick=${() => { setFloorDb(-85); setRangeDb(65); setTilt(6); setFallMs(400); }}>
          quiet room
        </button>
        <button onClick=${() => { setFloorDb(-70); setRangeDb(45); setTilt(5.5); setFallMs(90); }}>
          speech
        </button>
      </div>

      ${err && html`<p class="warn">${err}</p>`}
      <p class="note">
        The official app streams at ${SPECTRUM_HZ} Hz. Higher rates are unexplored territory — frames
        are dropped rather than queued if the link can't keep up, and the log's <code>spectrum N/s</code>
        heartbeat reports the rate actually achieved plus any drops, so you can find the real ceiling.
      </p>
      <p class="note">
        <b>Sensitivity</b> sets the noise floor — raise it until idle bars sit at zero.
        <b>Contrast</b> is the dB window mapped onto the mask's 16 levels; narrower = more dramatic.
        <b>Treble tilt</b> undoes music's natural rolloff, so the high bands actually move — this is
        usually the control that fixes "all the bars look the same".
        <b>Fall time</b> is how fast bars drop; attack is always instant.
      </p>
      <p class="note">
        8192-point FFT (~5.4 Hz bins), log-spaced 40 Hz - 14 kHz. At 1024 the bins were 43 Hz wide and
        the lowest bands shared the same bin, so they could not differ from one another no matter what.
        Playing a file routes audio to your speakers too; the microphone path deliberately does not.
      </p>
    <//>
  `;
}

function DiyImage() {
  const [slot, setSlot] = useState(5);
  const [rowMajor, setRowMajor] = useState(true);
  const [source, setSource] = useState('gradient');
  const [progress, setProgress] = useState('');
  const [pixels, setPixels] = useState(null); // Uint8ClampedArray RGBA, DIY_WIDTH x DIY_HEIGHT
  const canvasRef = useRef(null);
  const fileRef = useRef(null);

  const patternAt = (x, y) => {
    if (source === 'gradient')
      return hslToRgb((x / (DIY_WIDTH - 1)) * 330, 1, 0.15 + 0.7 * (y / (DIY_HEIGHT - 1)));
    if (source === 'quadrants')
      return x < DIY_WIDTH / 2
        ? (y < DIY_HEIGHT / 2 ? [255, 0, 0] : [0, 255, 0])
        : (y < DIY_HEIGHT / 2 ? [0, 0, 255] : [255, 255, 0]);
    // 'corner': a single bright marker top-left, everything else dim. Settles pixel order.
    return x < 6 && y < 6 ? [255, 0, 0] : [8, 8, 8];
  };

  const colorAt = (x, y) => {
    if (!pixels) return patternAt(x, y);
    const i = (y * DIY_WIDTH + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = 5;
    c.width = DIY_WIDTH * scale;
    c.height = DIY_HEIGHT * scale;
    const ctx = c.getContext('2d');
    for (let y = 0; y < DIY_HEIGHT; y++)
      for (let x = 0; x < DIY_WIDTH; x++) {
        ctx.fillStyle = rgbToHex(colorAt(x, y));
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
  }, [source, pixels]);

  const loadFile = (file) => {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      // Cover-fit into 46x58, then read back the downscaled pixels.
      const c = document.createElement('canvas');
      c.width = DIY_WIDTH;
      c.height = DIY_HEIGHT;
      const ctx = c.getContext('2d');
      const scale = Math.max(DIY_WIDTH / img.width, DIY_HEIGHT / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (DIY_WIDTH - w) / 2, (DIY_HEIGHT - h) / 2, w, h);
      setPixels(ctx.getImageData(0, 0, DIY_WIDTH, DIY_HEIGHT).data);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  const upload = async () => {
    const payload = buildImagePayload(colorAt, { rowMajor });
    setProgress(`uploading ${payload.length}B to slot ${slot}…`);
    const t0 = performance.now();
    await mask.uploadImage(payload, slot, {
      onProgress: (n) => setProgress(`packet ${n}/${Math.ceil(payload.length / 98)}`),
    });
    setProgress(`done in ${Math.round(performance.now() - t0)}ms — now send PLAY ${slot}`);
    await new Promise((r) => setTimeout(r, 300));
    await mask.sendCommand(command.play(slot), `PLAY ${slot}`);
  };

  return html`
    <${Section} title="DIY image — full color, persistent"
      note=${`Decoded from a capture of the official app. Raw RGB, 3 bytes per pixel, ${DIY_WIDTH}x${DIY_HEIGHT}
              = ${DIY_IMAGE_BYTES} bytes, written to a persistent slot you can recall with PLAY.`}>
      <canvas ref=${canvasRef} class="preview"></canvas>

      <div class="row wrap">
        <span class="lbl">Source</span>
        ${[['gradient', 'gradient'], ['quadrants', 'quadrants'], ['corner', 'corner marker']].map(
          ([key, label]) => html`
            <button class=${source === key && !pixels ? 'primary' : ''}
              onClick=${() => { setPixels(null); setSource(key); }}>${label}</button>
          `,
        )}
        <button class=${pixels ? 'primary' : ''} onClick=${() => fileRef.current?.click()}>
          image file…
        </button>
        <input ref=${fileRef} type="file" accept="image/*" style="display:none"
          onChange=${(e) => loadFile(e.target.files?.[0])} />
      </div>

      <div class="row wrap">
        <label class="row"><span class="lbl">Slot</span>
          <input type="number" min="0" max="255" value=${slot}
            onInput=${(e) => setSlot(+e.target.value)} /></label>
        <span class="lbl">Pixel order</span>
        <button class=${rowMajor ? 'primary' : ''} onClick=${() => setRowMajor(true)}>row-major</button>
        <button class=${!rowMajor ? 'primary' : ''} onClick=${() => setRowMajor(false)}>column-major</button>
      </div>
      <p class="note">
        Pixel order isn't pinned down yet — the two captured images differed everywhere, so there was
        no single-pixel diff to read it from. Use <b>corner marker</b>: if the red square lands
        top-left, this order is right; if it smears into a stripe, switch.
      </p>

      <div class="row wrap">
        <${Btn} kind="primary" onClick=${upload}>
          Upload ${DIY_IMAGE_BYTES}B to slot ${slot}, then PLAY
        <//>
      </div>
      ${progress && html`<p class="status">${progress}</p>`}
      <p class="note">
        ~82 packets, so expect a couple of seconds. This overwrites whatever is in slot ${slot}.
      </p>
    <//>
  `;
}

function UploadLab() {
  const [width, setWidth] = useState(46);
  const [trailing, setTrailing] = useState(0);
  const [format, setFormat] = useState('percolumn');
  const [columnMajor, setColumnMajor] = useState(true);
  const [bitmapLenMode, setBitmapLenMode] = useState('full');
  const [releaseOverride, setReleaseOverride] = useState(true);
  const [pattern, setPattern] = useState('diagonal');
  const [result, setResult] = useState('');
  const canvasRef = useRef(null);

  const colorAt = (x, y) => {
    const hue = (x / Math.max(1, width - 1)) * 330;
    const light = 0.15 + 0.7 * (y / (DISPLAY_HEIGHT - 1)); // vertical ramp = the decisive signal
    return hslToRgb(hue, 1, light);
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = 8;
    c.width = width * scale; c.height = DISPLAY_HEIGHT * scale;
    const ctx = c.getContext('2d');
    for (let x = 0; x < width; x++)
      for (let y = 0; y < DISPLAY_HEIGHT; y++) {
        ctx.fillStyle = rgbToHex(colorAt(x, y));
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
  }, [width]);

  const build = () => {
    if (format === 'fullcolor') {
      const payload = buildFullColorPayload(width, colorAt, columnMajor);
      const bitmapLength = bitmapLenMode === 'zero' ? 0 : payload.length;
      return { payload, bitmapLength };
    }
    // Per-column format. Colour can only vary horizontally, but the BITMAP can vary vertically,
    // which is what maps the display's real vertical extent.
    const cols = Array.from({ length: width }, (_, x) =>
      Array.from({ length: DISPLAY_HEIGHT }, (_, y) => {
        if (pattern === 'solid') return 1;
        // 'diagonal': each column lights exactly one row, stepping down and wrapping every 16
        // columns. Reveals how many rows physically exist and in what order.
        if (pattern === 'diagonal') return y === x % DISPLAY_HEIGHT ? 1 : 0;
        // 'edges': top row, bottom row and the two middle rows only.
        return y === 0 || y === DISPLAY_HEIGHT - 1 || y === 7 || y === 8 ? 1 : 0;
      }),
    );
    const bitmap = encodeBitmap(cols);
    const colors = encodeColors(cols.map((_, x) => colorAt(x, DISPLAY_HEIGHT - 1)));
    return buildUploadPayload(bitmap, colors);
  };

  const send = async (t = trailing) => {
    if (releaseOverride) {
      // FC enable=0 may mean "use the content's own colours" rather than "off" — the official app
      // always sends 0. If so, this is why an uploaded colour previously rendered white.
      await mask.sendCommand(command.foregroundColor(255, 255, 255, 0), 'FC enable=0 (release)');
      await new Promise((r) => setTimeout(r, 120));
    }
    const { payload, bitmapLength } = build();
    setResult(`sending ${payload.length}B, bitmapLen=${bitmapLength}, DATS[5]=${t}…`);
    await mask.upload(payload, bitmapLength, { trailing: t });
    setResult(`sent ${payload.length}B (${Math.ceil(payload.length / 98)} pkts), DATS[5]=${t} — ` +
      `look for VERTICAL color variation; per-column colour cannot do that.`);
  };

  const sweepTrailing = async () => {
    for (let t = 0; t <= 20; t++) {
      setResult(`DATS[5]=${t} — watch the mask, then check PLAY ${t}`);
      setTrailing(t);
      try { await send(t); } catch (err) { mask.log('sys', `DATS[5]=${t}: ${err.message}`, null, '', 'error'); }
      await new Promise((r) => setTimeout(r, 900));
    }
    setResult('sweep done. Now sweep PLAY 1→30 in Experiments: did any slot gain a gradient?');
  };

  const { payload, bitmapLength } = build();

  return html`
    <${Section} title="Upload lab — full color & slot writing"
      note=${`Probes whether per-pixel color and DIY-slot writing are reachable. The pattern below
              varies hue horizontally AND brightness vertically; the vertical part is decisive, since
              per-column color cannot produce it.`}>
      <canvas ref=${canvasRef} class="preview"></canvas>

      <div class="row wrap">
        <label class="row"><span class="lbl">Width</span>
          <input type="number" min="1" max="255" value=${width}
            onInput=${(e) => setWidth(Math.max(1, +e.target.value))} /></label>
        <label class="row"><span class="lbl">DATS 5th byte</span>
          <input type="number" min="0" max="255" value=${trailing}
            onInput=${(e) => setTrailing(+e.target.value)} /></label>
      </div>

      <div class="row wrap">
        <span class="lbl">Payload format</span>
        <button class=${format === 'fullcolor' ? 'primary' : ''}
          onClick=${() => setFormat('fullcolor')}>raw RGB per pixel</button>
        <button class=${format === 'percolumn' ? 'primary' : ''}
          onClick=${() => setFormat('percolumn')}>bitmap + per-column</button>
      </div>

      ${format === 'percolumn' && html`
        <div class="row wrap">
          <span class="lbl">Bitmap pattern</span>
          ${['diagonal', 'solid', 'edges'].map((pt) => html`
            <button class=${pattern === pt ? 'primary' : ''} onClick=${() => setPattern(pt)}>${pt}</button>
          `)}
        </div>
        <p class="note">
          <b>diagonal</b> lights exactly one row per column, stepping down and wrapping every 16
          columns — a staircase. Count the visible steps: that is how many rows the display really has,
          and it tells us whether "not full height" means the panel is taller than 16 rows.
        </p>
      `}
      ${format === 'fullcolor' && html`
        <div class="row wrap">
          <span class="lbl">Pixel order</span>
          <button class=${columnMajor ? 'primary' : ''} onClick=${() => setColumnMajor(true)}>
            column-major
          </button>
          <button class=${!columnMajor ? 'primary' : ''} onClick=${() => setColumnMajor(false)}>
            row-major
          </button>
        </div>
        <div class="row wrap">
          <span class="lbl">DATS bitmapLen</span>
          <button class=${bitmapLenMode === 'zero' ? 'primary' : ''}
            onClick=${() => setBitmapLenMode('zero')}>⚠️ 0 — SOFT-LOCKS the mask</button>
          <button class=${bitmapLenMode === 'full' ? 'primary' : ''}
            onClick=${() => setBitmapLenMode('full')}>⚠️ = total — renders as bitmap bits (garbage)</button>
        </div>
      `}

      <p class="note">
        Payload ${payload.length} bytes, bitmapLen ${bitmapLength},
        ${Math.ceil(payload.length / 98)} packets. Ceiling is 25,088 bytes.
      </p>
      ${bitmapLenMode === 'zero' && format === 'fullcolor' && html`<p class="warn">
        ⚠️ bitmapLen = 0 soft-locked a real mask: the upload froze mid-animation even though every
        step ACKed (DATSOK, REOK, DATCPOK). Recovery is a power cycle. Kept only for further probing.
      </p>`}

      <label class="row">
        <input type="checkbox" checked=${releaseOverride}
          onChange=${(e) => setReleaseOverride(e.target.checked)} />
        <span>Send <code>FC enable=0</code> first — release any color override</span>
      </label>
      <p class="note">
        The official app always sends enable=0, and enable=1 is a hard override. If enable=0 means
        "use the content's own colors", this is why an uploaded color rendered white before.
      </p>
      <div class="row wrap">
        <${Btn} kind="primary" onClick=${() => send()}>Send once<//>
        <${Btn} onClick=${sweepTrailing}>Sweep DATS 5th byte 0→20<//>
      </div>
      ${result && html`<p class="status">${result}</p>`}

      <p class="note">
        If none of this works, the answer is an Android HCI snoop capture of the official app doing a
        DIY upload — you have the AES key, so it would show the exact bytes.
      </p>
    <//>
  `;
}

function Experiments() {
  const [result, setResult] = useState('');
  const sweep = async () => {
    for (let i = 1; i <= 30; i++) {
      setResult(`PLAY ${i} — watch the mask`);
      await mask.sendCommand(command.play(i), `PLAY ${i}`);
      await new Promise((r) => setTimeout(r, 1200));
    }
    setResult('sweep done — how many distinct images, and did any uploaded color appear?');
  };

  return html`
    <${Section} title="Experiments"
      note="Each of these settles one open question in docs/protocol.md. Watch the log and the mask.">
      <div class="stack">
        <div class="row wrap">
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.foregroundColor(255, 0, 0, 1), 'FC red en=1');
            await new Promise((r) => setTimeout(r, 1200));
            await mask.sendCommand(command.foregroundColor(255, 0, 0, 0), 'FC red en=0');
            setResult('FC red sent with enable=1, then enable=0. Which one changed the face? ' +
              'Red → byte order is RGB; blue → it is R,B,G.');
          }}>Settle FC (both enable values)<//>
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.backgroundColor(0, 0, 255, 1), 'BC blue en=1');
            setResult('BC blue sent. If the unlit area turns blue, BC drives the background.');
          }}>Try BC<//>
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.checkCount(), 'CHEC');
            setResult('CHEC sent — anything in the log? That would give us an image count.');
          }}>Try CHEC (unverified)<//>
        </div>
        <div class="row wrap">
          <${Btn} onClick=${sweep}>Sweep PLAY 1→30 (find slots / where uploads land)<//>
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.image(5), 'IMAG 5 with len=5');
            await mask.sendCommand(
              encryptEcb(buildCommandFrame('IMAG', [5], 6)), 'IMAG 5 with len=6');
            setResult('Sent IMAG 5 twice, len=5 then len=6. Did both change the face?');
          }}>Compare IMAG len=5 vs len=6<//>
        </div>
        <p class="note">
          The persistence test needs you: upload a bitmap above, then power-cycle the mask, then sweep
          PLAY. If your image survives in a slot, the PWA can write DIY slots after all.
        </p>
        ${result && html`<p class="status">${result}</p>`}
      </div>
    <//>
  `;
}

function RawConsole() {
  const [hex, setHex] = useState('05 4d 4f 44 45 01');
  return html`
    <${Section} title="Raw console"
      note="Plaintext hex in. Encrypted path pads to 16 bytes and AES-ECBs it; the bulk path writes verbatim.">
      <label class="row">
        <span class="lbl">Bytes</span>
        <input class="mono wide" value=${hex} onInput=${(e) => setHex(e.target.value)} />
      </label>
      <div class="row wrap">
        <${Btn} onClick=${async () => {
          const bytes = hexToBytes(hex);
          const frame = new Uint8Array(16);
          frame.set(bytes.subarray(0, 16));
          await mask.sendCommand(encryptEcb(frame), 'raw → command (encrypted)');
        }}>Send to command char (encrypt)<//>
        <${Btn} onClick=${() => mask.sendUploadRaw(hexToBytes(hex))}>
          Send to bulk char (plaintext)
        <//>
      </div>
    <//>
  `;
}

function Log({ entries, onClear }) {
  const boxRef = useRef(null);
  // Keep the newest entry visible WITHOUT moving the page. scrollIntoView() scrolls the nearest
  // scrollable ancestor, which meant every log line yanked the whole document down. Scroll the box
  // itself, and only when the user is already at the bottom, so manual scrollback is never fought.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return html`
    <${Section} title=${`Log (${entries.length})`}>
      <div class="row"><${Btn} onClick=${onClear}>Clear<//></div>
      <div class="log" ref=${boxRef}>
        ${entries.map((e, i) => html`
          <div class="entry ${e.level} dir-${e.dir}" key=${i}>
            <span class="at">${e.at}</span>
            <span class="dir">${e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '·'}</span>
            <span class="label">${e.label}</span>
            ${e.hex && html`<span class="hex">${e.hex}</span>`}
            ${e.text && html`<span class="text">${e.text}</span>`}
          </div>
        `)}
      </div>
    <//>
  `;
}

// ---------------------------------------------------------------- app

function App() {
  const [status, setStatus] = useState({ state: 'disconnected', message: '' });
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    const onStatus = (e) => setStatus(e.detail);
    const onLog = (e) => setEntries((prev) => [...prev.slice(-400), e.detail]);
    mask.addEventListener('status', onStatus);
    mask.addEventListener('log', onLog);
    return () => {
      mask.removeEventListener('status', onStatus);
      mask.removeEventListener('log', onLog);
    };
  }, []);

  const clear = useCallback(() => setEntries([]), []);
  const live = status.state === 'connected';

  return html`
    <header>
      <h1>Shining Mask <span class="tag">prototype</span></h1>
      <p>
        Control surface and protocol test harness. See
        <a href="https://github.com/Superd22/led-mask/blob/main/docs/protocol.md">docs/protocol.md</a>
        for what's confirmed and what isn't.
      </p>
    </header>
    <${Connection} status=${status} />
    <div class=${live ? '' : 'dimmed'}>
      <${BuiltIn} />
      <${DiySlots} />
      <${ColorBank} />
      <${Appearance} />
      <${Visualizer} />
      <${DiyImage} />
      <${Upload} />
      <${UploadLab} />
      <${Experiments} />
      <${RawConsole} />
    </div>
    <${Log} entries=${entries} onClear=${clear} />
  `;
}

render(html`<${App} />`, document.getElementById('app'));

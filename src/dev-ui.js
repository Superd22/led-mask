/**
 * The developer harness — the original UI, kept intact.
 *
 * This is where the protocol was reverse engineered, and it is deliberately NOT simplified: it
 * exposes every verb, every open question, and every experiment that would settle one, plus a
 * decrypted log of every byte in both directions. The friendly UI in src/panels/ is a lid on top of
 * it; this is what you open when the lid isn't enough.
 *
 * Reached from the "Dev" toggle in the header.
 */
import { html, useState, useEffect, useRef } from 'preact';
import { mask } from './mask.js';
import {
  Section, Btn, Slider, IndexGrid,
  hexToBytes, hexToRgb, rgbToHex, hslToRgb, textToColumns, solidColorPayload,
} from './ui-kit.js';
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
import { AudioEngine, DEFAULT_SETTINGS, PRESETS } from './audio-engine.js';
import { device, panelGeometry, useStore } from './store.js';

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
      note=${`PLAY selects a slot. Slots are written by the DIY image panel below, or by the official app.`}>
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
 * FC with enable=1 overrides content colour with literal RGB at ~11ms per change — 30x cheaper than
 * re-uploading. So the useful pattern is: prime a shape once (slow), then recolour instantly.
 *
 * enable=0 hands colour back to the content instead, which is what the official app sends. An
 * uploaded image's own colours stay invisible until that override is released — mistaking that for
 * "the payload's colour is ignored" cost an afternoon and a wrong entry in the docs.
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
      note=${`FC enable=1 overrides colour with literal RGB (~11ms); enable=0 hands colour back to the
              content. Prime a shape once, then recolour with one command.`}>
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
          1 overrides the content's colour with literal RGB; 0 hands colour back to the content.
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
        ~11ms per change, so this is the cheap colour axis: comfortable well past 24 Hz.
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
        Re-uploads the per-column RGB instead of overriding it — kept so the two are easy to compare
        side by side. Measured ~300-350ms per upload.
      </p>
    <//>
  `;
}

/**
 * Sound visualizer — the official app's own protocol, decoded from a capture.
 *
 * The phone does the FFT and streams 24 band levels to the …960b characteristic; the mask renders one
 * of 5 built-in effects. Frame is [0x0f][effect][12 bytes = 24 nibbles][00 00], fire-and-forget.
 *
 * The FFT and band mapping live in ../audio-engine.js, shared with the friendly UI. This panel is
 * the raw-controls view of the same engine.
 */
function Visualizer() {
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState('mic');
  const [effect, setEffect] = useState(0);
  const [cfg, setCfg] = useState(DEFAULT_SETTINGS);
  const [fileName, setFileName] = useState('');
  const [bands, setBands] = useState(() => new Array(SPECTRUM_BANDS).fill(0));
  const [err, setErr] = useState('');

  const elRef = useRef(null);
  const fileInputRef = useRef(null);
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
    if (engineRef.current.running) mask.log('sys', 'visualizer stopped');
    engineRef.current.stop(elRef.current);
    setRunning(false);
    setBands(new Array(SPECTRUM_BANDS).fill(0));
  };

  const start = async () => {
    setErr('');
    try {
      await engineRef.current.start(source, elRef.current);
      setRunning(true);
      mask.log('sys', `visualizer started: ${source}, ${cfg.hz}Hz, effect ${effect}`, null, '', 'ok');
      if (!mask.connected) {
        mask.log('sys', 'not connected — bars will move but nothing is sent', null, '', 'warn');
      }
    } catch (e) {
      setErr(e.message);
      stop();
    }
  };

  useEffect(() => () => engineRef.current.stop(elRef.current), []);

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

      <${Slider} label=${`Rate (${cfg.hz} Hz)`} value=${cfg.hz} setValue=${(v) => set({ hz: v })}
        onCommit=${() => {}} min=${1} max=${50} />
      <${Slider} label=${`Sensitivity (floor ${cfg.floorDb} dB)`} value=${-cfg.floorDb}
        setValue=${(v) => set({ floorDb: -v })} onCommit=${() => {}} min=${40} max=${100} />
      <${Slider} label=${`Contrast (range ${cfg.rangeDb} dB)`} value=${cfg.rangeDb}
        setValue=${(v) => set({ rangeDb: v })} onCommit=${() => {}} min=${15} max=${80} />
      <${Slider} label=${`Treble tilt (${cfg.tilt.toFixed(1)} dB/oct)`} value=${Math.round(cfg.tilt * 2)}
        setValue=${(v) => set({ tilt: v / 2 })} onCommit=${() => {}} min=${0} max=${20} />
      <${Slider} label=${`Fall time (${cfg.fallMs} ms)`} value=${cfg.fallMs}
        setValue=${(v) => set({ fallMs: v })} onCommit=${() => {}} min=${30} max=${800} />
      <div class="row wrap">
        <span class="lbl">Presets</span>
        ${PRESETS.map(({ name, ...values }) => html`
          <button onClick=${() => set(values)}>${name.toLowerCase()}</button>
        `)}
      </div>

      ${err && html`<p class="warn">${err}</p>`}
      <p class="note">
        The official app streams at ${SPECTRUM_HZ} Hz. Higher rates are unexplored territory — frames
        are dropped rather than queued if the link can't keep up, and the log's <code>spectrum N/s</code>
        heartbeat reports the rate actually achieved plus any drops, so you can find the real ceiling.
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
  const [settings] = useStore(device);
  const [source, setSource] = useState('gradient');
  const [progress, setProgress] = useState('');
  const [pixels, setPixels] = useState(null);
  const canvasRef = useRef(null);
  const fileRef = useRef(null);

  const patternAt = (x, y) => {
    if (source === 'gradient')
      return hslToRgb((x / (DIY_WIDTH - 1)) * 330, 1, 0.15 + 0.7 * (y / (DIY_HEIGHT - 1)));
    if (source === 'quadrants')
      return x < DIY_WIDTH / 2
        ? (y < DIY_HEIGHT / 2 ? [255, 0, 0] : [0, 255, 0])
        : (y < DIY_HEIGHT / 2 ? [0, 0, 255] : [255, 255, 0]);
    // 'corner': a single bright marker top-left, everything else dim. Confirms panel geometry.
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
    const payload = buildImagePayload(colorAt, panelGeometry(settings));
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
        <span class="lbl">Geometry</span>
        <span class="note">
          ${panelGeometry(settings).width}x${panelGeometry(settings).height},
          ${panelGeometry(settings).columnMajor ? 'column-major' : 'row-major'} — change it in the
          device menu.
        </span>
      </div>

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

/**
 * Upload lab — for poking at DATS headers by hand.
 *
 * The two supported paths are now known (mode 0x00 text, mode 0x01 persistent image), but the header
 * still has unexplored corners, and this is what found the ones we do know.
 */
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
    const cols = Array.from({ length: width }, (_, x) =>
      Array.from({ length: DISPLAY_HEIGHT }, (_, y) => {
        if (pattern === 'solid') return 1;
        if (pattern === 'diagonal') return y === x % DISPLAY_HEIGHT ? 1 : 0;
        return y === 0 || y === DISPLAY_HEIGHT - 1 || y === 7 || y === 8 ? 1 : 0;
      }),
    );
    const bitmap = encodeBitmap(cols);
    const colors = encodeColors(cols.map((_, x) => colorAt(x, DISPLAY_HEIGHT - 1)));
    return buildUploadPayload(bitmap, colors);
  };

  const send = async (t = trailing) => {
    if (releaseOverride) {
      await mask.sendCommand(command.foregroundColor(255, 255, 255, 0), 'FC enable=0 (release)');
      await new Promise((r) => setTimeout(r, 120));
    }
    const { payload, bitmapLength } = build();
    setResult(`sending ${payload.length}B, bitmapLen=${bitmapLength}, DATS[5]=${t}…`);
    await mask.upload(payload, bitmapLength, { trailing: t });
    setResult(`sent ${payload.length}B (${Math.ceil(payload.length / 98)} pkts), DATS[5]=${t}`);
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
    <${Section} title="Upload lab — raw DATS experiments"
      note=${`For poking at DATS headers by hand. The supported paths are the DIY image panel (mode
              0x01, full color, persistent) and the text upload above (mode 0x00, 16-row band).
              The pattern varies hue horizontally and brightness vertically.`}>
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
          columns — a staircase. Count the visible steps: that is how many rows the text band has.
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
      <div class="row wrap">
        <${Btn} kind="primary" onClick=${() => send()}>Send once<//>
        <${Btn} onClick=${sweepTrailing}>Sweep DATS 5th byte 0→20<//>
      </div>
      ${result && html`<p class="status">${result}</p>`}
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
            setResult('CHEC sent — check the log for the count.');
          }}>CHEC (image count)<//>
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

/**
 * The decrypted wire log.
 *
 * Shared with the friendly UI, which shows it in a drawer — it is the single best debugging tool
 * here and it should never be more than one tap away.
 */
export function Log({ entries, onClear }) {
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

export function DevUi({ status, entries, onClear }) {
  const live = status.state === 'connected';
  return html`
    <div class="dev-ui">
      <p class="note dev-intro">
        The reverse-engineering harness. Everything the protocol can do, including the parts that are
        unverified or that can wedge the mask. See
        <a href="https://github.com/Superd22/led-mask/blob/main/docs/protocol.md">docs/protocol.md</a>.
      </p>
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
      <${Log} entries=${entries} onClear=${onClear} />
    </div>
  `;
}

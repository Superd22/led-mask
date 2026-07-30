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
    const packets = await mask.upload(payload, bitmapLength, (n, resp) =>
      setProgress(`packet ${n} — ${resp}`),
    );
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
          const n = await mask.upload(payload, bitmapLength, (i, r) => setProgress(`packet ${i} — ${r}`));
          setProgress(`done, ${n} packets`);
        }}>Upload mask-go's known-good capture<//>
      </div>
      ${progress && html`<p class="status">${progress}</p>`}
    <//>
  `;
}

function Experiments() {
  const [result, setResult] = useState('');
  const sweep = async () => {
    for (let i = 1; i <= 20; i++) {
      setResult(`PLAY ${i} — watch the mask`);
      await mask.sendCommand(command.play(i), `PLAY ${i}`);
      await new Promise((r) => setTimeout(r, 1200));
    }
    setResult('sweep done — how many distinct images did you see?');
  };

  return html`
    <${Section} title="Experiments"
      note="Each of these settles one open question in docs/protocol.md. Watch the log and the mask.">
      <div class="stack">
        <div class="row wrap">
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.foregroundColor(255, 0, 0), 'FC pure red');
            setResult('FC sent as (r=255,g=0,b=0). Red on the mask → order is RGB. Blue → it is R,B,G.');
          }}>Settle FC byte order<//>
          <${Btn} onClick=${async () => {
            await mask.sendCommand(command.checkCount(), 'CHEC');
            setResult('CHEC sent — anything in the log? That would give us an image count.');
          }}>Try CHEC (unverified)<//>
        </div>
        <div class="row wrap">
          <${Btn} onClick=${sweep}>Sweep PLAY 1→20 (find the slot count)<//>
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
  const endRef = useRef(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'nearest' }), [entries.length]);
  return html`
    <${Section} title=${`Log (${entries.length})`}>
      <div class="row"><${Btn} onClick=${onClear}>Clear<//></div>
      <div class="log">
        ${entries.map((e, i) => html`
          <div class="entry ${e.level} dir-${e.dir}" key=${i}>
            <span class="at">${e.at}</span>
            <span class="dir">${e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '·'}</span>
            <span class="label">${e.label}</span>
            ${e.hex && html`<span class="hex">${e.hex}</span>`}
            ${e.text && html`<span class="text">${e.text}</span>`}
          </div>
        `)}
        <div ref=${endRef}></div>
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
      <${Appearance} />
      <${Upload} />
      <${Experiments} />
      <${RawConsole} />
    </div>
    <${Log} entries=${entries} onClear=${clear} />
  `;
}

render(html`<${App} />`, document.getElementById('app'));

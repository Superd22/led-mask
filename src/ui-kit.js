/**
 * Shared helpers and primitives.
 *
 * Everything here is used by both the friendly UI (src/panels/) and the dev harness (src/dev-ui.js).
 * Keeping it in one place is what lets the harness stay byte-for-byte the tool it was while the app
 * on top of it changes shape.
 */
import { html, useState } from 'preact';
import { mask } from './mask.js';
import { DISPLAY_HEIGHT, encodeBitmap, encodeColors, buildUploadPayload } from './mask-protocol.js';

// ---------------------------------------------------------------- bytes & colour

export const hexToBytes = (str) => {
  const clean = str.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex needs an even number of digits');
  return Uint8Array.from(clean.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
};

export const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export const rgbToHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Evenly spaced hues at full saturation. h in [0,360). */
export function hslToRgb(h, s = 1, l = 0.5) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ---------------------------------------------------------------- text rendering

/** Render text to a 16px-high canvas and threshold it into on/off columns. */
export function textToColumns(text, { fontSize = 13, font = 'sans-serif', threshold = 100 } = {}) {
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

/**
 * A solid fill: every pixel in every column lit, one RGB per column.
 *
 * `columns` is the display width — 46 measured on hardware.
 */
export function solidColorPayload(rgb, columns) {
  const cols = Array.from({ length: columns }, () => Array(DISPLAY_HEIGHT).fill(1));
  return buildUploadPayload(encodeBitmap(cols), encodeColors(cols.map(() => rgb)));
}

// ---------------------------------------------------------------- primitives

export const Section = ({ title, note, children }) => html`
  <section>
    <h2>${title}</h2>
    ${note && html`<p class="note">${note}</p>`}
    <div class="body">${children}</div>
  </section>
`;

/**
 * A button that cannot be double-fired and that routes its own failures into the log.
 *
 * Every action here is a BLE round trip, so "disabled while in flight" is not polish — a second
 * click mid-handshake interleaves writes with the upload state machine.
 */
export const Btn = ({ onClick, children, kind = '', disabled, title }) => {
  const [busy, setBusy] = useState(false);
  return html`<button
    class=${`${kind} ${busy ? 'busy' : ''}`}
    title=${title}
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
export const Slider = ({ label, value, setValue, onCommit, min = 0, max = 255, unit = '' }) => html`
  <label class="row">
    <span class="lbl">${label}</span>
    <input
      type="range"
      min=${min}
      max=${max}
      value=${value}
      onInput=${(e) => setValue(+e.target.value)}
      onChange=${() => onCommit?.(value)}
    />
    <output>${value}${unit}</output>
  </label>
`;

/** Index picker: a spinner for the exact value plus a grid for fast probing. */
export const IndexGrid = ({ label, count, onPick, note }) => {
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

// ---------------------------------------------------------------- new-UI primitives

/** A titled card. The friendly UI's only container. */
export const Card = ({ title, hint, actions, children, className = '' }) => html`
  <div class=${`card ${className}`}>
    ${(title || actions) && html`
      <div class="card-head">
        <div>
          ${title && html`<h3>${title}</h3>`}
          ${hint && html`<p class="hint">${hint}</p>`}
        </div>
        ${actions && html`<div class="card-actions">${actions}</div>`}
      </div>
    `}
    ${children}
  </div>
`;

/** A row of mutually-exclusive pills. `options` is [{value, label}] or plain strings. */
export const Chips = ({ label, options, value, onPick }) => html`
  <div class="field">
    ${label && html`<span class="field-label">${label}</span>`}
    <div class="chips">
      ${options.map((opt) => {
        const v = typeof opt === 'object' ? opt.value : opt;
        const text = typeof opt === 'object' ? opt.label : opt;
        return html`<button
          class=${`chip ${v === value ? 'on' : ''}`}
          onClick=${() => onPick(v)}
        >${text}</button>`;
      })}
    </div>
  </div>
`;

/** Labelled slider for the friendly UI: label above, value on the right, full-width track. */
export const Dial = ({ label, value, display, setValue, onCommit, min = 0, max = 255 }) => html`
  <label class="field dial">
    <span class="field-label">
      ${label}<b>${display ?? value}</b>
    </span>
    <input
      type="range"
      min=${min}
      max=${max}
      value=${value}
      onInput=${(e) => setValue(+e.target.value)}
      onChange=${() => onCommit?.(value)}
    />
  </label>
`;

/** Collapsible block for the controls most people never touch. */
export const More = ({ label = 'Advanced', children }) => html`
  <details class="more">
    <summary>${label}</summary>
    <div class="more-body">${children}</div>
  </details>
`;

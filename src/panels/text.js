/**
 * Text — one panel, everything.
 *
 * Two protocol facts shape this. Colour in the text format is per COLUMN, not per pixel, which is
 * why "solid" and "rainbow" are the two honest options and a per-letter gradient is not. And an FC
 * colour override, once set, keeps overriding — an uploaded payload's own colours stay invisible
 * until it is released — so every send here releases it first. Getting that wrong is what made
 * uploaded colour look broken for an afternoon.
 */
import { html, useState, useRef, useEffect } from 'preact';
import { mask } from '../mask.js';
import {
  command, MODE, TEXT_COLOR_MODE, DISPLAY_HEIGHT, DIY_WIDTH,
  encodeBitmap, encodeColors, buildUploadPayload,
} from '../mask-protocol.js';
import { Card, Chips, Dial, More, Btn, hexToRgb, hslToRgb, textToColumns } from '../ui-kit.js';

const FONTS = [
  { value: 'sans-serif', label: 'Sans' },
  { value: 'monospace', label: 'Mono' },
  { value: 'serif', label: 'Serif' },
];

const MOTION = [
  { value: MODE.scrollLeft, label: 'Scroll ←' },
  { value: MODE.scrollRight, label: 'Scroll →' },
  { value: MODE.steady, label: 'Steady' },
  { value: MODE.blink, label: 'Blink' },
];

const COLOR_MODES = [
  { value: TEXT_COLOR_MODE.gradient0, label: 'Gradient 1' },
  { value: TEXT_COLOR_MODE.gradient1, label: 'Gradient 2' },
  { value: TEXT_COLOR_MODE.gradient2, label: 'Gradient 3' },
  { value: TEXT_COLOR_MODE.gradient3, label: 'Gradient 4' },
  { value: TEXT_COLOR_MODE.backgroundXMask, label: 'X mask' },
  { value: TEXT_COLOR_MODE.backgroundChristmas, label: 'Christmas' },
  { value: TEXT_COLOR_MODE.backgroundLove, label: 'Love' },
  { value: TEXT_COLOR_MODE.backgroundScream, label: 'Scream' },
];

const SWATCHES = ['#ffffff', '#ff2d55', '#ff9500', '#ffd60a', '#32d74b', '#0affef', '#0a84ff', '#bf5af2'];

export function TextPanel() {
  const [text, setText] = useState('HELLO');
  const [color, setColor] = useState('#ff2d55');
  const [rainbow, setRainbow] = useState(false);
  const [font, setFont] = useState('sans-serif');
  const [fontSize, setFontSize] = useState(13);
  const [motion, setMotion] = useState(MODE.scrollLeft);
  const [speed, setSpeed] = useState(50);
  const [background, setBackground] = useState('#000000');
  const [progress, setProgress] = useState('');
  const canvasRef = useRef(null);

  const columns = textToColumns(text || ' ', { font, fontSize });
  const colorFor = (x) =>
    rainbow ? hslToRgb((x / Math.max(1, columns.length - 1)) * 330) : hexToRgb(color);

  // Preview at the display's real aspect: 16 rows tall, and the first 46 columns are one screenful.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = 6;
    canvas.width = Math.max(1, columns.length * scale);
    canvas.height = DISPLAY_HEIGHT * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    columns.forEach((col, x) => {
      ctx.fillStyle = `rgb(${colorFor(x).map(Math.round).join(',')})`;
      col.forEach((on, y) => on && ctx.fillRect(x * scale, y * scale, scale - 1, scale - 1));
    });
  }, [text, color, rainbow, font, fontSize, background]);

  const send = async () => {
    // Release any colour override first, or the payload's own colours never show.
    await mask.sendCommand(command.foregroundColor(255, 255, 255, 0), 'FC release');
    await mask.sendCommand(command.mode(motion), `MODE ${motion}`);
    await mask.sendCommand(command.speed(speed), `SPEED ${speed}`);

    const bitmap = encodeBitmap(columns);
    const colors = encodeColors(columns.map((_, x) => colorFor(x)));
    const { payload, bitmapLength } = buildUploadPayload(bitmap, colors);
    setProgress(`Sending ${payload.length} bytes…`);
    const packets = await mask.upload(payload, bitmapLength, {
      onProgress: (n) => setProgress(`packet ${n} / ${Math.ceil(payload.length / 98)}`),
    });
    setProgress(`On the mask — ${packets} packets.`);
  };

  return html`
    <${Card} title="Text" hint=${`Rendered here, uploaded to the mask's ${DISPLAY_HEIGHT}-row text band.`}>
      <input
        class="text-input"
        value=${text}
        maxlength="64"
        placeholder="Type something"
        onInput=${(e) => setText(e.target.value)}
      />

      <div class="text-preview">
        <canvas ref=${canvasRef} class="preview"></canvas>
      </div>
      <p class="hint">
        ${columns.length} columns.
        ${columns.length > DIY_WIDTH
          ? ` Wider than the ${DIY_WIDTH}-column display, so it needs a scroll mode to be readable.`
          : ' Fits on the display in one go.'}
      </p>

      <div class="field">
        <span class="field-label">Colour</span>
        <div class="swatch-row">
          ${SWATCHES.map((hex) => html`
            <button
              key=${hex}
              class=${`dot ${!rainbow && color === hex ? 'on' : ''}`}
              style=${`background:${hex}`}
              title=${hex}
              onClick=${() => { setRainbow(false); setColor(hex); }}
            ></button>
          `)}
          <button class=${`dot rainbow ${rainbow ? 'on' : ''}`} title="Rainbow across the text"
            onClick=${() => setRainbow(true)}></button>
          <label class="dot custom" title="Custom colour">
            <input type="color" value=${color}
              onInput=${(e) => { setRainbow(false); setColor(e.target.value); }} />
          </label>
        </div>
      </div>

      <${Chips} label="Motion" options=${MOTION} value=${motion} onPick=${setMotion} />

      <${Dial} label="Scroll speed" value=${speed} setValue=${setSpeed} min=${0} max=${255} />

      <${More} label="Typography & background">
        <${Chips} label="Font" options=${FONTS} value=${font} onPick=${setFont} />
        <${Dial} label="Size" display=${`${fontSize} px`} value=${fontSize}
          setValue=${setFontSize} min=${8} max=${16} />
        <label class="field">
          <span class="field-label">Background colour<b>BC</b></span>
          <div class="chips">
            <input type="color" value=${background} onInput=${(e) => setBackground(e.target.value)} />
            <${Btn} onClick=${() =>
              mask.sendCommand(command.backgroundColor(...hexToRgb(background)), `BC ${background}`)}>
              Apply background
            <//>
          </div>
        </label>
        <p class="hint">
          Background colour is a separate command from the text itself — apply it once and it stays.
        </p>
        <div class="field">
          <span class="field-label">Built-in colour modes</span>
          <div class="chips">
            ${COLOR_MODES.map((m) => html`
              <button class="chip" key=${m.value}
                onClick=${() => mask.sendCommand(command.textColorMode(m.value), `M ${m.value}`)}>
                ${m.label}
              </button>
            `)}
            <button class="chip"
              onClick=${() => mask.sendCommand(command.textColorMode(0, 0), 'M off')}>
              Off
            </button>
          </div>
          <p class="hint">
            The mask's own gradients and background images. They replace the per-column colour above,
            so pick one or the other.
          </p>
        </div>
      <//>

      <div class="cta">
        <${Btn} kind="go" onClick=${send}>Send to mask<//>
        ${progress && html`<span class="progress">${progress}</span>`}
      </div>
    <//>
  `;
}

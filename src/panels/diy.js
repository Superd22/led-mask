/**
 * DIY — your own full-colour images in the mask's persistent slots.
 *
 * The mask cannot be queried: nothing reports what is in slot 7, or whether it is empty. So the
 * gallery here is not a cache of the device, it is the ONLY record that exists — which is why it
 * persists to localStorage and why the slot grid shows what we believe we wrote rather than what is
 * really there. Write a slot from another app and this drifts; nothing can detect that.
 *
 * Images are stored as originals plus a crop transform, never as baked panel pixels, so panel
 * geometry stays a setting you can change without silently re-cropping everything you own.
 */
import { html, useState, useRef, useEffect } from 'preact';
import { mask } from '../mask.js';
import { command, buildImagePayload } from '../mask-protocol.js';
import { Card, Chips, More, Btn, hslToRgb } from '../ui-kit.js';
import { gallery, slotInventory, device, panelGeometry, useStore } from '../store.js';
import {
  DEFAULT_TRANSFORM, fileToStorableImage, loadCached, rasterise, sourceOf,
} from '../image.js';
import { drawFlat, drawLedMatrix } from '../led-preview.js';
import { ImageEditor } from './image-editor.js';

const SLOTS = Array.from({ length: 20 }, (_, i) => i + 1);

/** Built-in patterns, handy for checking brightness and geometry on real hardware. */
const PATTERNS = {
  gradient: (x, y, { width, height }) =>
    hslToRgb((x / Math.max(1, width - 1)) * 330, 1, 0.15 + 0.7 * (y / Math.max(1, height - 1))),
  quadrants: (x, y, { width, height }) =>
    x < width / 2
      ? (y < height / 2 ? [255, 0, 0] : [0, 255, 0])
      : (y < height / 2 ? [0, 0, 255] : [255, 255, 0]),
  corners: (x, y, { width, height }) =>
    (x < 6 && y < 6) ? [255, 0, 0]
    : (x >= width - 6 && y < 6) ? [0, 255, 0]
    : (x < 6 && y >= height - 6) ? [0, 0, 255]
    : [8, 8, 8],
};

function patternToDataUrl(name, geometry) {
  const { width, height } = geometry;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = PATTERNS[name](x, y, geometry);
      const i = (y * width + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * A gallery item drawn at panel resolution, either flat or as LEDs.
 *
 * Flat for thumbnails — at 60px wide, dots and bloom read as noise. LEDs for anything big enough to
 * judge, because that is what the hardware does to your image.
 */
function PanelCanvas({ item, geometry, led = false, cssWidth = 96 }) {
  const ref = useRef(null);
  useEffect(() => {
    let live = true;
    loadCached(sourceOf(item))
      .then((img) => {
        if (!live || !ref.current) return;
        const colorAt = rasterise(img, item.transform, geometry);
        const draw = led ? drawLedMatrix : drawFlat;
        draw(ref.current, colorAt, { ...geometry, cssWidth });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [item.id, item.src, item.transform, geometry.width, geometry.height, led, cssWidth]);
  return html`<canvas ref=${ref} class=${led ? 'led-canvas' : 'flat-canvas'}></canvas>`;
}

export function DiyPanel() {
  const [items, setItems] = useStore(gallery);
  const [slots, setSlots] = useStore(slotInventory);
  const [settings] = useStore(device);
  const [slot, setSlot] = useState(1);
  const [selected, setSelected] = useState(null); // gallery item id
  const [editing, setEditing] = useState(null); // gallery item id
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const geometry = panelGeometry(settings);
  const byId = (id) => items.find((it) => it.id === id);
  const chosen = byId(selected);
  const underEdit = byId(editing);

  const addFiles = async (files) => {
    setErr('');
    const added = [];
    for (const file of [...files]) {
      try {
        added.push({
          id: `${Date.now().toString(36)}-${added.length}`,
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'image',
          src: await fileToStorableImage(file),
          transform: { ...DEFAULT_TRANSFORM },
        });
      } catch (e) {
        setErr(e.message);
      }
    }
    if (!added.length) return;
    setItems([...added, ...items]);
    setSelected(added[0].id);
    // Straight into framing: a raw centre-crop is almost never the shot someone wanted.
    if (added.length === 1) setEditing(added[0].id);
  };

  const addPattern = (name) => {
    const item = {
      id: `${Date.now().toString(36)}-${name}`,
      name,
      src: patternToDataUrl(name, geometry),
      transform: { ...DEFAULT_TRANSFORM },
    };
    setItems([item, ...items]);
    setSelected(item.id);
  };

  const remove = (id) => {
    setItems(items.filter((it) => it.id !== id));
    // The slot mapping deliberately keeps pointing at a gone image rather than claiming the slot is
    // empty — the mask still holds those pixels until something overwrites them.
    if (selected === id) setSelected(null);
    if (editing === id) setEditing(null);
  };

  const saveEdit = ({ transform, name }) => {
    setItems(items.map((it) => (it.id === editing ? { ...it, transform, name } : it)));
    setEditing(null);
  };

  /** PLAY a slot. Selecting a slot does not upload — that is the whole point of persistence. */
  const playSlot = async (n) => {
    setSlot(n);
    await mask.sendCommand(command.play(n), `PLAY ${n}`);
  };

  const write = async () => {
    if (!chosen) throw new Error('pick an image first');
    setErr('');
    const img = await loadCached(sourceOf(chosen));
    const payload = buildImagePayload(rasterise(img, chosen.transform, geometry), {
      ...geometry,
    });
    const total = Math.ceil(payload.length / 98);
    setProgress(`Writing “${chosen.name}” to slot ${slot}…`);
    await mask.uploadImage(payload, slot, {
      onProgress: (n) => setProgress(`packet ${n} / ${total}`),
    });
    setSlots({ ...slots, [slot]: chosen.id });
    setProgress(`Slot ${slot} is now “${chosen.name}”.`);
    // The mask needs a beat after DATCPOK before it will honour PLAY on the slot just written.
    await new Promise((r) => setTimeout(r, 300));
    await mask.sendCommand(command.play(slot), `PLAY ${slot}`);
  };

  if (underEdit) {
    return html`
      <${ImageEditor}
        key=${underEdit.id}
        item=${underEdit}
        geometry=${geometry}
        onSave=${saveEdit}
        onCancel=${() => setEditing(null)}
      />
    `;
  }

  return html`
    <${Card}
      title="Slots"
      hint="20 persistent slots on the mask. Tap one to show it — no upload needed, the image lives on the device."
    >
      <div class="slots">
        ${SLOTS.map((n) => {
          const item = byId(slots[n]);
          return html`
            <button
              key=${n}
              class=${`slot ${slot === n ? 'on' : ''} ${item ? 'filled' : ''}`}
              onClick=${() => playSlot(n)}
              title=${item ? `${n} — ${item.name}` : `Slot ${n} (unknown contents)`}
            >
              ${item
                ? html`<${PanelCanvas} item=${item} geometry=${geometry} cssWidth=${64} />`
                : html`<span class="slot-empty">?</span>`}
              <span class="slot-index">${n}</span>
            </button>
          `;
        })}
      </div>
      <p class="hint">
        A “?” means we have never written that slot from here — it may still hold something the
        official app put there. The mask has no way to tell us.
      </p>
    <//>

    ${chosen && html`
      <${Card}
        title="Preview"
        hint=${`“${chosen.name}” as ${geometry.width}x${geometry.height} LEDs.`}
        actions=${html`
          <button class="ghost" onClick=${() => setEditing(chosen.id)}>✂ Reframe</button>
        `}
      >
        <div class="led-stage">
          <${PanelCanvas} item=${chosen} geometry=${geometry} led cssWidth=${288} />
        </div>
        <div class="cta">
          <${Btn} kind="go" onClick=${write}>Write to slot ${slot}<//>
          ${progress && html`<span class="progress">${progress}</span>`}
        </div>
        <p class="hint">
          ${`${(geometry.width * geometry.height * 3).toLocaleString()} bytes over ` +
            `${Math.ceil((geometry.width * geometry.height * 3) / 98)} packets, a couple of seconds. ` +
            `This overwrites whatever slot ${slot} held.`}
        </p>
      <//>
    `}

    <${Card}
      title="Your images"
      hint="Stored in this browser as originals — reframe them any time, nothing is baked in."
      actions=${html`<button class="ghost" onClick=${() => fileRef.current?.click()}>+ Add</button>`}
    >
      <input ref=${fileRef} type="file" accept="image/*" multiple hidden
        onChange=${(e) => addFiles(e.target.files ?? [])} />

      <div
        class="gallery"
        onDragOver=${(e) => e.preventDefault()}
        onDrop=${(e) => { e.preventDefault(); addFiles(e.dataTransfer.files ?? []); }}
      >
        ${items.map((item) => html`
          <div class=${`shot ${selected === item.id ? 'on' : ''}`} key=${item.id}>
            <button class="shot-pick" onClick=${() => setSelected(item.id)}>
              <${PanelCanvas} item=${item} geometry=${geometry} cssWidth=${96} />
            </button>
            <div class="shot-foot">
              <button class="link" onClick=${() => setEditing(item.id)} title="Reframe and rename">
                ${item.name}
              </button>
              <button class="link danger" onClick=${() => remove(item.id)} title="Delete">✕</button>
            </div>
          </div>
        `)}
        <button class="shot add" onClick=${() => fileRef.current?.click()}>
          <span>+</span>
          <small>Add or drop images</small>
        </button>
      </div>

      ${err && html`<p class="banner err">${err}</p>`}
      ${!chosen && items.length > 0 && html`
        <p class="hint">Pick an image to preview it and write it to a slot.</p>
      `}

      <${More} label="Test patterns">
        <${Chips} label="Add a pattern"
          options=${Object.keys(PATTERNS).map((k) => ({ value: k, label: k }))}
          value=${null} onPick=${addPattern} />
        <p class="hint">
          Generated at the current panel size. <b>corners</b> puts a different colour in three
          corners — the quickest way to confirm the panel geometry in Device settings is right.
        </p>
      <//>
    <//>
  `;
}

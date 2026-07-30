/**
 * Frame an image onto the panel: drag to move, pinch or slider to zoom, fill or fit.
 *
 * The left stage is the classic crop view — the whole image dimmed, the part that survives shown
 * bright inside the panel outline. The right side is what actually matters: the same result drawn as
 * LEDs. A 46x58 panel throws away almost everything, and the LED render is the only preview that
 * tells you whether a face is still a face at that size before you spend two seconds uploading it.
 *
 * Nothing here is destructive. Only the transform is saved, so any crop can be re-opened and redone.
 */
import { html, useState, useRef, useEffect } from 'preact';
import { Card, Chips, Dial, Btn } from '../ui-kit.js';
import { DEFAULT_TRANSFORM, loadImage, placement, rasterise, sourceOf } from '../image.js';
import { drawLedMatrix } from '../led-preview.js';

/** How much larger than the panel the crop stage is, so you can see what's being cut off. */
const STAGE_MARGIN = 1.28;
const ZOOM_MIN = 50;
const ZOOM_MAX = 400;

export function ImageEditor({ item, geometry, onSave, onCancel }) {
  const [transform, setTransform] = useState({ ...DEFAULT_TRANSFORM, ...item.transform });
  const [name, setName] = useState(item.name);
  const [img, setImg] = useState(null);
  const [err, setErr] = useState('');
  const stageRef = useRef(null);
  const ledRef = useRef(null);
  const drag = useRef(null); // {pointers: Map, start, startTransform, gap}

  useEffect(() => {
    let live = true;
    loadImage(sourceOf(item))
      .then((loaded) => live && setImg(loaded))
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [item.id]);

  const { width, height } = geometry;

  /**
   * Keep the image covering the panel in `cover` mode — a crop that lets black in is never what
   * someone dragging meant. `contain` deliberately allows it.
   */
  const clamp = (next) => {
    if (next.mode !== 'cover' || !img) return next;
    const { w, h } = placement(img, { ...next, offsetX: 0, offsetY: 0 }, geometry);
    const limitX = Math.max(0, (w - width) / 2) / width;
    const limitY = Math.max(0, (h - height) / 2) / height;
    return {
      ...next,
      offsetX: Math.max(-limitX, Math.min(limitX, next.offsetX)),
      offsetY: Math.max(-limitY, Math.min(limitY, next.offsetY)),
    };
  };

  const update = (patch) => setTransform((prev) => clamp({ ...prev, ...patch }));

  // --- the crop stage -----------------------------------------------------

  useEffect(() => {
    const canvas = stageRef.current;
    if (!canvas || !img) return;

    const box = canvas.parentElement.clientWidth || 320;
    const scale = Math.min(box / (width * STAGE_MARGIN), 420 / (height * STAGE_MARGIN));
    const stageW = Math.round(width * STAGE_MARGIN * scale);
    const stageH = Math.round(height * STAGE_MARGIN * scale);
    const dpr = Math.min(devicePixelRatio || 1, 2);

    canvas.width = stageW * dpr;
    canvas.height = stageH * dpr;
    canvas.style.width = `${stageW}px`;
    canvas.style.height = `${stageH}px`;
    canvas.dataset.scale = scale; // pointer maths reads this back

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, stageW, stageH);

    const panelX = (stageW - width * scale) / 2;
    const panelY = (stageH - height * scale) / 2;
    const p = placement(img, transform, geometry);
    const drawArgs = [
      panelX + p.x * scale, panelY + p.y * scale, p.w * scale, p.h * scale,
    ];

    ctx.globalAlpha = 0.25;
    ctx.drawImage(img, ...drawArgs);

    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(panelX, panelY, width * scale, height * scale);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(panelX, panelY, width * scale, height * scale);
    ctx.drawImage(img, ...drawArgs);
    ctx.restore();

    ctx.strokeStyle = '#7aa2ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX - 1, panelY - 1, width * scale + 2, height * scale + 2);
  }, [img, transform, width, height]);

  // --- the LED render -----------------------------------------------------

  useEffect(() => {
    const canvas = ledRef.current;
    if (!canvas || !img) return;
    drawLedMatrix(canvas, rasterise(img, transform, geometry), {
      width,
      height,
      cssWidth: Math.min(220, (canvas.parentElement.clientWidth || 220)),
    });
  }, [img, transform, width, height]);

  // --- pointer handling ---------------------------------------------------

  const scaleOf = () => +(stageRef.current?.dataset.scale || 1);
  const gapOf = (points) => {
    const [a, b] = points;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current ??= { pointers: new Map() };
    drag.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current.startTransform = transform;
    const points = [...drag.current.pointers.values()];
    drag.current.startGap = points.length === 2 ? gapOf(points) : null;
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d?.pointers.has(e.pointerId)) return;
    const prev = d.pointers.get(e.pointerId);
    d.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...d.pointers.values()];

    if (points.length === 2 && d.startGap) {
      // Pinch: the ratio of finger separation drives zoom directly.
      const ratio = gapOf(points) / d.startGap;
      update({ zoom: Math.max(0.5, Math.min(4, d.startTransform.zoom * ratio)) });
      return;
    }
    const scale = scaleOf();
    update({
      offsetX: transform.offsetX + (e.clientX - prev.x) / scale / width,
      offsetY: transform.offsetY + (e.clientY - prev.y) / scale / height,
    });
  };

  const onPointerUp = (e) => {
    drag.current?.pointers.delete(e.pointerId);
    if (drag.current) drag.current.startGap = null;
  };

  const onWheel = (e) => {
    e.preventDefault();
    update({ zoom: Math.max(0.5, Math.min(4, transform.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))) });
  };

  return html`
    <${Card}
      title="Frame the image"
      hint=${`Drag to move, pinch or scroll to zoom. The panel is ${width}x${height} LEDs — the right-hand preview is what that really looks like.`}
      actions=${html`<button class="ghost" onClick=${onCancel}>Cancel</button>`}
    >
      ${err && html`<p class="banner err">${err}</p>`}

      <div class="editor">
        <div class="editor-stage">
          <canvas
            ref=${stageRef}
            class="stage"
            onPointerDown=${onPointerDown}
            onPointerMove=${onPointerMove}
            onPointerUp=${onPointerUp}
            onPointerCancel=${onPointerUp}
            onWheel=${onWheel}
          ></canvas>
        </div>
        <div class="editor-led">
          <span class="field-label">On the mask</span>
          <canvas ref=${ledRef}></canvas>
        </div>
      </div>

      <${Chips}
        label="Fit"
        options=${[{ value: 'cover', label: 'Fill panel' }, { value: 'contain', label: 'Whole image' }]}
        value=${transform.mode}
        onPick=${(mode) => update({ mode, zoom: 1, offsetX: 0, offsetY: 0 })}
      />

      <${Dial}
        label="Zoom"
        display=${`${Math.round(transform.zoom * 100)}%`}
        value=${Math.round(transform.zoom * 100)}
        setValue=${(v) => update({ zoom: v / 100 })}
        min=${ZOOM_MIN}
        max=${ZOOM_MAX}
      />

      <label class="field">
        <span class="field-label">Name</span>
        <input value=${name} maxlength="24" onInput=${(e) => setName(e.target.value)} />
      </label>

      <div class="cta">
        <${Btn} kind="go" onClick=${() => onSave({ transform, name: name.trim() || 'untitled' })}>
          Save framing
        <//>
        <${Btn} onClick=${() => update({ ...DEFAULT_TRANSFORM })}>Reset<//>
      </div>
    <//>
  `;
}

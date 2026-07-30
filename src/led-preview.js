/**
 * Render a panel's pixels the way the hardware actually looks: discrete LEDs on black.
 *
 * A flat scaled-up bitmap is a bad predictor of what the mask shows. Real LEDs are round emitters
 * with dark gaps between them, so fine detail that looks crisp in a pixel preview turns to mush; and
 * the panel has its own response curve, so an image that looks rich here can arrive on the face as a
 * flat bright smear. Previewing the way it renders is the whole point.
 *
 * ## The two things this models
 *
 * **Brightness.** With a small dot only a few percent of each cell is lit, so the image reads as
 * badly underexposed no matter how saturated the source is. The reflex is to crank a global blur,
 * but that is exactly what ruins the preview: a blur wide enough to brighten anything bleeds across
 * cell boundaries, so darks fill in and the dark/light separation goes. Instead the light comes from
 * a **per-cell halo** that reaches zero at the cell boundary — it multiplies the lit area, and a
 * dark neighbour stays exactly as dark, because no light ever crosses over.
 *
 * **The panel's response**, observed on hardware: dark-to-light separation is fine, but bright
 * shades converge — the top of the range washes out and distinct highlights arrive looking the same.
 * That is a midtone lift plus a highlight knee, so that is what TONE_CURVE does. It means a
 * highlight-heavy image previews as the flat bright smear it will actually be, which is the warning
 * you want *before* spending two seconds uploading it.
 *
 * Compositing goes through cached per-cell masks rather than per-dot gradients: the masks depend
 * only on geometry, so a redraw is a handful of drawImage calls regardless of panel size.
 */

/** Reusable scratch surfaces. These calls never overlap, so one of each is enough. */
const surfaces = new Map();

function surface(name, w, h) {
  let canvas = surfaces.get(name);
  if (!canvas) surfaces.set(name, (canvas = document.createElement('canvas')));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas;
}

/**
 * Full-panel alpha mask: one soft dot per cell, opaque out to `solid`, faded to nothing by `reach`.
 *
 * Built by tiling a single sprite — 2,668 `createRadialGradient` calls would not be free, one is.
 * Cached on geometry, so dragging the crop slider does not rebuild it.
 */
const maskCache = new Map();

function dotMask(key, { W, H, cols, rows, pitch, solid, reach }) {
  const signature = `${W}x${H}:${cols}x${rows}:${pitch.toFixed(3)}:${solid}:${reach}`;
  const cached = maskCache.get(key);
  if (cached?.signature === signature) return cached.canvas;

  const size = Math.max(4, Math.ceil(pitch));
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d');
  const mid = size / 2;
  const inner = Math.max(0.01, (size * solid) / 2);
  const outer = Math.max(inner + 0.01, (size * Math.min(1, reach)) / 2);

  const grad = sctx.createRadialGradient(mid, mid, inner, mid, mid, outer);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, size, size);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const mctx = canvas.getContext('2d');
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      mctx.drawImage(sprite, x * pitch, y * pitch, pitch, pitch);
    }

  maskCache.set(key, { signature, canvas });
  return canvas;
}

/**
 * The panel's tone response, as a 256-entry LUT.
 *
 *   lift      raises midtones. 0 stays 0 and 1 stays 1, so blacks stay black — this brightens
 *             without flattening the dark end, which is the part the hardware gets right.
 *   knee      where highlight compression starts.
 *   squash    how hard everything above the knee is crushed together. This is the deliberately
 *             *unflattering* part: it reproduces bright shades arriving indistinguishable.
 *   toe       pulls the bottom of the range down, undoing the shadow lift that `lift` brings with
 *             it. Applied as a multiplier that reaches exactly 1 at `toeEnd`, so it deepens the
 *             darks without touching a single value above that point — the highlights are safe by
 *             construction, not by tuning.
 *   toeEnd    where the toe stops having any effect.
 */
function toneCurve({ lift, knee, squash, toe, toeEnd }) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = (i / 255) ** (1 / lift);
    if (v > knee) v = knee + (v - knee) * (1 - squash);
    if (toe > 0 && v < toeEnd) v *= (v / toeEnd) ** toe;
    lut[i] = Math.max(0, Math.min(255, Math.round(255 * v)));
  }
  return lut;
}

let lutCache = { key: '', lut: null };

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * @param canvas   the destination <canvas>
 * @param colorAt  (x, y) => [r, g, b]
 */
export function drawLedMatrix(canvas, colorAt, {
  width,
  height,
  cssWidth,

  /** Diameter of each LED's fully-lit centre, as a fraction of the pitch. */
  dotRatio = 0.34,
  /**
   * How far a dot's glow reaches, as a fraction of the pitch — the knob that makes this bright.
   * Capped at 1: at exactly 1 the light dies precisely at the cell boundary, which is the most
   * brightness available with zero bleed into the neighbouring LED.
   */
  reach = 1,

  /** Midtone lift. See toneCurve. */
  lift = 1.9,
  /** Where highlights start converging. */
  knee = 0.62,
  /** How hard they converge. Raise it if the real panel looks flatter than the preview. */
  squash = 0.25,
  /** Shadow depth. Higher crushes the darks further; 0 leaves them where `lift` put them. */
  toe = 1.7,
  /** Values above this are untouched by the toe, so highlights can't be affected by it. */
  toeEnd = 0.5,
  /**
   * Colour boost, applied after the tone curve and pivoted on luma, so it saturates without
   * changing how bright anything is. 1 = the source's own colour.
   */
  saturation = 1.1,

  /**
   * A second, additive dose of the cell's own colour in the middle, 0-1.
   *
   * Additive, so a bright LED's centre blows out toward white the way the panel does, while a dim
   * one only gets a hotter middle and keeps its hue. Confined to the centre of the cell, so it buys
   * that brightness without touching the gaps.
   */
  core = 0.8,
  /**
   * Global blur across the whole panel. Unlike everything above, this DOES cross cells — off by
   * default. A little reads as room glow; a lot destroys the preview's usefulness.
   */
  bloom = 0,
  background = '#050508',
} = {}) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const pitchCss = Math.max(2, (cssWidth ?? canvas.clientWidth ?? 240) / width);
  const w = Math.round(width * pitchCss);
  const h = Math.round(height * pitchCss);

  // Everything below works in device pixels under an identity transform: the masks have to line up
  // with the dot grid exactly, and a scaled transform would resample them into moiré.
  const pitch = pitchCss * dpr;
  const W = Math.round(width * pitch);
  const H = Math.round(height * pitch);

  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);

  // 1. the panel's pixels, through the response curve, into a width x height image
  const lutKey = `${lift}:${knee}:${squash}:${toe}:${toeEnd}`;
  if (lutCache.key !== lutKey) {
    lutCache = { key: lutKey, lut: toneCurve({ lift, knee, squash, toe, toeEnd }) };
  }
  const lut = lutCache.lut;

  const small = surface('small', width, height);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const lr = lut[r & 255];
      const lg = lut[g & 255];
      const lb = lut[b & 255];
      // Pivot on luma: pushing colours away from their own brightness saturates them without
      // making anything lighter or darker, so this can't undo the tone curve above.
      const luma = 0.299 * lr + 0.587 * lg + 0.114 * lb;
      const i = (y * width + x) * 4;
      img.data[i] = clamp255(luma + (lr - luma) * saturation);
      img.data[i + 1] = clamp255(luma + (lg - luma) * saturation);
      img.data[i + 2] = clamp255(luma + (lb - luma) * saturation);
      img.data[i + 3] = 255;
    }
  sctx.putImageData(img, 0, 0);

  // 2. blow it up to one flat block per cell, then punch the dot shape out of it. Nearest-neighbour
  //    is essential — smoothing would blend colour between cells before the mask is applied.
  const geometry = { W, H, cols: width, rows: height, pitch };
  const layer = surface('layer', W, H);
  const lctx = layer.getContext('2d');

  const stamp = (mask) => {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.clearRect(0, 0, W, H);
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(small, 0, 0, W, H);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(mask, 0, 0);
  };

  stamp(dotMask('halo', { ...geometry, solid: dotRatio, reach }));
  ctx.drawImage(layer, 0, 0);

  // 3. the hot core: the same colours again, additively, through a much tighter mask
  if (core > 0) {
    stamp(dotMask('core', { ...geometry, solid: dotRatio * 0.4, reach: dotRatio * 1.2 }));
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = core;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // 4. optional room glow — the only pass that crosses cells
  if (bloom > 0) {
    ctx.save();
    ctx.globalAlpha = bloom;
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${Math.max(1, pitch * 0.6)}px)`;
    ctx.drawImage(small, 0, 0, W, H);
    ctx.restore();
  }
}

/** Flat pixel render — for thumbnails too small for dots to read as dots. */
export function drawFlat(canvas, colorAt, { width, height, cssWidth = 96 }) {
  const scale = Math.max(1, Math.round(cssWidth / width));
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  const small = surface('flat', width, height);
  small.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

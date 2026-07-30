/**
 * Source images and the transform that maps one onto the panel.
 *
 * The gallery stores the ORIGINAL image plus a {mode, zoom, offsetX, offsetY} transform, never the
 * 46x58 result. Two reasons: the crop stays editable forever, and panel geometry is a setting — bake
 * the result in and changing the width or height would silently re-crop every image you own.
 *
 * Originals are capped at STORE_MAX_SIDE before storage. localStorage is a ~5 MB budget shared with
 * everything else, and a phone photo as a data URL is bigger than that on its own.
 */

const STORE_MAX_SIDE = 384;
const STORE_QUALITY = 0.85;

export const DEFAULT_TRANSFORM = { mode: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode that image'));
    img.src = src;
  });
}

/** Does this image actually use its alpha channel? PNG-with-transparency must not become JPEG. */
function hasAlpha(img, canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** A File -> a data URL small enough to keep in localStorage, still big enough to re-crop. */
export async function fileToStorableImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, STORE_MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return hasAlpha(img, canvas)
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', STORE_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Where the source image lands on the panel, in panel pixels.
 *
 * `cover` fills the panel and crops the overflow; `contain` shows the whole image and leaves black.
 * `zoom` multiplies whichever base fit was chosen, and the offsets are fractions of the panel size so
 * a transform survives a change of panel geometry.
 */
export function placement(img, transform, { width, height }) {
  const t = { ...DEFAULT_TRANSFORM, ...transform };
  const fit = t.mode === 'contain'
    ? Math.min(width / img.width, height / img.height)
    : Math.max(width / img.width, height / img.height);
  const scale = fit * t.zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  return {
    w,
    h,
    x: (width - w) / 2 + t.offsetX * width,
    y: (height - h) / 2 + t.offsetY * height,
  };
}

/**
 * Rasterise an image through its transform down to exactly width x height panel pixels.
 *
 * Returns a colorAt(x, y) — the single shape every consumer here wants, whether it's the payload
 * builder, a thumbnail or the LED preview.
 */
export function rasterise(img, transform, geometry) {
  const { width, height } = geometry;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const { x, y, w, h } = placement(img, transform, geometry);
  ctx.drawImage(img, x, y, w, h);

  const { data } = ctx.getImageData(0, 0, width, height);
  return (px, py) => {
    const i = (py * width + px) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}

/** A gallery entry's source, tolerating entries written before originals were kept. */
export const sourceOf = (item) => item.src ?? item.dataUrl;

/**
 * Decode once per source.
 *
 * A gallery of twenty images redraws its thumbnails on every geometry change and on every reorder;
 * re-decoding the same data URLs each time is the difference between instant and visibly janky.
 */
const decoded = new Map();

export function loadCached(src) {
  if (!decoded.has(src)) {
    decoded.set(src, loadImage(src).catch((err) => {
      decoded.delete(src); // a failure should not be cached forever
      throw err;
    }));
  }
  return decoded.get(src);
}

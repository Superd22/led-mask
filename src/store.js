/**
 * Tiny localStorage-backed stores.
 *
 * The mask cannot be queried — nothing in the protocol reports what is in a DIY slot, what image 7
 * looks like, or even how many slots are populated. So the app has to own that inventory, and it has
 * to survive a reload. That is all this is: a persisted value plus a subscribe hook.
 *
 * Writes are best-effort. A quota error must never take the control surface down with it, so it is
 * logged and swallowed; the in-memory value stays correct for the session.
 */
import { useEffect, useState } from 'preact';
import { DIY_WIDTH, DIY_HEIGHT } from './mask-protocol.js';

const PREFIX = 'led-mask:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function createStore(key, initial) {
  let value = read(key, initial);
  const listeners = new Set();

  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (err) {
        console.warn(`could not persist ${key}:`, err.message);
      }
      listeners.forEach((fn) => fn(value));
      return value;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Subscribe a component to a store. Returns [value, set]. */
export function useStore(store) {
  const [value, setValue] = useState(store.get());
  useEffect(() => store.subscribe(setValue), [store]);
  return [value, store.set];
}

// ---------------------------------------------------------------- the app's stores

/**
 * User-given names for built-in content, keyed `IMAG:3` / `ANIM:7`.
 *
 * Factory images have no names and cannot be previewed, so the only way to know what index 7 is, is
 * to look at the mask once and write it down. This is where that goes.
 */
export const labels = createStore('labels', {});

/** Gallery of DIY images: [{ id, name, dataUrl, createdAt }]. dataUrl is a 46x58 PNG. */
export const gallery = createStore('gallery', []);

/** What we believe is in each DIY slot: { [slot]: galleryItemId }. Written after a successful upload. */
export const slotInventory = createStore('slots', {});

/** Sticky UI state that is annoying to re-pick every reload. */
export const prefs = createStore('prefs', { tab: 'prebuilt' });

/**
 * Panel geometry and byte order.
 *
 * Nothing in the protocol reports these, and vendor models differ (Lumen Couture panels are not the
 * same size), so they are settings rather than constants. The defaults are what MASK-9C2F6A does:
 * 46x58, column-major, both confirmed on hardware.
 */
export const device = createStore('device', {
  width: DIY_WIDTH,
  height: DIY_HEIGHT,
  columnMajor: true,
});

/** Everything that reads geometry goes through this, so a bad stored value can't render nothing. */
export function panelGeometry(settings) {
  const clamp = (n, fallback) =>
    Number.isFinite(n) && n >= 1 && n <= 255 ? Math.round(n) : fallback;
  return {
    width: clamp(settings?.width, DIY_WIDTH),
    height: clamp(settings?.height, DIY_HEIGHT),
    columnMajor: settings?.columnMajor !== false,
  };
}

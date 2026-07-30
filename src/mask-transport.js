/**
 * Web Bluetooth transport for the mask.
 *
 * Keeps mask-protocol.js transport-agnostic: everything browser-specific lives here. Emits events so
 * the UI can log every byte in both directions — this is a test harness first, an app second.
 *
 * Events (CustomEvent, `detail` as noted):
 *   'status'  {state, message}      state: 'disconnected'|'connecting'|'connected'
 *   'log'     {dir, label, hex, text, level}
 */
import {
  SERVICE_UUID,
  CHARACTERISTIC,
  NAME_PREFIX,
  parseNotification,
  uploadSequence,
  imageUploadSequence,
} from './mask-protocol.js';

const NOTIFY_TIMEOUT_MS = 5000;

export class MaskTransport extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.chars = { command: null, notify: null, upload: null };
    this.state = 'disconnected';
    /** Queue of resolvers waiting on the next notification (used by the upload handshake). */
    this._waiters = [];
    /** Coalescing writer: one write in flight, latest value wins. Design rule 3. */
    this._pending = null;
    this._writing = false;
  }

  get connected() {
    return this.state === 'connected' && this.server?.connected;
  }

  log(dir, label, bytes, text, level = 'info') {
    this.dispatchEvent(
      new CustomEvent('log', {
        detail: {
          dir,
          label,
          hex: bytes ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ') : '',
          text: text ?? '',
          level,
          at: new Date().toLocaleTimeString(),
        },
      }),
    );
  }

  _setState(state, message = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }

  /**
   * Show the chooser and connect. Needs a user gesture.
   *
   * `acceptAll` is the debugging escape hatch: the mask is reported to advertise the fff0 service and
   * a MASK* name, but vendor models vary (e.g. Lumen Couture), so being able to see every device is
   * worth having in a test harness.
   */
  async requestAndConnect({ acceptAll = false } = {}) {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable — use Chrome, over HTTPS.');

    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE_UUID] };

    this.log('sys', `requestDevice(${acceptAll ? 'acceptAllDevices' : `namePrefix ${NAME_PREFIX}`})`);
    const device = await navigator.bluetooth.requestDevice(options);

    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.log('sys', `${device.name || 'device'} disconnected`, null, '', 'warn');
      this._rejectWaiters(new Error('disconnected'));
      this._setState('disconnected');
    });

    await this.connect();
  }

  /**
   * Open GATT on the already-permitted device. No user gesture required, which is what makes
   * mid-session reconnect free.
   */
  async connect() {
    if (!this.device) throw new Error('no device — hit Connect first');
    this._setState('connecting', this.device.name || '');
    this.log('sys', `connecting to ${this.device.name || '(unnamed)'}…`);

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    this.chars.command = await service.getCharacteristic(CHARACTERISTIC.command);
    this.chars.notify = await service.getCharacteristic(CHARACTERISTIC.notify);
    this.chars.upload = await service.getCharacteristic(CHARACTERISTIC.upload);

    this.chars.notify.addEventListener('characteristicvaluechanged', (e) =>
      this._onNotification(e.target.value),
    );
    await this.chars.notify.startNotifications();

    this.log('sys', 'connected, notifications on', null, '', 'ok');
    this._setState('connected', this.device.name || '');
  }

  disconnect() {
    this._rejectWaiters(new Error('disconnected'));
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this._setState('disconnected');
  }

  async _onNotification(dataView) {
    const bytes = new Uint8Array(dataView.buffer.slice(0));
    let parsed = '';
    try {
      parsed = await parseNotification(bytes);
      // Render trailing non-printable bytes numerically — CHEC replies with a count byte there.
      const extra = [...parsed].slice(4).map((c) => c.charCodeAt(0));
      const printable = parsed.replace(/[^\x20-\x7e]/g, '');
      if (extra.some((c) => c < 0x20 || c > 0x7e || /[^A-Z]/.test(String.fromCharCode(c)))) {
        parsed = `${printable} [${extra.map((c) => `0x${c.toString(16)}=${c}`).join(' ')}]`;
      }
    } catch (err) {
      parsed = `<decrypt failed: ${err.message}>`;
    }
    this.log('in', 'notify', bytes, parsed, 'ok');

    const waiter = this._waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    }
  }

  /** Arm a waiter BEFORE writing, so a fast response can't arrive before we're listening. */
  _nextNotification() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        reject(new Error(`no notification within ${NOTIFY_TIMEOUT_MS}ms`));
      }, NOTIFY_TIMEOUT_MS);
      this._waiters.push(waiter);
    });
  }

  _rejectWaiters(err) {
    const waiters = this._waiters;
    this._waiters = [];
    waiters.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(err);
    });
  }

  async _write(characteristicUuid, bytes, label) {
    if (!this.connected) throw new Error('not connected');
    const which = Object.entries(CHARACTERISTIC).find(([, v]) => v === characteristicUuid)?.[0];
    const char = this.chars[which];
    if (!char) throw new Error(`unknown characteristic ${characteristicUuid}`);
    this.log('out', label || which, bytes);
    await char.writeValue(bytes);
  }

  /** Send an encrypted command. `bytesOrPromise` is whatever command.* returned. */
  async sendCommand(bytesOrPromise, label) {
    return this._write(CHARACTERISTIC.command, await bytesOrPromise, label);
  }

  /** Write plaintext bytes straight to the bulk upload characteristic. */
  async sendUploadRaw(bytes, label) {
    return this._write(CHARACTERISTIC.upload, bytes, label || 'upload(raw)');
  }

  /**
   * Coalescing send for high-rate paths (the visualizer). Keeps exactly one write in flight and only
   * the newest pending value; superseded values are dropped rather than queued, so the GATT queue
   * can't back up and drift behind the music.
   */
  queueCommand(bytesOrPromise, label) {
    this._pending = { bytesOrPromise, label };
    if (this._writing) return;
    this._drain();
  }

  async _drain() {
    this._writing = true;
    try {
      while (this._pending && this.connected) {
        const { bytesOrPromise, label } = this._pending;
        this._pending = null;
        await this._write(CHARACTERISTIC.command, await bytesOrPromise, label);
      }
    } catch (err) {
      this.log('sys', `queued write failed: ${err.message}`, null, '', 'error');
    } finally {
      this._writing = false;
    }
  }

  /**
   * Run the full upload handshake: DATS -> DATSOK -> (packet -> REOK)* -> DATCP -> DATCPOK.
   * Drives the generator from mask-protocol.js and feeds it real notifications.
   */
  /** Upload a full-face DIY image into a persistent slot. */
  async uploadImage(payload, slot, { onProgress, unixSeconds = Math.floor(Date.now() / 1000) } = {}) {
    return this._runUpload(imageUploadSequence(payload, slot, unixSeconds), onProgress);
  }

  async upload(payload, bitmapLength, { trailing = 0, onProgress } = {}) {
    return this._runUpload(uploadSequence(payload, bitmapLength, trailing), onProgress);
  }

  async _runUpload(run, onProgress) {
    let step = run.next();
    let n = 0;
    while (!step.done) {
      const { characteristic, data } = step.value;
      const bytes = await data;
      const waiter = this._nextNotification(); // armed before the write, deliberately
      await this._write(characteristic, bytes, characteristic === CHARACTERISTIC.upload ? `pkt ${n}` : undefined);
      if (characteristic === CHARACTERISTIC.upload) n++;
      const response = await waiter;
      onProgress?.(n, response);
      step = run.next(response);
    }
    return n;
  }
}

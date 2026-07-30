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
    this.chars = { command: null, notify: null, upload: null, spectrum: null };
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

    // Enumerate everything rather than only fetching the three UUIDs we knew about. A capture of the
    // official app's visualizer showed it writing to a FOURTH characteristic in this service that no
    // public source documents, so discover it instead of assuming.
    const all = await service.getCharacteristics();
    const known = new Set(Object.values(CHARACTERISTIC));
    for (const c of all) {
      const props = Object.entries(c.properties)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(',');
      const label = known.has(c.uuid) ? '' : '  <-- UNDOCUMENTED';
      this.log('sys', `char ${c.uuid} [${props}]${label}`, null, '', known.has(c.uuid) ? 'info' : 'ok');
    }

    const byUuid = new Map(all.map((c) => [c.uuid, c]));
    this.chars.command = byUuid.get(CHARACTERISTIC.command);
    this.chars.notify = byUuid.get(CHARACTERISTIC.notify);
    this.chars.upload = byUuid.get(CHARACTERISTIC.upload);
    if (!this.chars.command || !this.chars.notify || !this.chars.upload) {
      throw new Error('expected characteristics missing from the fff0 service');
    }

    // The visualizer stream target: the writable characteristic that is not one of the three known
    // ones. Falls back to the command characteristic so the feature degrades rather than breaking.
    const extra = all.filter(
      (c) => !known.has(c.uuid) && (c.properties.writeWithoutResponse || c.properties.write),
    );
    this.chars.spectrum = extra[0] ?? this.chars.command;
    if (extra.length) {
      this.log('sys', `visualizer -> ${extra[0].uuid}`, null, '', 'ok');
      if (extra.length > 1) {
        this.log('sys', `${extra.length} undocumented writable chars; using the first`, null, '', 'warn');
      }
    } else {
      this.log('sys', 'no undocumented characteristic found; visualizer may not work', null, '', 'warn');
    }

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

  /**
   * Fire-and-forget write for the visualizer stream. The official app uses ATT Write Command (no
   * response) at ~10 Hz; awaiting a response per frame would halve the achievable rate.
   * Silent by default — logging 10 frames/sec would bury everything else.
   */
  async sendSpectrum(bytesOrPromise) {
    if (!this.connected) throw new Error('not connected');
    const char = this.chars.spectrum;
    if (!char) throw new Error('no visualizer characteristic');
    const bytes = await bytesOrPromise;
    if (char.properties?.writeWithoutResponse && char.writeValueWithoutResponse) {
      await char.writeValueWithoutResponse(bytes);
    } else {
      await char.writeValue(bytes);
    }
    // Heartbeat so the log shows the stream is alive without burying everything at 10 frames/sec.
    this._specCount = (this._specCount ?? 0) + 1;
    const now = performance.now();
    if (!this._specLogAt || now - this._specLogAt > 2000) {
      this._specLogAt = now;
      this.log('out', `spectrum x${this._specCount}`, bytes);
    }
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

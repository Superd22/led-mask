/**
 * The device button: connection state, and the two things about the panel the protocol can't tell us.
 *
 * Panel size and byte order have to be settings rather than constants. The mask has no "describe
 * yourself" verb — we know 46x58 column-major because it was measured on MASK-9C2F6A, and vendor
 * models differ. Getting either wrong produces a recognisable failure (a stripe, a partial
 * rectangle), so they belong somewhere findable but out of the way: behind the status pill, next to
 * Connect, which is the one control everyone already looks for.
 */
import { html, useState, useEffect } from 'preact';
import { mask } from './mask.js';
import { Btn } from './ui-kit.js';
import { device, panelGeometry, useStore } from './store.js';

const STATE_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Connect',
};

export function DeviceMenu({ status }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [settings, setSettings] = useStore(device);
  const connected = status.state === 'connected';
  const geometry = panelGeometry(settings);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  const run = async (fn) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      // A cancelled chooser is a normal outcome, not an error worth showing.
      if (!/cancel|user/i.test(e.message)) setErr(e.message);
    }
  };

  const setSize = (key) => (e) => {
    const n = Math.max(1, Math.min(255, Math.round(+e.target.value) || 0));
    setSettings({ ...settings, [key]: n });
  };

  return html`
    <div class="device">
      <button
        class=${`status-pill ${status.state}`}
        onClick=${() => setOpen(!open)}
        aria-expanded=${open}
        title=${status.message || 'Connection and panel settings'}
      >
        <span class="led"></span>
        <span class="pill-text">
          ${connected ? (status.message || STATE_LABEL.connected) : STATE_LABEL[status.state]}
        </span>
        <span class="caret">▾</span>
      </button>

      ${open && html`
        <div class="scrim" onClick=${() => setOpen(false)}></div>
        <div class="popover" role="dialog" aria-label="Device">
          <div class="pop-section">
            <span class="field-label">Connection<b>${status.state}</b></span>
            <div class="chips">
              ${connected
                ? html`<${Btn} onClick=${() => mask.disconnect()}>Disconnect<//>`
                : html`
                    <${Btn} kind="go" onClick=${() =>
                      run(() => (mask.device ? mask.connect() : mask.requestAndConnect()))}>
                      ${mask.device ? 'Reconnect' : 'Connect'}
                    <//>
                    <${Btn} onClick=${() => run(() => mask.requestAndConnect())}>Pick another<//>
                    <${Btn} onClick=${() => run(() => mask.requestAndConnect({ acceptAll: true }))}>
                      Scan all
                    <//>
                  `}
            </div>
            ${status.message && html`<p class="hint">${status.message}</p>`}
            ${err && html`<p class="banner err">${err}</p>`}
            ${!navigator.bluetooth && html`
              <p class="banner err">
                This browser can't do Web Bluetooth. Use Chrome on desktop or Android, over HTTPS —
                iOS cannot do it at all, in any browser.
              </p>
            `}
          </div>

          <div class="pop-section">
            <span class="field-label">Panel<b>${geometry.width} x ${geometry.height}</b></span>
            <div class="chips">
              <label class="mini">
                Width
                <input type="number" min="1" max="255" value=${geometry.width}
                  onInput=${setSize('width')} />
              </label>
              <label class="mini">
                Height
                <input type="number" min="1" max="255" value=${geometry.height}
                  onInput=${setSize('height')} />
              </label>
            </div>
            <div class="chips">
              ${[
                { value: true, label: 'Column-major' },
                { value: false, label: 'Row-major' },
              ].map((o) => html`
                <button
                  key=${String(o.value)}
                  class=${`chip ${geometry.columnMajor === o.value ? 'on' : ''}`}
                  onClick=${() => setSettings({ ...settings, columnMajor: o.value })}
                >${o.label}</button>
              `)}
            </div>
            <p class="hint">
              46 x 58, column-major, is what this mask does — measured on hardware. Change these only
              for a different model. The <b>corners</b> test pattern in DIY confirms both at once.
            </p>
            <div class="chips">
              <button class="ghost" onClick=${() =>
                setSettings({ width: 46, height: 58, columnMajor: true })}>
                Reset to 46 x 58
              </button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

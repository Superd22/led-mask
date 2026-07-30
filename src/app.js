/**
 * The app shell: connect, then one panel at a time.
 *
 * Two UIs share one transport. This is the friendly one — four panels in the order you actually
 * reach for them. The reverse-engineering harness that produced the protocol is still here, behind
 * the "Dev" button, unsimplified; see ./dev-ui.js.
 */
import { html, render, useState, useEffect, useCallback } from 'preact';
import { mask } from './mask.js';
import { command } from './mask-protocol.js';
import { DevUi, Log } from './dev-ui.js';
import { DeviceMenu } from './device-menu.js';
import { PrebuiltPanel } from './panels/prebuilt.js';
import { SoundPanel } from './panels/sound.js';
import { TextPanel } from './panels/text.js';
import { DiyPanel } from './panels/diy.js';
import { prefs, useStore } from './store.js';

const TABS = [
  { id: 'prebuilt', label: 'Prebuilt', icon: '▦', Panel: PrebuiltPanel },
  { id: 'sound', label: 'Sound', icon: '≋', Panel: SoundPanel },
  { id: 'text', label: 'Text', icon: 'A', Panel: TextPanel },
  { id: 'diy', label: 'DIY', icon: '✦', Panel: DiyPanel },
];

function TopBar({ status, dev, setDev }) {
  return html`
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>Shining Mask</span>
      </div>
      <${DeviceMenu} status=${status} />
      <button class=${`ghost dev-toggle ${dev ? 'on' : ''}`} onClick=${() => setDev(!dev)}>
        ${dev ? 'Close dev' : 'Dev'}
      </button>
    </header>
  `;
}

/** Brightness is global — it applies to whatever is showing, so it lives outside the panels. */
function QuickBar() {
  const [light, setLight] = useState(150);
  return html`
    <div class="quickbar">
      <span>☀</span>
      <input
        type="range" min="0" max="255" value=${light}
        onInput=${(e) => setLight(+e.target.value)}
        onChange=${() => mask.sendCommand(command.brightness(light), `LIGHT ${light}`)}
      />
      <output>${light}</output>
    </div>
  `;
}

function App() {
  const [status, setStatus] = useState({ state: 'disconnected', message: '' });
  const [entries, setEntries] = useState([]);
  const [settings, setSettings] = useStore(prefs);
  const [dev, setDev] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    const onStatus = (e) => setStatus(e.detail);
    const onLog = (e) => setEntries((prev) => [...prev.slice(-400), e.detail]);
    mask.addEventListener('status', onStatus);
    mask.addEventListener('log', onLog);
    return () => {
      mask.removeEventListener('status', onStatus);
      mask.removeEventListener('log', onLog);
    };
  }, []);

  // The hash wins over the stored tab, so a link like #sound opens on that panel.
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const onHash = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const clear = useCallback(() => setEntries([]), []);
  const connected = status.state === 'connected';
  const tab =
    TABS.find((t) => t.id === hash) ?? TABS.find((t) => t.id === settings.tab) ?? TABS[0];

  const pickTab = (id) => {
    setSettings({ ...settings, tab: id });
    location.hash = id;
    setHash(id);
  };

  if (dev) {
    return html`
      <${TopBar} status=${status} dev=${dev} setDev=${setDev} />
      <main class="shell">
        <${DevUi} status=${status} entries=${entries} onClear=${clear} />
      </main>
    `;
  }

  return html`
    <${TopBar} status=${status} dev=${dev} setDev=${setDev} />
    ${connected && html`<${QuickBar} />`}

    <nav class="tabs" role="tablist">
      ${TABS.map((t) => html`
        <button
          key=${t.id}
          role="tab"
          aria-selected=${t.id === tab.id}
          class=${`tab ${t.id === tab.id ? 'on' : ''}`}
          onClick=${() => pickTab(t.id)}
        >
          <span class="tab-icon">${t.icon}</span>
          <span class="tab-label">${t.label}</span>
        </button>
      `)}
    </nav>

    <main class=${`shell ${connected ? '' : 'offline'}`}>
      ${!connected && html`
        <p class="banner">Connect the mask to send anything — you can still set things up offline.</p>
      `}
      <${tab.Panel} key=${tab.id} />
    </main>

    <footer class="footer">
      <button class="ghost" onClick=${() => setShowLog(!showLog)}>
        ${showLog ? 'Hide' : 'Show'} log (${entries.length})
      </button>
      <a href="https://github.com/Superd22/led-mask">Source & protocol notes</a>
    </footer>
    ${showLog && html`<div class="log-drawer"><${Log} entries=${entries} onClear=${clear} /></div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));

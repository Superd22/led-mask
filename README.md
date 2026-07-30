# led-mask

Controlling a **Shining Mask** (BLE LED face mask) from the browser.

**Live: https://superd22.github.io/led-mask/** — a control surface working against real hardware
(`MASK-9C2F6A`). No build step: native ESM plus a vendored 13 KB Preact+htm, so the source deploys
straight to GitHub Pages.

Four panels — **Prebuilt**, **Sound**, **Text**, **DIY** — plus the original reverse-engineering
harness behind the **Dev** button, which still exposes every verb and every open question.

Along the way this became the most complete public description of the mask's protocol. Several things
here appear in no other source — see [Discoveries](#discoveries-not-in-any-public-source).

## Status

**Working, on hardware:**

- Discovery, connect, reconnect. Unbonded, no OS pairing.
- Built-in images and animations (`IMAG` / `ANIM`), brightness, speed, scroll modes.
- **Full-colour 46 × 58 DIY images** uploaded into persistent slots from a file or a generated
  pattern, then recalled with `PLAY`.
- Live text/bitmap upload into the 16-row text band, with per-column colour.
- Colour via `FC` (~11 ms per change).
- **The native sound visualizer** — mic or local audio file → FFT → 24 bands → the mask's own
  renderer, 5 effects, up to 50 Hz.
- Raw command console and a decrypted log of every byte in both directions.
- Capture decoders for Bluetooth HCI snoop logs.

**Not built yet:**

- **Role B — the MIDI relay.** Ableton → IAC bus → `requestMIDIAccess()` → mask. This was the
  original goal and none of it exists yet; everything it needs is in place.
- PWA polish: no service worker, so no offline use, and no screen wake lock.
- Untethered operation — see the deferred options in [`docs/architecture.md`](docs/architecture.md).

Panel geometry (46 x 58) and pixel order (column-major) are **device settings**, not constants —
nothing in the protocol reports them and vendor models differ. Both live behind the status pill.

## Repo map

| Path | What |
|---|---|
| [`docs/protocol.md`](docs/protocol.md) | **Start here.** The protocol, with a hardware-findings table that supersedes everything, plus per-claim sources and confidence. |
| [`docs/architecture.md`](docs/architecture.md) | Platform decision, design rules, connection UX, visualizer plan, deferred untethered options. |
| [`src/mask-protocol.js`](src/mask-protocol.js) | Pure encoding: commands, both upload modes, the visualizer stream, AES-ECB workarounds. Touches no browser API. |
| [`src/mask-transport.js`](src/mask-transport.js) | Web Bluetooth: connect, characteristic discovery, the upload state machine, the coalescing/dropping writers. |
| [`src/app.js`](src/app.js) | Shell: connect bar, tabs, global brightness, dev toggle, log drawer. |
| [`src/panels/`](src/panels/) | The four panels. One file each, no shared state between them. |
| [`src/audio-engine.js`](src/audio-engine.js) | FFT → 24 bands: log spacing, dB window, spectral tilt, attack/decay. Shared by both UIs. |
| [`src/image.js`](src/image.js) + [`src/led-preview.js`](src/led-preview.js) | Crop transforms, rasterising to panel pixels, and the LED-matrix renderer. |
| [`src/store.js`](src/store.js) | localStorage stores: gallery, slot inventory, panel geometry. The mask can't be queried, so this is the only record of what's in a slot. |
| [`src/device-menu.js`](src/device-menu.js) | The status pill: connect/disconnect plus panel size and pixel order. |
| [`src/ui-kit.js`](src/ui-kit.js) | Shared helpers and components. |
| [`src/dev-ui.js`](src/dev-ui.js) | The original harness — every verb, every experiment, the wire log. |
| [`src/styles.css`](src/styles.css) + [`index.html`](index.html) | Styling and the entry point. |
| [`src/mask-protocol.test.mjs`](src/mask-protocol.test.mjs) | `node src/mask-protocol.test.mjs` — 46 assertions against real AES and against decrypted captures of the official app. |
| [`tools/decode-capture.mjs`](tools/decode-capture.mjs) | Decode an HCI capture into a transcript; flags unknown verbs, dumps upload payloads. |
| [`tools/decode-viz.mjs`](tools/decode-viz.mjs) | Session analyser for high-rate streams: segments on idle gaps, per-byte statistics, decodes the visualizer. |
| [`tools/lib/btsnoop.mjs`](tools/lib/btsnoop.mjs) | Shared btsnoop/HCI/L2CAP/ATT parsing and frame decoding. |

## Working on it

```bash
python3 -m http.server 8765          # any static server; Web Bluetooth needs HTTPS or localhost
node src/mask-protocol.test.mjs      # no deps, no framework
```

Deploy is `git push` — GitHub Pages serves `main` at root. `.nojekyll` is required (Jekyll would eat
`_`-prefixed paths). Use relative imports only; absolute paths break under the `/led-mask/` subpath.

**Web Bluetooth needs Chrome** on desktop or Android, over HTTPS. iOS cannot do this at all — WebKit
implements neither Web Bluetooth nor Web MIDI, and iOS forces every browser onto WebKit.

### Capturing the official app

The remaining unknowns are best settled by watching the real app:

1. Developer options → **Bluetooth HCI snoop log → Enabled** (*not* Filtered — Filtered strips ATT
   payloads and the capture is useless). Reboot.
2. Reproduce in the official app.
3. `adb bugreport bug.zip` — **leave the snoop log on**; disabling it can rotate the log away.
4. `node tools/decode-capture.mjs bug.zip` or `node tools/decode-viz.mjs bug.zip`.

Since the AES key is known, everything decrypts. Bug reports contain device logs and identifiers and
are gitignored — don't commit them.

## Discoveries not in any public source

- **The `…960b` characteristic.** A fourth characteristic in the `fff0` service, carrying the sound
  visualizer stream. A capture gives ATT handles, never UUIDs; pairing the capture with a live
  `getCharacteristics()` is what resolved handle `0x0b` to a UUID.
- **`DATS` has two modes**, selected by its 5th arg byte, which every prior source sends as `0` and
  none explains. `0x00` = text: field 2 is `bitmapLen`, payload is `[1-bit bitmap][one RGB per
  column]`, lands on the live display. `0x01` = image: field 2 is the **destination slot**, payload is
  **raw RGB 3 bytes/pixel**, and it writes a **persistent** slot.
- **The visualizer protocol**: `[0x0f][effect][12 bytes = 24 packed nibbles][00 00]`. The opcode is
  **binary, not an ASCII verb**, which is why verb-hunting never found it.
- **The panel is 46 × 58**, and `DATS` text mode only reaches a 16-row band of it.
- **DIY image pixels are column-major** — x outer, y inner. The captures could not settle this; a
  corner-marker upload on hardware did.
- **`FC`'s enable byte selects a colour source**: `1` = override with literal RGB, `0` = use the
  content's own colours. Get this wrong and uploaded colour looks broken.
- **`CHEC` works** and returns 34.
- The mask accepts visualizer frames at **50 Hz**, 5× what the official app sends.

## Gotchas that cost real time

1. **WebCrypto has no AES-ECB.** Encrypt with `AES-CBC` + zero IV, keep the first 16 bytes. Decrypt —
   which you need, because notifications are encrypted too — requires a crafted per-block padding
   block. Both are implemented and tested.
2. **You must declare the service UUID** in `requestDevice()`. Unlike bleak, you cannot write to a
   characteristic and let the stack find the service.
3. **Upload is a notification handshake**, not a paced write loop: `DATS` → `DATSOK` → (packet →
   `REOK`)\* → `DATCP` → `DATCPOK`. Don't use `writeValueWithoutResponse()` for the packets.
4. **ACKs are not health.** `DATS` with `bitmapLen = 0` soft-locks the mask — every step still ACKs
   while the display wedges. Recovery is a power cycle.
5. **The mask cannot be queried**, so the app owns its inventory of what is in which slot.
6. **`Object.entries()` on `BluetoothCharacteristicProperties` returns nothing** — the flags are
   prototype getters. Read them by name.
7. **`muted` on an `<audio>` element zeroes its `MediaElementAudioSourceNode`** — the analyser sees
   silence. Use volume instead.

## Credits

Protocol details build on public reverse-engineering work. Full source-by-source table with
confidence levels in [`docs/protocol.md`](docs/protocol.md); the main ones:

- [GoneUp/mask-go](https://github.com/GoneUp/mask-go) — working Go implementation, the most complete
  prior source and the only one implementing upload.
- [shawnrancatore/shining-mask](https://github.com/shawnrancatore/shining-mask) — working
  CircuitPython implementation; independently confirms the UUIDs and key.
- [beclamide/mask-controller](https://github.com/beclamide/mask-controller) — has no AES key and only
  replays opaque hex, so its blobs are **captures of the official app**. Decrypting them settled two
  disagreements against mask-go.
- [the r/ReverseEngineering thread](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/help_me_figure_out_how_to_reverse_engineer_the/)
  ([key comment](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/comment/h14nm39/)) —
  upstream origin of the AES key and protocol.
- [gist by Staars](https://gist.github.com/Staars/71e63e4bdefc7e3fd22377bf9c50ac12) — the notes this
  repo started from.

Nothing here is official or endorsed by the mask's manufacturer.

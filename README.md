# led-mask

Controlling a **Shining Mask** (BLE LED face mask) from the browser — a control app for the phone,
and a MIDI relay from Ableton on the Mac.

**Live: https://superd22.github.io/led-mask/** — a control surface and protocol test harness, working
against real hardware. No build step: native ESM plus a vendored 13 KB Preact+htm, so the source
deploys straight to GitHub Pages.

## Verdict: a PWA is the right fit

Chrome supports **both Web Bluetooth and Web MIDI** on desktop and Android, so one codebase covers
both use cases:

| | Chrome desktop (macOS) | Chrome Android | Safari / iOS |
|---|---|---|---|
| Web Bluetooth | yes | yes | **no** |
| Web MIDI | yes | yes | **no** |

**Role A — mobile control (Android PWA).** Parity with the official app: browse/select built-in
images, animations, brightness, speed, DIY playlists, custom uploads. Nothing needs a native API.

**Role B — MIDI relay (macOS Chrome PWA).** Ableton → IAC Driver virtual bus →
`requestMIDIAccess()` → map notes/CCs → Web Bluetooth. No native app, no CoreMIDI plumbing beyond
enabling the IAC bus.

**iOS is out.** WebKit implements neither API and iOS forces all browsers onto WebKit, so an
installed PWA on iPhone cannot do either. Target is Android; not blocking.

## Read next

- [`docs/architecture.md`](docs/architecture.md) — the decision note: roles, design rules,
  connection UX, the visualizer plan, and the deferred untethered-MIDI options
- [`docs/protocol.md`](docs/protocol.md) — the mask's BLE protocol, with a per-claim source and
  confidence table
- [`src/mask-protocol.js`](src/mask-protocol.js) — reference implementation of the command encoding,
  the upload handshake, and the AES-ECB workarounds
- [`src/mask-protocol.test.mjs`](src/mask-protocol.test.mjs) — verifies that encoding against real
  AES and against decrypted captures of the official app (`node src/mask-protocol.test.mjs`)
- [`src/mask-transport.js`](src/mask-transport.js) — Web Bluetooth layer: connect, the upload state
  machine, and the coalescing writer for high-rate paths
- [`src/app.js`](src/app.js) + [`index.html`](index.html) — the UI

## Nothing left to sniff

Both former unknowns are resolved. The primary service UUID is
`0000fff0-0000-1000-8000-00805f9b34fb` (the standard 16-bit `0xfff0`) — confirmed independently by
two working implementations, and absent from the Web Bluetooth blocklist, so Chrome will grant it:

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ namePrefix: 'MASK', services: [0xfff0] }],
  optionalServices: [0xfff0],
});
```

The mask connects **unbonded** — no OS pairing step. Best achievable UX is two taps (Connect, then
pick the mask); zero-tap auto-connect needs Chrome flags, so treat it as an enhancement rather than
the path.

## The things most likely to trip you up

1. **WebCrypto has no AES-ECB.** Encryption: `AES-CBC` with a zero IV, keep the first 16 bytes.
   Decryption — which you *do* need, because notifications are encrypted too — needs a per-block
   crafted padding block. Both are implemented and tested in
   [`src/mask-protocol.js`](src/mask-protocol.js).
2. **You must declare the service UUID** in `requestDevice()`. Web Bluetooth blocks undeclared
   services — unlike bleak, you cannot write to a characteristic and let the stack find the service.
3. **Upload is a notification handshake, not a paced write loop.** `DATS` → `DATSOK` → (packet →
   `REOK`)* → `DATCP` → `DATCPOK`. Don't use `writeValueWithoutResponse()` for the packets.
4. **`DATS` has two modes, set by its 5th arg byte.** `0x00` = text: field 2 is `bitmapLen`, payload
   is `[1-bit bitmap][one RGB per column]`, lands on the live display in a 16-row band. `0x01` =
   image: field 2 is the **destination slot**, payload is **raw RGB 3 bytes/pixel**, and it writes a
   **persistent** slot. Decoded from a capture of the official app.
5. **There is no built-in music/visualizer mode** to send packets to. Build it host-side; commands are
   ~11 ms on real hardware, so 24 Hz is comfortable. Uploads are ~300 ms, so they are not per-frame.
6. **The mask cannot be queried.** No verb lists what is on the device, so the app owns its inventory.
7. **The panel is 46 × 58** — from the capture, where `DATS` declared 8004 = 46 × 58 × 3 bytes.
8. **`FC`'s enable byte picks a colour source**: `1` = override with literal RGB, `0` = use the
   content's own colours. Getting this wrong makes uploaded colour look broken.

## Credits

Protocol details come from public reverse-engineering work. Full source-by-source table with
confidence levels in [`docs/protocol.md`](docs/protocol.md); the main ones:

- [GoneUp/mask-go](https://github.com/GoneUp/mask-go) — working Go implementation. The most complete
  source, and the only one that implements upload.
- [shawnrancatore/shining-mask](https://github.com/shawnrancatore/shining-mask) — working
  CircuitPython implementation. Independently confirms the UUIDs and key, and is the source of the
  24 Hz measurement.
- [beclamide/mask-controller](https://github.com/beclamide/mask-controller) — has no AES key and only
  replays opaque hex, so its blobs are **captures of the official app**. Decrypting them is the most
  authoritative wire-format evidence available, and it settled two disagreements against mask-go.
- [the r/ReverseEngineering thread](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/help_me_figure_out_how_to_reverse_engineer_the/)
  ([key comment](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/comment/h14nm39/)) —
  upstream origin of the AES key and protocol.
- [gist by Staars](https://gist.github.com/Staars/71e63e4bdefc7e3fd22377bf9c50ac12) — the notes this
  repo originally started from.

Nothing here is official or endorsed by the mask's manufacturer.

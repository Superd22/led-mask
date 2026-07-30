# led-mask

Controlling a **Shining Mask** (BLE LED face mask) from the browser — a control app for the phone,
and a MIDI relay from Ableton on the Mac.

Right now this repo is **research and a decision note**, not a working app. It captures the protocol,
the platform feasibility work, and the gotchas worth knowing before writing code.

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
  gotchas, and the deferred untethered-MIDI options
- [`docs/protocol.md`](docs/protocol.md) — the mask's BLE protocol as currently understood
- [`src/mask-protocol.js`](src/mask-protocol.js) — **untested** reference implementation of the
  command encoding and the AES-ECB workaround

## The two things most likely to trip you up

1. **WebCrypto has no AES-ECB.** Use `AES-CBC` with a zero IV and slice the first 16 bytes
   (discard WebCrypto's appended PKCS#7 block), or bundle aes-js. See `src/mask-protocol.js`.
2. **You must declare the service UUID** in `requestDevice()`. Web Bluetooth blocks undeclared
   services — unlike bleak, you cannot write to a characteristic and let the stack find the
   service. Sniff the primary service once via `chrome://bluetooth-internals`, then hardcode it.

## Credits

Protocol details come from public reverse-engineering work, primarily
[this gist by Staars](https://gist.github.com/Staars/71e63e4bdefc7e3fd22377bf9c50ac12).
Nothing here is official or endorsed by the mask's manufacturer.

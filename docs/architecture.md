# Platform decision: is a PWA the right fit?

_Decision note, 2026-07-30. Target device: Shining Mask (BLE)._

## Verdict

Yes. One PWA covers both use cases, because **Chrome supports Web Bluetooth AND Web MIDI** on both
desktop and Android. Same codebase, two roles selected at runtime.

Hard constraint recorded: **iOS is out.** WebKit implements neither Web Bluetooth nor Web MIDI, and
iOS forces all browsers onto WebKit, so an installed PWA on iPhone cannot do either. Confirmed
target is Android, so this is not blocking.

| Capability | Chrome desktop (macOS) | Chrome Android | Safari / iOS | Firefox |
|---|---|---|---|---|
| Web Bluetooth | yes | yes | no | no — Mozilla's position is "harmful" |
| Web MIDI | yes | yes | no | desktop yes, Android no |

## The two roles

**Role A — mobile control (Android PWA).** Feature parity with the official app: browse and select
built-in images (`IMAG`), animations (`ANIM`), brightness (`LIGHT`), speed (`SPEED`), DIY playlists
(`PLAY`), and custom uploads (`DATS` + chunked writes). Upload is the only slow path.

**Role B — MIDI relay (macOS Chrome PWA).** Ableton → IAC Driver virtual bus →
`navigator.requestMIDIAccess()` → map note/CC to mask commands → Web Bluetooth. No native app and
no CoreMIDI plumbing beyond enabling the IAC bus. Mac BLE range is ~10 m, fine when the laptop is
present.

Both roles are one app; the Mac tab can also do Role A.

## Design rules that fall out of the transport

1. **Preload, don't stream.** Upload the frame bank once over BLE, then MIDI notes only fire
   `IMAG`/`ANIM`/`PLAY` index switches. Per-beat frame upload is not viable — a full-frame push is
   many ~98-byte GATT writes, hundreds of ms to seconds.
2. **Budget ~30–100 ms** per command switch (BLE connection interval + Chrome's serialized GATT
   queue + AES). Fine for musical cues, not sample-accurate. A fixed offset is correctable with
   Ableton track delay.
3. **Coalesce and throttle** MIDI input — drop redundant switches inside a frame window rather than
   queueing them, or the GATT queue backs up and drifts behind the music.
4. **One central at a time.** The mask accepts a single BLE connection, so the phone and the Mac
   cannot both hold it. Make disconnect/handoff explicit in the UI.
5. **Keep the command encoding transport-agnostic.** Put protocol encoding in a module that doesn't
   know whether it's talking to Web Bluetooth or a WebSocket — that's what makes the untethered
   options below a transport swap rather than a rewrite.

## Known implementation gotchas

- **WebCrypto has no AES-ECB.** Use `AES-CBC` with a zero IV and slice the first 16 bytes (discard
  WebCrypto's appended PKCS#7 block), or bundle aes-js.
- **Declare the service UUID** in `requestDevice()` `filters`/`optionalServices`. Web Bluetooth
  blocks undeclared services — unlike bleak, you cannot write to a characteristic and let the stack
  find the service. Sniff it once via `chrome://bluetooth-internals`, then hardcode. Filter on
  `namePrefix: 'MASK'`.
- **No BLE or MIDI in a service worker.** Foreground tab only; take a screen wake lock so the phone
  doesn't sleep mid-set.
- **Reconnect needs a user gesture** unless `navigator.bluetooth.getDevices()` is available
  (Chromium-only, historically flag-gated behind the new permissions backend) — verify on the
  target Chrome version before designing around silent reconnect.
- Use `writeValueWithoutResponse()` for upload chunks and pace the writes.
- Web MIDI prompts for permission; only request sysex if actually needed.
- Android also needs the OS-level nearby-devices/location permission before scanning works.

## Deferred: untethered MIDI (no Mac present)

Not required today; scoped for later. Cheapest first.

1. **Mac + phone as the BLE central.** The Mac relays MIDI over WiFi (WebSocket or OSC) to the
   Android PWA, which holds the BLE link — so the mask stays in range while the Mac stays on stage.
   Small effort: a ~50-line relay on the Mac plus a WebSocket client in the PWA, reusing all the
   protocol code. Still needs the Mac, but solves range.
2. **ESP32 in a pocket.** BLE central plus DIN or USB MIDI in. Truly untethered and cheap hardware,
   but it's a C++ rewrite of the protocol layer with no code shared with the PWA. Days, not hours.
3. **Raspberry Pi Zero W.** Reuse existing Python `shining-mask` work and take MIDI in over
   rtpMIDI/WiFi. Easiest port, worst boot time and battery.

Recommendation: build the PWA now, treat untethered as a later transport swap behind the same
command layer.

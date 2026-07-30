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

**Role A — mobile control (Android PWA).** Select built-in images (`IMAG`), animations (`ANIM`),
brightness (`LIGHT`), speed (`SPEED`), DIY slots (`PLAY`), colour (`FC`/`BC`), and push live bitmaps
(`DATS` + chunked writes). Upload is the only slow path, and it cannot author DIY slots.

**Role B — MIDI relay (macOS Chrome PWA).** Ableton → IAC Driver virtual bus →
`navigator.requestMIDIAccess()` → map note/CC to mask commands → Web Bluetooth. No native app and
no CoreMIDI plumbing beyond enabling the IAC bus. Mac BLE range is ~10 m, fine when the laptop is
present.

Both roles are one app; the Mac tab can also do Role A.

## Design rules that fall out of the transport

1. **Preload, don't stream.** Upload the frame bank once over BLE, then MIDI notes only fire
   `IMAG`/`ANIM`/`PLAY` index switches. Per-frame upload is not viable: the mask gates every upload
   packet behind a `REOK` notification, so a single frame costs ~6 round trips — hundreds of ms.
2. **Index switches are good for ~24 Hz.** Measured, not estimated: shining-mask schedules an
   unconditional `PLAY` write every `1000/24` ms against real hardware. All single-block commands
   cost the same, so `PLAY`, `IMAG`, `ANIM`, `FC` and `BC` are all in budget for real animation, not
   just cues. Latency is a roughly fixed offset, correctable with Ableton track delay.
3. **Coalesce, don't queue.** Chrome serializes GATT operations, so at 24 Hz an unbounded queue
   drifts behind the music. Keep exactly one write in flight plus a single "latest desired state"
   slot, and drop superseded values.
4. **One central at a time.** The mask accepts a single BLE connection, so the phone and the Mac
   cannot both hold it. Make disconnect/handoff explicit in the UI.
5. **Keep the command encoding transport-agnostic.** Put protocol encoding in a module that doesn't
   know whether it's talking to Web Bluetooth or a WebSocket — that's what makes the untethered
   options below a transport swap rather than a rewrite.
6. **The mask cannot be queried, and we cannot author its slots.** Nothing lists what's on the device
   (see [protocol.md](protocol.md#no-way-to-enumerate-whats-on-the-device)) and uploads don't write
   slots, so the DIY bank is authored in the official app and our side keeps only a local *label* for
   each index. Treat that mapping as a user-editable guess, not a fact, and never build UI implying
   the mask was asked.

## Connection UX: how hands-off can it get?

**Achievable today: two taps.** The service UUID is known (`0xfff0`), so the chooser can be filtered
to a single entry, and the mask uses an **unbonded** GATT connection — no OS-level pairing, nothing
to configure in Bluetooth settings.

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ namePrefix: 'MASK', services: [0xfff0] }],
  optionalServices: [0xfff0],
});
```

Tap "Connect", pick the one `MASK-xxxx`, done.

**Zero taps is not available.** `requestDevice()` requires a user gesture and always shows Chrome's
picker — that picker *is* the permission grant. The APIs that would allow auto-connect on load,
`getDevices()` and `watchAdvertisements()`, are
[still behind flags in Chrome](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)
(`#enable-experimental-web-platform-features`, plus
`#enable-web-bluetooth-new-permissions-backend` for persistent permissions) years after the
[intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/lqCQ63CTKEQ). Don't design
around them — but do treat them as an opt-in enhancement behind a feature check, since enabling two
flags on your own phone and Mac is reasonable for a personal rig.

Two things make the remaining friction near-zero anyway:

- **Within a page session, reconnect is free.** The gesture buys a `BluetoothDevice` object; while
  you hold it, `device.gatt.connect()` after a `gattserverdisconnected` event needs **no new
  gesture**. Mid-set dropout recovery is fully automatic. Only a page reload costs a tap.
- **Take a screen wake lock**, so the tab stays foregrounded and one tap covers a whole set.

## Known implementation gotchas

- **WebCrypto has no AES-ECB.** For encryption, use `AES-CBC` with a zero IV and slice the first 16
  bytes (discarding WebCrypto's appended PKCS#7 block). **Decryption is harder** and you do need it,
  because the mask's notifications are encrypted too — see `decryptEcb` in
  [`../src/mask-protocol.js`](../src/mask-protocol.js) for the per-block crafted-padding trick, or
  just bundle aes-js.
- **Declare the service UUID** in `requestDevice()` `filters`/`optionalServices`. Web Bluetooth
  blocks undeclared services — unlike bleak, you cannot write to a characteristic and let the stack
  find the service. Nothing to sniff any more: it's `0xfff0`, and it is not on the Web Bluetooth
  blocklist.
- **The upload path is a notification-driven state machine**, not a paced write loop. Don't use
  `writeValueWithoutResponse()` for upload packets; wait for `REOK` between them.
- **No BLE or MIDI in a service worker.** Foreground tab only.
- Web MIDI prompts for permission; only request sysex if actually needed.
- Android also needs the OS-level nearby-devices/location permission before scanning works.

## Audio-reactive visualizer

**Solved: the mask has a native visualizer API, and it is host-driven.** The phone runs the FFT and
streams 24 band levels at ~10 Hz; the mask renders one of 5 built-in effects. See
[protocol.md](protocol.md#sound-visualizer--solved).

That is better than the host-side plan below, because the mask does the rendering: we send 16 bytes
per frame instead of driving shape and colour ourselves. The plan below is still how you would build
a *custom* visualizer that does not look like the official app's.

So the visualizer is host-side, and it's realistic within the transport budget above:

- **Author the frame bank in the official app**, then drive `PLAY` index switches from audio features
  at 12–24 Hz. Confirmed on hardware: uploads write the *live display*, not a slot, so the PWA cannot
  populate the bank itself — see
  [protocol.md](protocol.md#confirmed-on-hardware-uploads-do-not-write-diy-slots). `PLAY` is ~11 ms,
  so index switching is comfortably fast.
- **`FC` with `enable = 1` is the colour axis — confirmed on hardware**, one encrypted 16-byte write
  at ~11 ms, same cost as `PLAY`. So shape and colour are orthogonal and both run at 24 Hz: shape from
  the DIY bank, hue/brightness from the spectrum. This is the whole visualizer architecture.
- **Don't stream novel bitmaps.** That's the `DATS`/`REOK`/`DATCP` handshake — a few frames per
  second at best, and it consumes a DIY slot.
- **Where the audio comes from differs per role.** Role A (phone): `getUserMedia` mic →
  `AnalyserNode`. Role B (Ableton): prefer having Ableton do the analysis and send MIDI CC, which is
  both cheaper and sample-synced to the DAW; capturing system audio into Chrome via a loopback
  device is the fallback.
- **Colour comes from `FC`, not from the uploaded payload.** An uploaded per-column RGB is ignored on
  hardware (red rendered white). `FC` is a single 16-byte command at ~11 ms, which makes it a genuine
  second axis: shape from the frame bank, colour from the spectrum, both at 24 Hz.
- **The display is 46 columns × 16 rows** on the unit tested — measured, not documented anywhere.

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

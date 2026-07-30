# Shining Mask BLE protocol

Reverse-engineered, not official. Nothing here is endorsed by the manufacturer.

## Hardware findings

Observed on a real `MASK-9C2F6A` on 2026-07-30. **These supersede anything inferred from source code
below.** Where a claim here contradicts a source, this wins.

| Finding | Detail |
|---|---|
| **Discovery and connect work** | `namePrefix: 'MASK'` + service `0xfff0` resolves; unbonded, no OS pairing. `startNotifications()` on `…9601` succeeds. |
| **Display is 46 columns** wide, 16 high | Measured: a 32-column upload rendered as a partial rectangle. No source states this. |
| **Upload writes the LIVE display, not a DIY slot** | 20 successful uploads (every step ACKed), then `PLAY 1…3` still showed the pre-existing official-app DIY images. `DATS` carries no slot index because there is no slot to address. |
| **Uploaded per-column RGB is IGNORED** | A red fill rendered **white**. Consistent with no source ever having uploaded a non-white colour array: mask-go hardcodes `0xFFFFFF`, the official-app capture is `0xFFFFFC`. |
| **`FC` with `enable = 1` DOES set the colour** | Confirmed. This is the colour control, not the upload payload — and at ~11 ms it is 30× cheaper. Note the official app sends `enable = 0`, so that byte is doing more than a simple on/off. |
| **`PLAY` switching works** | Returns `PLAYOK` every time. DIY slots are real and persistent — but authored by the official app, not by us. |
| **Upload costs ~300–350 ms** | Measured over 20 sequential uploads at 46 columns (3 packets each). |
| **A command round trip is ~11 ms** | Single 16-byte write, e.g. `FC`. Comfortably 24 Hz. |
| **`DATS` with `bitmapLen = 0` soft-locks the mask** | Upload animation freezes; power cycle required. Every step still ACKed, so **ACKs do not mean the mask is healthy**. |
| **`CHEC` works and returns 34** | Reply frame is `[05]["CHEC"][0x22]`. So slots are countable, there are more than the 20 [cp] assumed, and the notify channel does more than upload ACKs. Makes `DELE` likely real too. |
| **⚠️ "per-column RGB is ignored" is now in doubt** | An uploaded rainbow *did* render as a pattern. If `FC`'s `enable` byte selects a colour *source* (`1` = literal override, `0` = use the content's own colours — which is what the official app always sends), then the earlier white was an active override, not a broken colour section. Being retested. |

The practical consequence: **shape and colour are separate, and both are cheap.**

| Axis | How | Cost |
|---|---|---|
| Shape | `PLAY n` over official-app-authored DIY slots, or `IMAG`/`ANIM` | ~11 ms |
| Colour | `FC` with `enable = 1` | ~11 ms |
| Your own bitmap | `DATS` upload → live display buffer, colour not controllable via payload | ~300 ms |

Both axes are comfortably 24 Hz, and they are orthogonal — which is exactly what an audio-reactive
visualizer needs. Upload is the odd one out: use it for text and one-off stills, never per frame.

## Sources

| Tag | Source | What it is |
|---|---|---|
| **[go]** | [GoneUp/mask-go](https://github.com/GoneUp/mask-go) — [`mask/mask.go`](https://github.com/GoneUp/mask-go/blob/main/mask/mask.go), [`mask/draw.go`](https://github.com/GoneUp/mask-go/blob/main/mask/draw.go), [`mask/aes.go`](https://github.com/GoneUp/mask-go/blob/main/mask/aes.go) | Working Go implementation. Most complete source; the only one that implements upload. |
| **[cp]** | [shawnrancatore/shining-mask](https://github.com/shawnrancatore/shining-mask) — [`main.py`](https://github.com/shawnrancatore/shining-mask/blob/main/main.py) | Working CircuitPython implementation. Independent confirmation of UUIDs + key, and the only source with real-world frame-rate evidence. |
| **[js]** | [beclamide/mask-controller](https://github.com/beclamide/mask-controller) — [`codes.js`](https://github.com/beclamide/mask-controller/blob/master/codes.js) | **Captures of the official app.** It has no AES key and only replays opaque hex blobs, so those blobs are recordings of real app traffic, not a reimplementation's guesses. Decrypting them (done in [`../src/mask-protocol.test.mjs`](../src/mask-protocol.test.mjs)) is the most authoritative wire-format evidence available. |
| **[bd]** | mask-go's ["braindumping protocol details"](https://github.com/GoneUp/mask-go#protocol) README section | Author's notes. Mostly matches the Go code; the disagreements are flagged below. |
| **[rd]** | [r/ReverseEngineering thread](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/help_me_figure_out_how_to_reverse_engineer_the/) ([key comment](https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/comment/h14nm39/)) | The upstream origin of the key and protocol, per mask-go's credits. **Not read directly** — reddit.com blocks automated fetches. Cited because it is the primary source everything else derives from. |

Where a claim is confirmed by two independent implementations it is marked **[go][cp]** and can be
trusted. Single-source claims are marked as such. Treat everything as "true for the masks people have
tested" rather than a spec — mask-go notes several vendor models (e.g. `Lumen Couture LED Face
Changing Mask`) share the same app and protocol.

**Precedence: [js] outranks everything.** Where the decrypted captures disagree with [go], the
captures win — [go] is a third-party reimplementation, [js] is a recording of what the official app
actually put on the wire. Two of the three previously-open discrepancies were settled this way, both
against [go]. Every capture is asserted as a test, so these aren't claims you have to take on trust.

## Discovery and connection

The device advertises a name starting `MASK`, so `namePrefix: 'MASK'` is a workable
`requestDevice()` filter **[go]** (`strings.HasPrefix(device.LocalName(), "MASK")`).

**Primary service UUID:**

```
0000fff0-0000-1000-8000-00805f9b34fb
```

That's the standard 16-bit UUID `0xfff0`. Confirmed independently by **[go]** and **[cp]**, and it is
**not on the [Web Bluetooth GATT blocklist](https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt)**
(which only covers HID, Nordic/TI/Cypress DFU, and the FIDO UUIDs), so Chrome will grant it.

You must still name it in `filters` or `optionalServices` — Web Bluetooth refuses access to any
undeclared service, so unlike bleak you cannot write to a characteristic by UUID and let the stack
locate the service. But there is nothing left to sniff.

The mask uses a plain **unbonded** GATT connection — no OS-level pairing, nothing to configure in
Bluetooth settings.

### Characteristics

All three live under the `fff0` service.

| UUID | Direction | Purpose |
|---|---|---|
| `d44bc439-abfd-45a2-b575-925416129600` | write | commands, AES-128-ECB encrypted **[go][cp]** |
| `d44bc439-abfd-45a2-b575-925416129601` | notify | responses, **also AES-128-ECB encrypted** **[go]** |
| `d44bc439-abfd-45a2-b575-92541612960a` | write | bulk image data, **plaintext** **[go]** |

## Command frame

Commands go to `…9600`, encrypted with **AES-128 in ECB mode**, exactly one 16-byte block:

```
[ len ][ ASCII verb ][ args… ][ padding to 16 bytes ]
```

`len` is one byte: the length of the verb plus its args, not counting itself and not counting
padding.

**Padding content is ignored by the mask.** **[go]** zero-fills; **[cp]** pads with fixed garbage
(`;\x97\xf2\xf3U\xa9r\x13\x8b`) and works fine. Zero-fill is the sane choice.

Key (16 bytes), identical in both implementations:

```
32672f7974ad43451d9c6c894a0e8764
```

### Verbs

Byte layouts below are quoted from **[bd]** in its `06LIGHTnn` shorthand, cross-checked against the
**[go]** code.

| Verb | `len` | Args | Meaning | Confidence |
|---|---|---|---|---|
| `MODE` | 5 | 1 byte | Scroll mode: `01` steady, `02` blink/flashing, `03` scroll left, `04` scroll right, `05` steady | **[js][go][bd]** |
| `LIGHT` | 6 | 1 byte | Brightness | **[go][bd]** |
| `IMAG` | 5 | 1 byte | Select built-in static image by index | **[js]** for the length, **[go][bd]** for the verb |
| `ANIM` | 5 | 1 byte | Select built-in animation by index | **[js][go][bd]** |
| `PLAY` | 6 | `01` then 1 index byte | Show an uploaded ("DIY") image | **[go][cp][bd]** |
| `SPEED` | 6 | 1 byte | Text scroll speed, 0–255 | **[js][go][bd]** |
| `M` | 3 | 1 enable byte, 1 mode byte | Text color mode. `00`–`03` gradients, `04`–`07` background image (`04` x-mask, `05` christmas, `06` love, `07` scream) | **[go][bd]** |
| `FC` | 6 | 1 enable byte, **R, G, B** | Foreground color. **Confirmed on hardware: `enable = 1`, byte order RGB.** | **[js][go][bd]** + hardware |
| `BC` | 6 | 1 enable byte, 3 color bytes | Text background color | **[js][bd]** — **not** `BG` |
| `DATS` | 9 | 2-byte total len, 2-byte bitmap len, 1 zero byte | Begin an upload | **[go][bd]** |
| `DATCP` | 5 | — | Finish an upload | **[js][go][bd]** |
| `DELE` | ? | 1 count byte, then indices | Delete uploaded images | **[rd]** only — unverified |
| `CHEC` | 4 | — | Query image count. **Confirmed on hardware**: replies `[05]["CHEC"][count]`, observed `0x22` = **34** | **[rd]** + hardware |

`DELE` and `CHEC` appear in the earlier notes this repo was built from but in **none** of the four
other sources. Treat them as unconfirmed.

#### Settled: `IMAG`/`ANIM` declare `len = 5`

**[go]** sends `len = 6` for these two, contradicting its own rule for every other verb (`IMAG` is a
4-byte verb plus a 1-byte index = 5). **[js]**'s captured `ANIM` frames decrypt to
`05 "ANIM" <index>` — the official app sends **5**. We follow the app.

Both probably work: **[go]** ran fine against hardware with `6`, which suggests the mask ignores `len`
for these verbs and reads a fixed arg count. But matching the real app costs nothing.

#### Settled: the background-color verb is `BC`, not `BG`

**[go]** sends `BG`; **[bd]** documents `BC`. **[js]**'s capture decrypts to
`06 "BC" 00 7f 7f 7f`, so **[bd]** was right and **[go]**'s `BG` is the outlier — most likely never
exercised, since mask-controller's own author left this path commented out.

#### Settled: `FC` is RGB, with `enable = 1`

**[bd]** documented the order as `<RR> <BB> <GG>`. **[go]** appends `r, g, b`. Hardware settles it:
pure red renders red, so the order is **RGB** and **[go]** was right.

`enable = 1` is what takes effect. Curiously the official app sends `enable = 0`, so that byte is
probably selecting a colour *source* — e.g. `0` = use the gradient/mode from `M`, `1` = use these
literal bytes — rather than being a plain on/off.

### The full-color question

**Open, and the most valuable thing left to answer.** Two facts point in opposite directions:

- The official app's DIY images are **full color** — so the hardware *can* address colour per pixel.
- The only upload format we have implemented is 1-bit bitmap + one RGB per column, which physically
  cannot express that. And on hardware its colour section is ignored entirely.

So there is almost certainly an upload path we have not found. Notably, the original **[rd]**-derived
notes described the payload as *"raw RGB, 3 bytes per pixel"* — a full-color format. This repo
previously replaced that claim with **[go]**'s per-column format, but **both are probably real,
describing different paths**: **[go]** implements the *text* upload, and the gist may have been
describing the *image* upload. Discarding it was likely a mistake.

Candidate mechanisms, cheapest first:

1. **`DATS`'s 5th arg byte.** Unexplained in every source; all send `0`. Prime suspect for selecting a
   destination slot or a payload format. Sweepable — the Upload lab in the app does this.
2. ~~**`bitmapLen = 0`**, on the theory that the whole payload is then read as raw pixels.~~
   **Tested — it SOFT-LOCKS the mask.** The upload animation freezes mid-way and only a power cycle
   recovers it. Notably every step still ACKed (`DATSOK`, 5× `REOK`, `DATCPOK`), so **notification
   ACKs are not a health signal** — the firmware will confirm a transfer that is wedging it.
3. **Pixel order**, if a full-color format exists: column-major or row-major is unknown.
4. **`DELE` and `CHEC`** exist in **[rd]** and nowhere else — "delete uploaded images" and "query how
   many images are uploaded". Both only make sense if a *writable* slot bank exists, which is further
   evidence the path is there.

**The decisive test is an Android HCI snoop capture** of the official app performing a DIY image
upload. Developer options → *Enable Bluetooth HCI snoop log* → do the upload → pull
`btsnoop_hci.log` → Wireshark. Since the AES key is known, every command decrypts. That single capture
would settle the format, the slot mechanism, the real slot count, and whether a music mode exists.

**Test design note:** any full-color experiment should use a pattern that varies **vertically within a
column**. Per-column colour cannot produce vertical variation, so it is the unambiguous signal.

## Image upload

Uploads write a custom bitmap into a DIY slot, which you then display with `PLAY`. This is the only
slow path in the protocol.

### It is notification-flow-controlled, not paced

Each step waits for a response on `…9601` (decrypt it — responses are AES-ECB too). From **[go]**:

```
  → DATS                    (on …9600, encrypted)
  ← DATSOK
  repeat until all bytes sent:
    → one data packet       (on …960a, PLAINTEXT)
    ← REOK
  → DATCP                   (on …9600, encrypted)
  ← DATCPOK
```

Other observed responses: `PLAYOK` (acknowledges `PLAY`), and **[bd]** writes the first response as
`DATSOKP` where the code matches on `DATSOK` — a trailing byte, harmless if you prefix-match.

Because the mask gates every packet behind `REOK`, **do not try to pace writes by hand and do not
use `writeValueWithoutResponse()` for the data packets.** Drive the state machine off the
notification handler. This is both simpler and more reliable than the guesswork it replaces.

### Data packet format

Sent to `…960a`, **unencrypted**, max 100 bytes total → 98 payload bytes per packet **[go][bd]**:

```
[ byteCount ][ packetSequenceNumber ][ payload… ]
```

**`byteCount` includes the sequence byte**, i.e. `payloadLength + 1`. **[go]** sends
`bytesToSend + 1`, and **[js]**'s captured plaintext packets confirm it independently: they begin
`6300…`, `6301…`, `2D02…` — `0x63` = 99 = 98 payload + 1 sequence byte, sequence 0; then sequence 1;
then `0x2d` = 45 = 44 payload + 1, sequence 2. The sequence number starts at 0 and increments.

### Payload format

**Not raw RGB.** The display is **16 pixels high** **[go][bd]**, and the payload is a 1-bit-per-pixel
bitmap followed by a **separate per-column color array** — concatenated, bitmap first:

```
for each column:                      # bitmap section
  2 bytes, little-endian uint16
    low byte:  rows 0-7   (row 0 = bit 7 … row 7 = bit 0)
    high byte: rows 8-15  (row 8 = bit 7 … row 15 = bit 0)
for each column:                      # color section
  3 bytes RGB
```

`DATS` declares both the total length and the bitmap-section length, which is how the mask knows
where the color array starts.

The bit order is worth reading carefully — **[go]**'s `EncodeBitmapForMask` sets row 0 to `128` and
row 8 to `32768`, then writes the `uint16` **little-endian**, so on the wire the first byte holds
rows 0–7 MSB-first and the second holds rows 8–15 MSB-first.

**[bd]**'s worked example, 8 columns:

```
FFFF0000 FFFF0000 FFFF0000 FFFF0000   FF0000 FF0000 00FF00 00FF00 FF0000 FF0000 00FF00 00FF00
└─────── 8 columns × 2b bitmap ─────┘ └──────── 8 columns × 3b RGB ──────────┘
```

(16 bytes of bitmap + 24 bytes of color = 40; the README's arithmetic says 36, which doesn't add up
either way — trust the format description, not the total.)

**⚠️ The colour section appears to be ignored.** On hardware, a red fill rendered white. Every source
that uploads sends white or near-white (mask-go hardcodes `0xFFFFFF`; the official-app capture is
`0xFFFFFC`), so nobody has ever demonstrated the colour array having an effect. Colour is most likely
governed by `FC`/`BC` and their `enable` byte instead. Still send a well-formed colour section — the
lengths in `DATS` depend on it — but don't expect it to control anything.

Even if it did work, it would be **one colour per column**: each 16-pixel column is on/off per pixel
with a single shared RGB. No arbitrary full-colour images either way.

**Display width is 46 columns**, measured on hardware — a 32-column upload rendered as a partial
rectangle. No source states this, and text is variable-width and scrolls, so uploads are not *required*
to match; but 46 is what fills the face.

## Timing

**Measured on hardware:** a single 16-byte command round trip is **~11 ms**; a full 46-column upload
(3 packets, notification-gated) is **~300–350 ms**. So commands are ~30× cheaper than uploads.

**Measured, from [cp]:** it schedules an unconditional `PLAY` write every `1000/24` ms — **24 Hz
sustained**, no deduplication, no dropped-frame handling — and animates blinks at 12 distinct frames
per second. This ran on a CircuitPython board against a real mask.

So single-block command writes are good for **at least ~24 Hz**, which is comfortably better than the
30–100 ms per command previously assumed here. Practical consequences:

- Index switches (`PLAY`, `IMAG`, `ANIM`) and color changes (`FC`, `BC`) are all one encrypted
  16-byte write and cost the same. They are fast enough for real animation, not just cues.
- A **full upload is a many-round-trip handshake** — a ~32-column frame is ~64 bytes of bitmap plus
  ~96 bytes of color = 2 packets, so `DATS`/`DATSOK` + 2×(packet/`REOK`) + `DATCP`/`DATCPOK` ≈ 6
  round trips. Hundreds of ms. **Not viable per frame.** Preload a frame bank, then switch indices.
- Chrome serializes GATT operations, so at 24 Hz you must not queue writes unboundedly. Keep one
  write in flight and a single "latest desired state" slot; drop superseded values rather than
  queueing them.

## DIY slot limits

### Confirmed on hardware: uploads do not write DIY slots

**Settled.** 20 successful uploads followed by `PLAY 1…3` still showed the pre-existing official-app
DIY images. `PLAY n` selects a slot; nothing we can send writes one. The source evidence below all
pointed this way and is now confirmed.

- **`PLAY n` selects slot `n`. Nothing in any of the four sources writes slot `n`.** There is no
  slot-addressing verb, and critically **`DATS` takes no slot parameter** — it declares a total
  length and a bitmap length, and that's all.
- **[go]** never sends `PLAY` after an upload. Its `SetText` runs `DATS`/packets/`DATCP` and the text
  just appears; on `DATCPOK` it only clears its `uploadRunning` flag.
- **[js]**'s captured `changeFace` sequence is the same shape — upload packets, then `DATCP`, then
  `MODE`. No `PLAY`, no slot index anywhere.
- **[cp]**'s README says it outright: *"Make sure that you load some custom images to the mask before
  trying this."* It only ever switches between slots the official app populated.

So the upload path is the **live display** channel — the text/scrolling-bitmap path, which fits with
`MODE`, `SPEED`, `M`, `FC` and `BC` all being text-oriented.

**Consequence for a frame-bank design:** the bank must be authored **by hand in the official app**,
after which your own code can switch indices freely. "The PWA uploads its own frame bank" is not
possible with the protocol as understood. That is still fine for a performance rig — author once,
`PLAY` at 24 Hz — it just isn't self-service.

### Numeric bounds

All derived from the frame format, so they're firm even where the semantics aren't:

| Limit | Value | Where it comes from |
|---|---|---|
| Command frame | exactly **16 bytes** (one AES block) | **[go]**'s encrypt panics on any other size; every **[js]** capture is one block |
| Verb + args | **15 bytes** | 16 minus the length byte |
| Indices per `PLAY`/`DELE` | **10** | 15 − 4 (verb) − 1 (count byte) |
| Addressable DIY index | **≤ 255** | index is a single byte |
| Slots actually assumed | **20** (indices 1–20) | **[cp]** builds `PLAY` frames for `i+1 for i in range(20)` — the only real-world number available, and an assumption in its code rather than a probed device limit |
| Single upload | **25,088 bytes** | 256 packets (1-byte sequence number) × 98 payload bytes |
| — the looser competing limit | 65,535 bytes | `DATS`'s 2-byte total length; you run out of sequence numbers first |
| Upload packet | **100 bytes** total, 98 payload | **[go]**'s `btMaxPacketSize`, confirmed by **[js]**'s `0x63` prefix |

At 5 bytes per column (2 bitmap + 3 color), the 25,088-byte ceiling is ~5,017 columns — irrelevant
for a 16-pixel-high display. The binding limits in practice are the **10 indices per command** and
whatever the real slot count turns out to be.

The multi-index `PLAY` playlist is **[rd]**-sourced only: every implementation sends a count of
exactly `01`, so the count byte's behaviour beyond 1 is inferred from the notes, not observed.

## No way to enumerate what's on the device

There is **no read-back capability in the protocol as understood.** Checked all four sources:

- No verb returns image names, indices, thumbnails, or contents.
- The only readable channel is the notify characteristic `…9601`, and every observed response is a
  short status token tied to a command you just sent — `DATSOK`, `REOK`, `DATCPOK`, `PLAYOK`. Nothing
  unsolicited, nothing descriptive.
- The two remaining characteristics are write-only.
- `CHEC` (from **[rd]**, "query how many images are uploaded") would give a bare **count** at best —
  no names, no contents, no per-slot occupancy. It appears in none of the four implementations, so
  it's unverified; worth trying against hardware and watching `…9601`, since a count alone would be
  useful.
- `PLAY` addresses DIY slots by index, so indices exist, but nothing exposes which are populated.
  Probing by sending `PLAY n` and watching for `PLAYOK` vs. silence is speculative and would be
  visible on the mask's face — not a viable enumeration strategy.

**Design consequence: the app must own the inventory.** Treat the mask as write-only storage and keep
the authoritative record of what's in which slot on the client (IndexedDB), written at upload time.
That record is host-local, so it desynchronises the moment the official app — or another copy of
ours — uploads anything. Two mitigations worth building in from the start:

1. A "re-sync" action that re-uploads the whole known bank, restoring a known-good state rather than
   trying to diff against a device you can't read.
2. Never assume a slot contains what you last put there when correctness matters — for a performance
   set, re-upload the bank as part of setup.

If `CHEC` turns out to work, a count mismatch at least detects the desync, which is worth having even
without the ability to repair it precisely.

## Connection model

The mask accepts **one BLE central at a time**, so the phone and the Mac cannot both hold the link.
Handoff has to be explicit in the UI rather than something you discover as a bug.

## No built-in audio or visualizer mode

Searched all three implementations for any audio, music, microphone, FFT, spectrum, or
beat-detection reference: **nothing**. No such verb is documented, and no source suggests the mask
has a microphone. If the official app has a music-reactive mode, its command has not been reverse
engineered — you would have to sniff the official app's BLE traffic to find it. Build the visualizer
host-side instead; see [`architecture.md`](architecture.md).

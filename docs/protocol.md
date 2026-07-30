# Shining Mask BLE protocol

Reverse-engineered, not official. Primary source:
[gist by Staars](https://gist.github.com/Staars/71e63e4bdefc7e3fd22377bf9c50ac12).
Treat everything here as "true for the masks people have tested" rather than a spec.

## Discovery

The device advertises with a name starting `MASK`, so `namePrefix: 'MASK'` is a workable
`requestDevice()` filter.

**The primary service UUID is not recorded here** — sniff it once from your own mask with
`chrome://bluetooth-internals` or nRF Connect and hardcode it. You cannot skip this: Web Bluetooth
refuses access to any service not named in `filters` or `optionalServices`, so unlike bleak you
can't write to a characteristic by UUID and let the stack locate the service for you.

## Characteristics

| UUID | Direction | Purpose |
|---|---|---|
| `d44bc439-abfd-45a2-b575-925416129600` | write | commands, AES-ECB encrypted |
| `d44bc439-abfd-45a2-b575-925416129601` | notify | responses / status |
| `d44bc439-abfd-45a2-b575-92541612960a` | write | bulk image data, **plaintext** |

## Command frame

Commands go to `…9600`, encrypted with **AES-128 in ECB mode**:

```
[ len ][ ASCII verb ][ args… ][ zero padding to 16 bytes ]
```

`len` is one byte: the length of everything after it (verb + args), not counting padding. The whole
frame is zero-padded to exactly 16 bytes, then encrypted as a single AES block.

Key (16 bytes):

```
32672f7974ad43451d9c6c894a0e8764
```

### Verbs

| Verb | Args | Meaning |
|---|---|---|
| `LIGHT` | 1 byte | brightness |
| `IMAG` | 1 byte | select static image by index |
| `ANIM` | 1 byte | select animation by index |
| `SPEED` | 1 byte | transition speed |
| `PLAY` | 1 byte count, then indices | play a DIY image sequence |
| `DELE` | 1 byte count, then indices | delete uploaded images |
| `CHEC` | — | query how many images are uploaded |
| `DATS` | 2-byte length, 3 unknown bytes | begin an image upload |

## Image upload

1. Send `DATS` on `…9600` with the total byte length of the image payload.
2. Stream the payload to `…960a` in chunks of roughly 98 bytes, **unencrypted**. Each chunk is
   prefixed:

   ```
   [ number of bytes following ][ packet sequence number ][ payload… ]
   ```

3. Payload is raw RGB, 3 bytes per pixel.

Use `writeValueWithoutResponse()` for the chunks and pace them — Chrome serializes GATT operations,
so a naive loop of awaited writes is far slower than it needs to be, and an unpaced flood backs up
the queue.

## Timing characteristics

Roughly **30–100 ms** per command round trip, from the BLE connection interval plus Chrome's
serialized GATT queue plus the AES step. Consequences:

- Index switches (`IMAG`, `ANIM`, `PLAY`) are fast enough for musical cues, but not
  sample-accurate. A fixed offset is correctable with Ableton track delay.
- A full-frame upload is many chunked writes — hundreds of ms to seconds. **Not viable per beat.**
  Preload a frame bank, then switch indices at performance time.

## Connection model

The mask accepts **one BLE central at a time**. The phone and the Mac cannot both hold the link, so
handoff has to be explicit in the UI rather than something you discover as a bug.

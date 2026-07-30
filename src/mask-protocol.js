/**
 * Shining Mask protocol encoding — reference implementation.
 *
 * Encoding is cross-checked against two working implementations (see ../docs/protocol.md for the
 * full source table and the confidence level of every individual claim):
 *
 *   [go] https://github.com/GoneUp/mask-go        — Go, the only one that implements upload
 *   [cp] https://github.com/shawnrancatore/shining-mask — CircuitPython, confirms UUIDs + key
 *   [js] https://github.com/beclamide/mask-controller  — Node; has no AES key and only replays raw
 *        hex, so its blobs are CAPTURES OF THE OFFICIAL APP. Decrypting them (see the test file) is
 *        the most authoritative evidence available for wire format, and it overrides [go] where they
 *        disagree — [go] is a reimplementation, [js] is what the real app actually sends.
 *
 * Ultimately derived from https://www.reddit.com/r/ReverseEngineering/comments/lr9xxr/
 *
 * STILL UNTESTED against real hardware from *this* code. The byte layouts are taken from code that
 * demonstrably works, and the AES path is verified against a known-answer vector, but nobody has
 * confirmed a mask accepts bytes produced by this file. Three known ambiguities are marked ⚠️ below.
 *
 * Deliberately transport-agnostic: nothing here touches Web Bluetooth. Feed the returned frames to
 * a GATT characteristic, a WebSocket, or a test harness. That separation is what makes the
 * untethered options in ../docs/architecture.md a transport swap instead of a rewrite.
 */

/**
 * Primary service UUID — the standard 16-bit UUID 0xfff0. Confirmed by [go] and [cp], and absent
 * from the Web Bluetooth GATT blocklist, so Chrome will grant it. Must still be declared in
 * requestDevice() filters/optionalServices; Web Bluetooth blocks undeclared services.
 */
export const SERVICE_UUID = 0xfff0;

/** Characteristics, all under SERVICE_UUID. */
export const CHARACTERISTIC = {
  command: 'd44bc439-abfd-45a2-b575-925416129600', // write, AES-ECB encrypted
  notify: 'd44bc439-abfd-45a2-b575-925416129601', // notify, AES-ECB encrypted TOO
  upload: 'd44bc439-abfd-45a2-b575-92541612960a', // write, plaintext image data
};

/** Device name prefix, usable as a requestDevice() filter. */
export const NAME_PREFIX = 'MASK';

const KEY_HEX = '32672f7974ad43451d9c6c894a0e8764';
const BLOCK = 16;

/** Display height in pixels. Fixed by the protocol: uploads are encoded as 16-pixel columns. */
export const DISPLAY_HEIGHT = 16;

/** Max bytes per upload write, including the 2-byte prefix — the mask rejects anything larger. */
export const UPLOAD_PACKET_SIZE = 100;
/** Payload bytes per upload packet, after the [byteCount][sequence] prefix. */
export const UPLOAD_CHUNK_SIZE = UPLOAD_PACKET_SIZE - 2;

/**
 * Hard ceiling on one upload, in bytes.
 *
 * Two limits apply and this is the tighter one: the packet sequence number is a single byte, so 256
 * packets × 98 payload bytes = 25,088. (DATS carries a 2-byte total length, which would allow 65,535
 * — but you'd run out of sequence numbers first.) At 5 bytes per column (2 bitmap + 3 color) that's
 * ~5,017 columns, so for a 16-pixel-high display this is not a practical constraint.
 */
export const MAX_UPLOAD_BYTES = 256 * (UPLOAD_PACKET_SIZE - 2);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

let keyPromise;
function importKey() {
  // AES-CBC rather than AES-ECB deliberately — see encryptEcb.
  keyPromise ??= crypto.subtle.importKey('raw', hexToBytes(KEY_HEX), 'AES-CBC', false, [
    'encrypt',
    'decrypt',
  ]);
  return keyPromise;
}

/**
 * AES-128-ECB encrypt, one 16-byte block at a time.
 *
 * WebCrypto has no ECB mode. The workaround: CBC with an all-zero IV is identical to ECB for the
 * first block (the IV is XORed into the plaintext, and zero XOR anything is a no-op), so we encrypt
 * each block independently and keep only the first 16 bytes of each result — WebCrypto always
 * appends a PKCS#7 padding block we don't want.
 *
 * If this ever becomes a throughput problem, swap in aes-js and do real ECB. It shouldn't: commands
 * are a single block, and upload payloads are sent plaintext.
 */
export async function encryptEcb(plaintext) {
  if (plaintext.length % BLOCK !== 0) {
    throw new Error(`ECB input must be a multiple of ${BLOCK} bytes, got ${plaintext.length}`);
  }
  const key = await importKey();
  const zeroIv = new Uint8Array(BLOCK);
  const out = new Uint8Array(plaintext.length);
  for (let offset = 0; offset < plaintext.length; offset += BLOCK) {
    const block = plaintext.subarray(offset, offset + BLOCK);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, block);
    out.set(new Uint8Array(encrypted, 0, BLOCK), offset);
  }
  return out;
}

/**
 * AES-128-ECB decrypt — needed because notifications on CHARACTERISTIC.notify are encrypted too.
 *
 * Decryption is fiddlier than encryption. Each block is decrypted independently with a zero IV, so
 * CBC's chaining XOR is a no-op and the result is plain ECB — but WebCrypto also insists on
 * stripping PKCS#7 padding and throws if it isn't valid. So we append a second block crafted to
 * decrypt to exactly `0x10 × 16`. Because CBC XORs the *previous ciphertext block* into that
 * result, the block we append is E(pad XOR C) and therefore depends on C — it has to be built per
 * block, not once.
 *
 *   block 1 → D(C) XOR 0        = D(C)                    ← what we want
 *   block 2 → D(E(pad XOR C)) XOR C = pad XOR C XOR C = pad ← valid padding, stripped by WebCrypto
 */
export async function decryptEcb(ciphertext) {
  if (ciphertext.length % BLOCK !== 0) {
    throw new Error(`ECB input must be a multiple of ${BLOCK} bytes, got ${ciphertext.length}`);
  }
  const key = await importKey();
  const zeroIv = new Uint8Array(BLOCK);
  const pad = new Uint8Array(BLOCK).fill(BLOCK); // PKCS#7 for a full block

  const out = new Uint8Array(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += BLOCK) {
    const block = ciphertext.subarray(offset, offset + BLOCK);
    const padSource = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) padSource[i] = pad[i] ^ block[i];

    const withPad = new Uint8Array(BLOCK * 2);
    withPad.set(block, 0);
    withPad.set(await encryptEcb(padSource), BLOCK);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: zeroIv }, key, withPad);
    out.set(new Uint8Array(decrypted, 0, BLOCK), offset);
  }
  return out;
}

/**
 * Parse a notification: decrypt, then read the [len][ASCII response] frame.
 * Returns the response string, e.g. 'DATSOK', 'REOK', 'DATCPOK', 'PLAYOK'.
 */
export async function parseNotification(encrypted) {
  const plain = await decryptEcb(new Uint8Array(encrypted));
  const length = plain[0];
  return new TextDecoder().decode(plain.subarray(1, 1 + length));
}

/**
 * Bytes available for a verb plus its args in one command: 16-byte block minus the length byte.
 *
 * Commands are strictly ONE AES block. [go]'s encrypt function panics on any input that isn't
 * exactly 16 bytes, and every captured frame in [js] is a single block, so a multi-block command has
 * never been observed and there is no reason to think the mask accepts one. This is the hard ceiling
 * behind the arg limits on `play` and `delete`.
 */
export const MAX_COMMAND_PAYLOAD = BLOCK - 1;

/**
 * Build one plaintext command frame: [len][ASCII verb][args...][zero padding to 16 bytes].
 *
 * `len` counts the verb and args only — not itself, not the padding. The mask ignores padding
 * content ([cp] and [js] both pad with garbage and work), so zeros are fine.
 *
 * Throws if verb+args exceed one block, rather than silently emitting a two-block frame the mask
 * will almost certainly reject.
 *
 * `declaredLength` overrides the computed `len` byte. Nothing needs it now that [js]'s captures
 * settled IMAG/ANIM at 5, but it's the escape hatch if a real mask disagrees.
 */
export function buildCommandFrame(verb, args = [], declaredLength) {
  const verbBytes = new TextEncoder().encode(verb);
  const argBytes = Uint8Array.from(args);
  const payloadLength = verbBytes.length + argBytes.length;
  if (payloadLength > MAX_COMMAND_PAYLOAD) {
    throw new Error(
      `${verb}: ${payloadLength} bytes of verb+args exceeds the ${MAX_COMMAND_PAYLOAD}-byte ` +
        `single-block limit (max ${MAX_COMMAND_PAYLOAD - verbBytes.length} arg bytes for this verb)`,
    );
  }

  const frame = new Uint8Array(BLOCK); // zero-filled = zero-padded
  frame[0] = declaredLength ?? payloadLength;
  frame.set(verbBytes, 1);
  frame.set(argBytes, 1 + verbBytes.length);
  return frame;
}

/** Max index bytes that fit in one `PLAY`/`DELE` command, after the verb and the count byte. */
export const MAX_INDICES_PER_COMMAND = MAX_COMMAND_PAYLOAD - 'PLAY'.length - 1; // 10

/** Build and encrypt a command, ready to write to CHARACTERISTIC.command. */
export async function encodeCommand(verb, args = [], declaredLength) {
  return encryptEcb(buildCommandFrame(verb, args, declaredLength));
}

/** Scroll modes for `command.mode`. */
export const MODE = {
  steady: 1,
  blink: 2,
  scrollLeft: 3,
  scrollRight: 4,
};

/** Text color modes for `command.textColorMode`: 0-3 gradients, 4-7 background images. */
export const TEXT_COLOR_MODE = {
  gradient0: 0,
  gradient1: 1,
  gradient2: 2,
  gradient3: 3,
  backgroundXMask: 4,
  backgroundChristmas: 5,
  backgroundLove: 6,
  backgroundScream: 7,
};

/** Convenience wrappers for the known verbs. Each resolves to encrypted bytes. */
export const command = {
  /** Scroll behaviour — see MODE. */
  mode: (mode) => encodeCommand('MODE', [clampByte(mode)]),

  brightness: (level) => encodeCommand('LIGHT', [clampByte(level)]),

  /**
   * Built-in static image / animation by index, len=5.
   *
   * [go] declares len=6 here, which contradicts its own rule for every other verb. Settled by [js]:
   * its captured `ANIM` frames from the official app decrypt to `05 "ANIM" <index>` — len=5. We
   * follow the official app. (Both presumably work, i.e. the mask likely ignores `len` and reads a
   * fixed arg count per verb, since [go] ran fine with 6 — but matching the real app is free.)
   * If IMAG ever misbehaves on hardware, `encodeCommand('IMAG', [index], 6)` is the thing to try.
   */
  image: (index) => encodeCommand('IMAG', [clampByte(index)]),
  animation: (index) => encodeCommand('ANIM', [clampByte(index)]),

  /**
   * Show an uploaded ("DIY") image. The best-confirmed verb — [go], [cp] and the braindump all
   * agree, and [cp] drives it at 24 Hz against real hardware.
   *
   * NOTE: this only SELECTS a slot. Nothing in the known protocol writes DIY slot n — see
   * ../docs/protocol.md#diy-slot-limits. [cp]'s README says to load your images with the official
   * app first, and it only ever switches between them.
   */
  play: (index) => encodeCommand('PLAY', [1, clampByte(index)]),

  /**
   * Play a sequence of DIY images — the leading count byte, per [rd]. UNVERIFIED: every observed
   * implementation sends a count of exactly 1, so multi-index behaviour is inferred from the notes
   * alone. Capped at MAX_INDICES_PER_COMMAND because the frame is a single AES block.
   */
  playSequence: (indices) => {
    if (indices.length < 1 || indices.length > MAX_INDICES_PER_COMMAND) {
      throw new Error(
        `playSequence: ${indices.length} indices, must be 1-${MAX_INDICES_PER_COMMAND} ` +
          `(one 16-byte command block)`,
      );
    }
    return encodeCommand('PLAY', [indices.length, ...indices.map(clampByte)]);
  },

  /** Text scroll speed. */
  speed: (value) => encodeCommand('SPEED', [clampByte(value)]),

  /** Gradient / background-image mode for text — see TEXT_COLOR_MODE. */
  textColorMode: (mode, enable = 1) =>
    encodeCommand('M', [enable ? 1 : 0, clampByte(mode)]),

  /**
   * ⚠️ Text foreground color. [go]'s code appends r, g, b; the braindump documents the wire order
   * as R, B, G. Still unsettled — [js]'s captured FC frame uses ff ff ff, which can't distinguish
   * them. We follow the code. Send pure red once on real hardware to settle it.
   */
  foregroundColor: (r, g, b, enable = 1) =>
    encodeCommand('FC', [enable ? 1 : 0, clampByte(r), clampByte(g), clampByte(b)]),

  /**
   * Text background color. The verb is `BC`, not the `BG` that [go] sends — settled by [js], whose
   * captured frame from the official app decrypts to `06 "BC" 00 7f 7f 7f`. [go]'s `BG` is the
   * outlier and was most likely never exercised.
   */
  backgroundColor: (r, g, b, enable = 1) =>
    encodeCommand('BC', [enable ? 1 : 0, clampByte(r), clampByte(g), clampByte(b)]),

  /**
   * Announce an upload. Declares the total payload length AND the length of its bitmap section —
   * that split is how the mask locates the start of the per-column color array. The trailing zero
   * byte is unidentified but is what [go] sends.
   */
  beginUpload: (totalBytes, bitmapBytes) =>
    encodeCommand('DATS', [
      (totalBytes >> 8) & 0xff,
      totalBytes & 0xff,
      (bitmapBytes >> 8) & 0xff,
      bitmapBytes & 0xff,
      0,
    ]),

  /** Finish an upload. Expect a DATCPOK notification. */
  finishUpload: () => encodeCommand('DATCP'),

  // Below: present in the original reddit-derived notes but in NONE of the three working
  // implementations. Unverified — expect these to need adjustment.
  /** Delete uploaded images by index. UNVERIFIED. Same single-block cap as playSequence. */
  delete: (indices) => {
    if (indices.length < 1 || indices.length > MAX_INDICES_PER_COMMAND) {
      throw new Error(
        `delete: ${indices.length} indices, must be 1-${MAX_INDICES_PER_COMMAND} ` +
          `(one 16-byte command block)`,
      );
    }
    return encodeCommand('DELE', [indices.length, ...indices.map(clampByte)]);
  },
  /** Ask how many images are uploaded. UNVERIFIED. */
  checkCount: () => encodeCommand('CHEC'),
};

function clampByte(n) {
  return Math.max(0, Math.min(255, n | 0));
}

/**
 * Encode a 1-bit-per-pixel image into the mask's bitmap section.
 *
 * `columns` is an array of columns, each an array of exactly DISPLAY_HEIGHT truthy/falsy values
 * (row 0 = top). Each column becomes a little-endian uint16: the first byte on the wire holds rows
 * 0-7 MSB-first, the second holds rows 8-15 MSB-first.
 */
export function encodeBitmap(columns) {
  const out = new Uint8Array(columns.length * 2);
  for (let x = 0; x < columns.length; x++) {
    const column = columns[x];
    if (column.length !== DISPLAY_HEIGHT) {
      throw new Error(`column ${x} has ${column.length} rows, expected ${DISPLAY_HEIGHT}`);
    }
    let low = 0; // rows 0-7
    let high = 0; // rows 8-15
    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      if (!column[y]) continue;
      if (y < 8) low |= 0x80 >> y;
      else high |= 0x80 >> (y - 8);
    }
    out[x * 2] = low; // little-endian: low byte first
    out[x * 2 + 1] = high;
  }
  return out;
}

/**
 * Encode the per-column color section: 3 bytes RGB per column.
 *
 * Note the constraint this imposes — ONE COLOR PER COLUMN. The mask cannot display an arbitrary
 * full-color image; every lit pixel in a column shares that column's RGB.
 */
export function encodeColors(colors) {
  const out = new Uint8Array(colors.length * 3);
  colors.forEach(([r, g, b], i) => {
    out[i * 3] = clampByte(r);
    out[i * 3 + 1] = clampByte(g);
    out[i * 3 + 2] = clampByte(b);
  });
  return out;
}

/** Concatenate the two sections into the upload payload: bitmap first, then colors. */
export function buildUploadPayload(bitmap, colors) {
  const payload = new Uint8Array(bitmap.length + colors.length);
  payload.set(bitmap, 0);
  payload.set(colors, bitmap.length);
  return { payload, bitmapLength: bitmap.length };
}

/**
 * Split an upload payload into packets for CHARACTERISTIC.upload. Sent PLAINTEXT — not encrypted.
 *
 * Each packet is [byteCount][sequenceNumber][payload...], where byteCount INCLUDES the sequence
 * byte (i.e. payload.length + 1) — [go] sends `bytesToSend + 1`.
 *
 * Do NOT write these with writeValueWithoutResponse() and do NOT pace them by hand: the mask gates
 * every packet behind a REOK notification. Drive them from the notification handler — see
 * uploadSequence().
 */
export function buildUploadPackets(payload) {
  if (payload.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `upload payload ${payload.length} bytes exceeds ${MAX_UPLOAD_BYTES} — the 1-byte packet ` +
        `sequence number would wrap`,
    );
  }
  const packets = [];
  let sequence = 0;
  for (let offset = 0; offset < payload.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = payload.subarray(offset, offset + UPLOAD_CHUNK_SIZE);
    const packet = new Uint8Array(2 + chunk.length);
    packet[0] = chunk.length + 1; // count includes the sequence byte
    packet[1] = sequence++;
    packet.set(chunk, 2);
    packets.push(packet);
  }
  return packets;
}

/**
 * The upload handshake as a generator, so the transport layer owns the I/O and this stays
 * transport-agnostic.
 *
 *   → DATS / ← DATSOK / (→ packet / ← REOK)* / → DATCP / ← DATCPOK
 *
 * Yields {characteristic, data} to write; receives the parsed notification string back in. `data` is
 * a Promise for command frames (encryption is async) and raw bytes for upload packets, so always
 * await it. Prefix-matching on responses is deliberate — the braindump records the first response as
 * 'DATSOKP' while [go] matches 'DATSOK'.
 *
 *   const run = uploadSequence(payload, bitmapLength);
 *   let step = run.next();
 *   while (!step.done) {
 *     await write(step.value.characteristic, await step.value.data);
 *     step = run.next(await nextNotification());
 *   }
 */
export function* uploadSequence(payload, bitmapLength) {
  const expect = (response, wanted) => {
    if (!response?.startsWith(wanted)) {
      throw new Error(`upload: expected ${wanted}, got ${JSON.stringify(response)}`);
    }
  };

  expect(
    yield { characteristic: CHARACTERISTIC.command, data: command.beginUpload(payload.length, bitmapLength) },
    'DATSOK',
  );

  for (const packet of buildUploadPackets(payload)) {
    expect(yield { characteristic: CHARACTERISTIC.upload, data: packet }, 'REOK');
  }

  expect(
    yield { characteristic: CHARACTERISTIC.command, data: command.finishUpload() },
    'DATCPOK',
  );
}

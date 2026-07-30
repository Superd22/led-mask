/**
 * Shining Mask protocol encoding — reference implementation.
 *
 * UNTESTED against real hardware. The encoding and the AES path are verified against the
 * reverse-engineering notes in ../docs/protocol.md and against a known-answer AES vector, but
 * nobody has yet confirmed a mask accepts these bytes.
 *
 * Deliberately transport-agnostic: nothing here touches Web Bluetooth. Feed the returned frames to
 * a GATT characteristic, a WebSocket, or a test harness. That separation is what makes the
 * untethered options in ../docs/architecture.md a transport swap instead of a rewrite.
 */

/** Characteristic UUIDs. The primary *service* UUID is device-specific — sniff and hardcode it. */
export const CHARACTERISTIC = {
  command: 'd44bc439-abfd-45a2-b575-925416129600', // write, AES-ECB encrypted
  notify: 'd44bc439-abfd-45a2-b575-925416129601', // notifications
  upload: 'd44bc439-abfd-45a2-b575-92541612960a', // write, plaintext image data
};

const KEY_HEX = '32672f7974ad43451d9c6c894a0e8764';
const BLOCK = 16;

/** Bytes per image-data chunk payload, excluding the 2-byte length+sequence prefix. */
export const UPLOAD_CHUNK_SIZE = 96;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * AES-128-ECB encrypt, one 16-byte block at a time.
 *
 * WebCrypto has no ECB mode. The workaround: CBC with an all-zero IV is identical to ECB for the
 * first block (the IV is XORed into the plaintext, and zero XOR anything is a no-op), so we encrypt
 * each block independently and keep only the first 16 bytes of each result — WebCrypto always
 * appends a PKCS#7 padding block we don't want.
 *
 * If this ever becomes a throughput problem, swap in aes-js and do real ECB.
 */
export async function encryptEcb(plaintext) {
  if (plaintext.length % BLOCK !== 0) {
    throw new Error(`ECB input must be a multiple of ${BLOCK} bytes, got ${plaintext.length}`);
  }
  const key = await crypto.subtle.importKey('raw', hexToBytes(KEY_HEX), 'AES-CBC', false, [
    'encrypt',
  ]);
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
 * Build one plaintext command frame: [len][ASCII verb][args...][zero padding to a 16-byte multiple].
 * `len` counts the verb and args only — not itself, and not the padding.
 */
export function buildCommandFrame(verb, args = []) {
  const verbBytes = new TextEncoder().encode(verb);
  const argBytes = Uint8Array.from(args);
  const payloadLength = verbBytes.length + argBytes.length;
  if (payloadLength > 255) throw new Error(`command payload too long: ${payloadLength}`);

  const unpadded = 1 + payloadLength;
  const frame = new Uint8Array(Math.ceil(unpadded / BLOCK) * BLOCK); // zero-filled = zero-padded
  frame[0] = payloadLength;
  frame.set(verbBytes, 1);
  frame.set(argBytes, 1 + verbBytes.length);
  return frame;
}

/** Build and encrypt a command, ready to write to CHARACTERISTIC.command. */
export async function encodeCommand(verb, args = []) {
  return encryptEcb(buildCommandFrame(verb, args));
}

/** Convenience wrappers for the known verbs. Each resolves to encrypted bytes. */
export const command = {
  brightness: (level) => encodeCommand('LIGHT', [clampByte(level)]),
  image: (index) => encodeCommand('IMAG', [clampByte(index)]),
  animation: (index) => encodeCommand('ANIM', [clampByte(index)]),
  speed: (value) => encodeCommand('SPEED', [clampByte(value)]),
  /** Play a DIY sequence: a count followed by the image indices. */
  play: (indices) => encodeCommand('PLAY', [indices.length, ...indices.map(clampByte)]),
  /** Delete uploaded images by index. */
  delete: (indices) => encodeCommand('DELE', [indices.length, ...indices.map(clampByte)]),
  /** Ask how many images are uploaded. Answer arrives on CHARACTERISTIC.notify. */
  checkCount: () => encodeCommand('CHEC'),
  /**
   * Announce an upload of `totalBytes` of RGB data. The three trailing bytes are unidentified in
   * the reverse-engineering notes; zeros are what the known-working captures used.
   */
  beginUpload: (totalBytes) =>
    encodeCommand('DATS', [(totalBytes >> 8) & 0xff, totalBytes & 0xff, 0, 0, 0]),
};

function clampByte(n) {
  return Math.max(0, Math.min(255, n | 0));
}

/**
 * Split raw RGB bytes (3 per pixel) into upload packets for CHARACTERISTIC.upload.
 * Each packet is [byteCount][sequenceNumber][payload...] and is sent PLAINTEXT — not encrypted.
 *
 * Write these with writeValueWithoutResponse() and pace them; Chrome serializes GATT operations, so
 * an unpaced flood just backs up the queue.
 */
export function buildUploadPackets(rgbBytes) {
  const packets = [];
  let sequence = 0;
  for (let offset = 0; offset < rgbBytes.length; offset += UPLOAD_CHUNK_SIZE) {
    const payload = rgbBytes.subarray(offset, offset + UPLOAD_CHUNK_SIZE);
    const packet = new Uint8Array(2 + payload.length);
    packet[0] = payload.length;
    packet[1] = sequence++ & 0xff;
    packet.set(payload, 2);
    packets.push(packet);
  }
  return packets;
}

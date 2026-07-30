/**
 * Verifies the encoding in mask-protocol.js against ground truth:
 *
 *  - the AES path against Node's real aes-128-ecb (multi-block, both directions)
 *  - every command frame against the exact byte sequences that mask-go [go] and
 *    shining-mask [cp] send to real hardware
 *  - bitmap encoding against a column from [go]'s captured Bluetooth dump
 *  - upload packet framing, including the length-byte-includes-sequence quirk
 *
 * See ../docs/protocol.md for the source table. This proves the encoding is right; it does NOT
 * prove a mask accepts it — that still needs hardware.
 *
 * Run: node src/mask-protocol.test.mjs
 */
import crypto from 'node:crypto';
import {
  encryptEcb, decryptEcb, parseNotification, buildCommandFrame, command,
  encodeBitmap, encodeColors, buildUploadPackets,
  MAX_INDICES_PER_COMMAND, MAX_UPLOAD_BYTES,
} from './mask-protocol.js';

const KEY = Buffer.from('32672f7974ad43451d9c6c894a0e8764', 'hex');
const hex = (u8) => Buffer.from(u8).toString('hex');
let pass = 0, fail = 0;
const pad16 = (h) => h + '0'.repeat(32 - h.length);
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got  ${got}\n        want ${want}`);
};

function nodeEcbEncrypt(buf) {
  const c = crypto.createCipheriv('aes-128-ecb', KEY, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]);
}

// --- 1. encryptEcb matches real AES-128-ECB, multi-block ---
const sample = crypto.randomBytes(48);
check('encryptEcb == aes-128-ecb (3 blocks)',
  hex(await encryptEcb(new Uint8Array(sample))), hex(nodeEcbEncrypt(sample)));

// --- 2. decryptEcb round-trips, multi-block (the tricky one) ---
check('decryptEcb(encryptEcb(x)) == x (3 blocks)',
  hex(await decryptEcb(await encryptEcb(new Uint8Array(sample)))), hex(sample));

// --- 3. decryptEcb matches real AES-128-ECB decryption of mask-style responses ---
for (const resp of ['DATSOK', 'REOK', 'DATCPOK', 'PLAYOK']) {
  const plain = Buffer.alloc(16);
  plain[0] = resp.length;
  plain.write(resp, 1, 'ascii');
  const enc = nodeEcbEncrypt(plain);
  check(`parseNotification('${resp}')`, await parseNotification(new Uint8Array(enc)), resp);
}

// --- 4. Command frames match the byte sequences the working implementations send ---
// [cp] shining-mask, verbatim: b'\x06PLAY\x01\x03' + 9 bytes of padding
check('PLAY index 3 frame (vs [cp], zero-padded)',
  hex(buildCommandFrame('PLAY', [1, 3])), pad16('06504c41590103'));

// [go] mask-go SetLight(0x64) => len 6, "LIGHT", brightness
check('LIGHT 100 frame (vs [go])',
  hex(buildCommandFrame('LIGHT', [100])), pad16('064c4947485464'));

// len=5, per [js]'s captured ANIM frames from the official app (see section 8).
check('IMAG 7 frame declares len=5',
  hex(buildCommandFrame('IMAG', [7])), pad16('05494d414707'));

// [go] SetMode(3) => len 5
check('MODE scrollLeft frame (vs [go])',
  hex(buildCommandFrame('MODE', [3])), pad16('054d4f444503'));

// [go] SetTextColorMode(1, 5) => len 3, verb "M"
check('M textColorMode frame (vs [go])',
  hex(buildCommandFrame('M', [1, 5])), pad16('034d0105'));

// [go] InitUpload: 09 DATS <2b total BE> <2b bitmap BE> 00
check('DATS total=160 bitmap=64 (vs [go])',
  hex(buildCommandFrame('DATS', [0x00, 0xa0, 0x00, 0x40, 0])),
  pad16('094441545300a0004000'));
check('DATCP frame (vs [go])',
  hex(buildCommandFrame('DATCP')), pad16('054441544350'));

// --- 5. Bitmap encoding vs [bd]'s worked example ---
// "FFFF0000" per column = all 16 rows lit... verify our encoder produces ffff for a full column
const fullColumn = Array(16).fill(1);
check('encodeBitmap full column -> ffff', hex(encodeBitmap([fullColumn])), 'ffff');
// row 0 only -> low byte bit7 -> 0x80, high byte 0 -> little-endian "8000"
const topOnly = Array(16).fill(0); topOnly[0] = 1;
check('encodeBitmap row0 only -> 8000', hex(encodeBitmap([topOnly])), '8000');
// row 8 only -> high byte bit7 -> 0x80 in second byte -> "0080"
const row8 = Array(16).fill(0); row8[8] = 1;
check('encodeBitmap row8 only -> 0080', hex(encodeBitmap([row8])), '0080');
// row 15 only -> high byte bit0 -> "0001"
const row15 = Array(16).fill(0); row15[15] = 1;
check('encodeBitmap row15 only -> 0001', hex(encodeBitmap([row15])), '0001');

// Cross-check against [go]'s captured "text2" bitmap: first column hex is 0200.
// 0x0200 little-endian => low=0x02, high=0x00 => rows 0-7 bit1 set => row 6.
const goCol = Array(16).fill(0); goCol[6] = 1;
check('encodeBitmap reproduces [go] capture column 0200', hex(encodeBitmap([goCol])), '0200');

check('encodeColors white x2', hex(encodeColors([[255,255,255],[255,0,0]])), 'ffffffff0000');

// --- 6. Upload packet prefix includes the sequence byte ---
const payload = new Uint8Array(200).fill(0xab);
const packets = buildUploadPackets(payload);
check('packet count for 200 bytes @98', String(packets.length), '3');
check('packet0 prefix = 98+1, seq 0', hex(packets[0].subarray(0, 2)), '6300');
check('packet2 length = 4 remaining + 1, seq 2', hex(packets[2].subarray(0, 2)), '0502');
check('packet2 total wire size', String(packets[2].length), '6');

// --- 7. command.* wrappers actually encrypt to the right thing ---
check('command.play(3) == ECB(PLAY frame)',
  hex(await command.play(3)), hex(nodeEcbEncrypt(Buffer.from(buildCommandFrame('PLAY', [1, 3])))));

// --- 8. Decrypted captures of the OFFICIAL APP's traffic, from [js] mask-controller's codes.js ---
// beclamide/mask-controller has no AES key and only replays opaque hex, so these blobs are captures
// of the real app. Decrypting them is the most authoritative wire-format evidence available.
// We compare only the [len][verb][args] prefix: the app's padding is random, ours is zeros.
function nodeEcbDecrypt(hexStr) {
  const d = crypto.createDecipheriv('aes-128-ecb', KEY, null);
  d.setAutoPadding(false);
  const buf = Buffer.from(hexStr.replace(/ /g, ''), 'hex');
  return Buffer.concat([d.update(buf), d.final()]);
}
const capture = (name, cipherHex, expectedFrame) => {
  const plain = nodeEcbDecrypt(cipherHex);
  const n = 1 + plain[0]; // len byte + payload; ignore the app's random padding
  check(name, hex(plain.subarray(0, n)), hex(expectedFrame.subarray(0, n)));
};

// textEffects[] — MODE. These are the frames mask-controller actively sends, so they demonstrably
// work. Confirms len=5, and the mode values: 01 solid, 02 flashing, 03 scroll left, 04 scroll right.
capture('[js] capture: MODE 01 steady',
  '12EC 841F 2E38 A08F 98E6 EE72 B0E1 1125', buildCommandFrame('MODE', [1]));
capture('[js] capture: MODE 03 scroll left',
  '3B12 D51A 2E1B FE44 FEA0 6AF5 8702 7994', buildCommandFrame('MODE', [3]));
capture('[js] capture: MODE 04 scroll right',
  '8A6C 1E81 DB68 8A79 D502 4539 69D9 6F18', buildCommandFrame('MODE', [4]));
capture('[js] capture: MODE 02 flashing',
  '2C37 829A 85A9 6C4E 7D73 3800 A37B 2862', buildCommandFrame('MODE', [2]));

// faces[] — ANIM. THE decisive evidence that ANIM/IMAG declare len=5, not the 6 that [go] sends.
capture('[js] capture: ANIM 3 has len=5, not 6',
  '1C16 3E05 34CB A8D9 E86B 9033 C71F 34CA', buildCommandFrame('ANIM', [3]));
capture('[js] capture: ANIM 2',
  'C977 AF80 4FC0 EA5D 4ED1 2963 955A E602', buildCommandFrame('ANIM', [2]));
capture('[js] capture: ANIM 5',
  'BFF5 86C9 2118 B194 9822 99F5 35AF F19A', buildCommandFrame('ANIM', [5]));

// otherValues[] — FC / BC / SPEED. Settles the verb name as BC, not [go]'s BG.
// Decrypts to 06 "FC" 00 ff ff fe. Confirms the verb, len=6 and the leading enable byte, but the
// near-white value can't settle whether the three color bytes are R,G,B or [bd]'s claimed R,B,G.
capture('[js] capture: FC enable=0, color ff ff fe',
  '7C0B CD66 0671 0D00 734E AC04 1B6B 96E6', buildCommandFrame('FC', [0, 0xff, 0xff, 0xfe]));
capture('[js] capture: background verb is BC, not BG',
  '5638 3E67 630E C14D 33B2 D95A 97A2 EE08', buildCommandFrame('BC', [0, 0x7f, 0x7f, 0x7f]));
capture('[js] capture: SPEED 50',
  '6410 C8FA 2076 D5B7 C64F 44E3 94BC 3E8C', buildCommandFrame('SPEED', [50]));

// finalLightValue — independent confirmation of the DATCP end-of-upload frame.
capture('[js] capture: DATCP',
  'B82B 0CEE 239B C230 3D26 697D B78D 48A4', buildCommandFrame('DATCP'));

// [js] lightValues[] are PLAINTEXT upload packets, and independently confirm our packet framing:
// '6300 ...' = 0x63 (99 = 98 payload + 1 sequence byte), sequence 0; then 0x6301; then '2D02'
// (0x2d = 45 = 44 payload + 1), sequence 2. i.e. the length byte includes the sequence byte.
check('[js] capture: upload packet 0 prefix (98 payload + seq)',
  hex(buildUploadPackets(new Uint8Array(98 + 98 + 44)).map((p) => p[0] === 0x63 && p[1] === 0 ? 1 : 0).slice(0, 1)), '01');
const jsPackets = buildUploadPackets(new Uint8Array(98 + 98 + 44));
check('[js] capture: our prefixes match 6300/6301/2d02',
  jsPackets.map((p) => hex(p.subarray(0, 2))).join(','), '6300,6301,2d02');

// --- 9. Structural limits (see docs/protocol.md#numeric-bounds) ---
const throws = (name, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, String(threw), 'true');
};
check('every command frame is exactly one 16-byte block',
  String(buildCommandFrame('SPEED', [50]).length), '16');
check('MAX_INDICES_PER_COMMAND is 10', String(MAX_INDICES_PER_COMMAND), '10');
throws('playSequence rejects 11 indices',
  () => command.playSequence(Array.from({ length: 11 }, (_, i) => i)));
throws('delete rejects 11 indices',
  () => command.delete(Array.from({ length: 11 }, (_, i) => i)));
throws('buildCommandFrame rejects args overflowing one block',
  () => buildCommandFrame('PLAY', new Array(12).fill(1)));
check('playSequence accepts exactly 10 indices',
  String(buildCommandFrame('PLAY', [10, ...new Array(10).fill(1)]).length), '16');
check('MAX_UPLOAD_BYTES is 256 packets x 98', String(MAX_UPLOAD_BYTES), '25088');
throws('buildUploadPackets rejects a payload that would wrap the sequence byte',
  () => buildUploadPackets(new Uint8Array(MAX_UPLOAD_BYTES + 1)));
check('sequence numbers never wrap at the ceiling',
  String(buildUploadPackets(new Uint8Array(MAX_UPLOAD_BYTES)).at(-1)[1]), '255');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

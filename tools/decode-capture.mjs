#!/usr/bin/env node
/**
 * Decode a Bluetooth HCI snoop capture of the official Shining Mask app.
 *
 *   node tools/decode-capture.mjs bug.zip
 *   node tools/decode-capture.mjs btsnoop_hci.log
 *
 * Reassembles ATT traffic and decrypts the command frames with the known AES key, so a capture of
 * the official app doing a DIY image upload becomes a readable transcript.
 *
 * The point is the SUMMARY at the end: any verb we have never seen is flagged UNKNOWN. The DIY-image
 * path has to address ~48 rows with per-pixel colour and write a persistent slot, none of which
 * `DATS` can express (see ../docs/protocol.md), so it is near-certainly a verb nobody has recorded.
 *
 * No dependencies. Zip extraction shells out to `unzip`, which ships with macOS and most Linux.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY = Buffer.from('32672f7974ad43451d9c6c894a0e8764', 'hex');

/** Verbs and responses we already understand. Anything else is the interesting part. */
const KNOWN_VERBS = new Set([
  'MODE', 'LIGHT', 'IMAG', 'ANIM', 'PLAY', 'SPEED', 'M', 'FC', 'BC', 'BG',
  'DATS', 'DATCP', 'DELE', 'CHEC',
  'DATSOK', 'DATSOKP', 'REOK', 'DATCPOK', 'PLAYOK', 'CHECOK',
]);

// btsnoop timestamps are microseconds since 0000-01-01; this is the offset to the Unix epoch.
const BTSNOOP_EPOCH_DELTA = 0x00dcddb30f2f8000n;

// ---------------------------------------------------------------- input

function readCapture(input) {
  if (!fs.existsSync(input)) {
    console.error(`no such file: ${input}`);
    process.exit(1);
  }
  if (!input.toLowerCase().endsWith('.zip')) return [{ name: input, buf: fs.readFileSync(input) }];

  let names;
  try {
    names = execFileSync('unzip', ['-Z1', input], { encoding: 'utf8' }).split('\n');
  } catch {
    console.error('could not run `unzip`. Extract the zip yourself and pass the .log directly.');
    process.exit(1);
  }
  const hits = names.filter((n) => /btsnoop.*\.(log|cfa)$/i.test(n.trim())).map((n) => n.trim());
  if (!hits.length) {
    console.error(
      'No btsnoop log inside the zip. Expected FS/data/misc/bluetooth/logs/btsnoop_hci.log\n' +
        'Was "Enable Bluetooth HCI snoop log" ON during the capture, and turned OFF before taking\n' +
        'the bug report? Turning it off is what flushes the file.',
    );
    process.exit(1);
  }
  return hits.map((name) => ({
    name,
    buf: execFileSync('unzip', ['-p', input, name], { maxBuffer: 1 << 30 }),
  }));
}

// ---------------------------------------------------------------- btsnoop

function* btsnoopRecords(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 8) !== 'btsnoop\0') {
    throw new Error('not a btsnoop file (bad magic)');
  }
  let off = 16; // 8 magic + 4 version + 4 datalink
  while (off + 24 <= buf.length) {
    const includedLen = buf.readUInt32BE(off + 4);
    const flags = buf.readUInt32BE(off + 8);
    const ts = buf.readBigUInt64BE(off + 16);
    const start = off + 24;
    const end = start + includedLen;
    if (end > buf.length) break;
    yield {
      received: (flags & 1) === 1,
      data: buf.subarray(start, end),
      unixMicros: ts - BTSNOOP_EPOCH_DELTA,
    };
    off = end;
  }
}

const clock = (micros) => {
  const d = new Date(Number(micros / 1000n));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 23) : '??:??:??.???';
};

// ---------------------------------------------------------------- HCI/L2CAP/ATT

/**
 * Pull ATT PDUs out of HCI ACL traffic, reassembling L2CAP fragments per connection handle.
 * Records may or may not carry a leading H4 packet-type byte depending on the datalink type, so
 * both shapes are accepted.
 */
function* attPdus(records) {
  const pending = new Map(); // handle -> {need, chunks}
  for (const rec of records) {
    let d = rec.data;
    if (d.length && (d[0] === 0x01 || d[0] === 0x02 || d[0] === 0x03 || d[0] === 0x04)) {
      if (d[0] !== 0x02) continue; // not ACL
      d = d.subarray(1);
    }
    if (d.length < 4) continue;

    const handleFlags = d.readUInt16LE(0);
    const handle = handleFlags & 0x0fff;
    const pb = (handleFlags >> 12) & 0x3;
    const aclLen = d.readUInt16LE(2);
    const payload = d.subarray(4, 4 + aclLen);

    let assembled = null;
    if (pb === 0x1) {
      const acc = pending.get(handle);
      if (!acc) continue;
      acc.chunks.push(payload);
      const total = acc.chunks.reduce((n, c) => n + c.length, 0);
      if (total >= acc.need) {
        assembled = Buffer.concat(acc.chunks);
        pending.delete(handle);
      }
    } else {
      if (payload.length < 4) continue;
      const l2capLen = payload.readUInt16LE(0);
      const cid = payload.readUInt16LE(2);
      if (cid !== 0x0004) continue; // ATT only
      const body = payload.subarray(4);
      if (body.length >= l2capLen) assembled = payload;
      else pending.set(handle, { need: l2capLen + 4, chunks: [payload] });
    }
    if (!assembled) continue;

    const cid = assembled.readUInt16LE(2);
    if (cid !== 0x0004) continue;
    const att = assembled.subarray(4);
    if (att.length < 3) continue;

    const opcode = att[0];
    const OPS = { 0x12: 'write-req', 0x52: 'write-cmd', 0x1b: 'notify', 0x1d: 'indicate' };
    const kind = OPS[opcode];
    if (!kind) continue;

    yield {
      kind,
      attHandle: att.readUInt16LE(1),
      value: Buffer.from(att.subarray(3)),
      received: rec.received,
      at: clock(rec.unixMicros),
    };
  }
}

// ---------------------------------------------------------------- mask protocol

function decryptEcb(buf) {
  const d = createDecipheriv('aes-128-ecb', KEY, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(buf), d.final()]);
}

const printable = (b) => b >= 0x20 && b <= 0x7e;

/**
 * Try to read a value as an encrypted command frame: [len][ASCII verb][args][padding].
 * Handle-agnostic on purpose — we don't know the ATT handles, so we identify by shape.
 */
function asCommand(value) {
  if (value.length === 0 || value.length % 16 !== 0) return null;
  let plain;
  try {
    plain = decryptEcb(value);
  } catch {
    return null;
  }
  const len = plain[0];
  if (len < 1 || len > 15) return null;

  let verb = '';
  for (let i = 1; i <= len && i < plain.length; i++) {
    const b = plain[i];
    if (b >= 0x41 && b <= 0x5a) verb += String.fromCharCode(b); // A-Z
    else break;
  }
  if (verb.length === 0) return null;
  const args = plain.subarray(1 + verb.length, 1 + len);
  return { verb, args, plain, len };
}

/** Upload packets are plaintext [byteCount][sequence][payload], byteCount including the seq byte. */
function asUploadPacket(value) {
  if (value.length < 3 || value.length > 100) return null;
  if (value[0] !== value.length - 1) return null;
  return { seq: value[1], payload: value.subarray(2) };
}

// ---------------------------------------------------------------- main

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/decode-capture.mjs <bug.zip | btsnoop_hci.log>');
  process.exit(1);
}

const outDir = 'capture-out';
const verbCounts = new Map();
const uploads = [];
let current = null;
let attEvents = 0;
let lines = 0;

for (const { name, buf } of readCapture(input)) {
  console.log(`\n=== ${name} (${buf.length.toLocaleString()} bytes) ===\n`);
  let records;
  try {
    records = [...btsnoopRecords(buf)];
  } catch (err) {
    console.log(`  skipped: ${err.message}`);
    continue;
  }

  for (const pdu of attPdus(records)) {
    attEvents++;
    const dir = pdu.received ? '<-' : '->';
    const cmd = asCommand(pdu.value);

    if (cmd) {
      verbCounts.set(cmd.verb, (verbCounts.get(cmd.verb) ?? 0) + 1);
      const flag = KNOWN_VERBS.has(cmd.verb) ? '   ' : '***';
      console.log(
        `${pdu.at} ${dir} ${flag} ${cmd.verb.padEnd(8)} len=${String(cmd.len).padEnd(3)} ` +
          `args=${cmd.args.toString('hex').replace(/(..)/g, '$1 ').trim() || '-'}`,
      );
      lines++;

      // Only OUTBOUND commands open an upload group; DATSOK etc. are inbound responses.
      if (!pdu.received && !cmd.verb.endsWith('OK') && /^DAT/.test(cmd.verb) && cmd.verb !== 'DATCP') {
        current = { verb: cmd.verb, args: Buffer.from(cmd.args), chunks: [], at: pdu.at };
      } else if (!pdu.received && cmd.verb === 'DATCP' && current) {
        current.payload = Buffer.concat(current.chunks);
        uploads.push(current);
        current = null;
      }
      continue;
    }

    const pkt = asUploadPacket(pdu.value);
    if (pkt && !pdu.received) {
      if (current) current.chunks.push(pkt.payload);
      if (pkt.seq === 0) {
        console.log(`${pdu.at} ${dir}     upload   seq=0 (${pdu.value.length}B) …`);
        lines++;
      }
      continue;
    }

    // Anything we can't classify is worth seeing — it may be the path we're missing.
    if (pdu.value.length) {
      console.log(
        `${pdu.at} ${dir}     raw      handle=0x${pdu.attHandle.toString(16)} ` +
          `${pdu.value.length}B ${pdu.value.subarray(0, 24).toString('hex')}` +
          (pdu.value.length > 24 ? '…' : ''),
      );
      lines++;
    }
  }
}

console.log(`\n${'='.repeat(72)}`);
if (!attEvents) {
  console.log(
    'No ATT traffic found.\n\n' +
      'Most likely the snoop log was not actually recording. Check that "Enable Bluetooth HCI\n' +
      'snoop log" was ON during the upload, and that you turned it OFF before taking the bug\n' +
      'report — switching it off is what flushes the buffer to disk. Some devices also need a\n' +
      'reboot after enabling it.',
  );
  process.exit(0);
}

console.log(`ATT events: ${attEvents}, decoded lines: ${lines}\n`);
console.log('Verbs seen:');
for (const [verb, n] of [...verbCounts].sort((a, b) => b[1] - a[1])) {
  const known = KNOWN_VERBS.has(verb);
  console.log(`  ${known ? '   ' : '***'} ${verb.padEnd(10)} x${String(n).padEnd(5)}${known ? '' : '  <-- UNKNOWN, this is what we are looking for'}`);
}

if (uploads.length) {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\nUpload payloads (${uploads.length}):`);
  uploads.forEach((u, i) => {
    const file = path.join(outDir, `payload-${String(i).padStart(2, '0')}-${u.verb}.bin`);
    fs.writeFileSync(file, u.payload);
    const n = u.payload.length;
    const geom = [
      [46, 48, 3, 'per-pixel RGB @46x48'],
      [46, 16, 3, 'per-pixel RGB @46x16'],
      [46, 1, 5, 'bitmap+per-column @46'],
    ]
      .filter(([w, h, bpp]) => n === w * h * bpp)
      .map(([, , , label]) => label);
    console.log(
      `  ${file}  ${n.toLocaleString()}B  header=${u.args.toString('hex')}` +
        (geom.length ? `  ← matches ${geom.join(', ')}` : ''),
    );
  });
  console.log('\nIf two captures differ by one pixel, diff the payloads to pin the encoding:');
  console.log(`  cmp -l ${outDir}/payload-00-*.bin ${outDir}/payload-01-*.bin | head`);
}

const unknown = [...verbCounts.keys()].filter((v) => !KNOWN_VERBS.has(v));
console.log(
  unknown.length
    ? `\nFound ${unknown.length} unknown verb(s): ${unknown.join(', ')}\nPaste the lines above and we can decode the format.`
    : '\nNo unknown verbs — the DIY upload may use DATS after all, or the capture missed it.',
);

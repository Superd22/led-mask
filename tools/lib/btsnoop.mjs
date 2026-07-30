/**
 * Shared btsnoop / HCI / L2CAP / ATT parsing plus Shining Mask frame decoding.
 * Used by decode-capture.mjs and decode-viz.mjs.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';

export const KEY = Buffer.from('32672f7974ad43451d9c6c894a0e8764', 'hex');

/** Verbs and responses already understood. Anything else is a discovery. */
export const KNOWN_VERBS = new Set([
  'MODE', 'LIGHT', 'IMAG', 'ANIM', 'PLAY', 'SPEED', 'M', 'FC', 'BC', 'BG',
  'DATS', 'DATCP', 'DELE', 'CHEC', 'TIME',
  'DATSOK', 'DATSOKP', 'REOK', 'DATCPOK', 'PLAYOK', 'CHECOK', 'TIMEERR',
]);

// btsnoop timestamps are microseconds since 0000-01-01; offset to the Unix epoch.
const BTSNOOP_EPOCH_DELTA = 0x00dcddb30f2f8000n;

export function readCapture(input) {
  if (!fs.existsSync(input)) {
    console.error(`no such file: ${input}`);
    process.exit(1);
  }
  if (!input.toLowerCase().endsWith('.zip')) return [{ name: input, buf: fs.readFileSync(input) }];

  let names;
  try {
    names = execFileSync('unzip', ['-Z1', input], { encoding: 'utf8' }).split('\n');
  } catch {
    console.error('could not run `unzip`. Extract the zip and pass the .log directly.');
    process.exit(1);
  }
  const hits = names.filter((n) => /btsnoop.*\.(log|cfa)$/i.test(n.trim())).map((n) => n.trim());
  if (!hits.length) {
    console.error(
      'No btsnoop log in the zip.\n' +
        'Check Developer options -> Bluetooth HCI snoop log is set to ENABLED (not Filtered), then\n' +
        'reboot, reproduce, and take the bug report WITHOUT turning the log off.',
    );
    process.exit(1);
  }
  return hits.map((name) => ({
    name,
    buf: execFileSync('unzip', ['-p', input, name], { maxBuffer: 1 << 30 }),
  }));
}

export function* btsnoopRecords(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 8) !== 'btsnoop\0') {
    throw new Error('not a btsnoop file (bad magic)');
  }
  let off = 16;
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

export const clock = (micros) => {
  const d = new Date(Number(micros / 1000n));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 23) : '??:??:??.???';
};

/** Pull ATT PDUs out of HCI ACL traffic, reassembling L2CAP fragments per connection handle. */
export function* attPdus(records) {
  const pending = new Map();
  for (const rec of records) {
    let d = rec.data;
    if (d.length && d[0] >= 0x01 && d[0] <= 0x04) {
      if (d[0] !== 0x02) continue;
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
      if (acc.chunks.reduce((n, c) => n + c.length, 0) >= acc.need) {
        assembled = Buffer.concat(acc.chunks);
        pending.delete(handle);
      }
    } else {
      if (payload.length < 4) continue;
      const l2capLen = payload.readUInt16LE(0);
      if (payload.readUInt16LE(2) !== 0x0004) continue;
      if (payload.subarray(4).length >= l2capLen) assembled = payload;
      else pending.set(handle, { need: l2capLen + 4, chunks: [payload] });
    }
    if (!assembled || assembled.readUInt16LE(2) !== 0x0004) continue;

    const att = assembled.subarray(4);
    if (att.length < 3) continue;
    const OPS = { 0x12: 'write-req', 0x52: 'write-cmd', 0x1b: 'notify', 0x1d: 'indicate' };
    const kind = OPS[att[0]];
    if (!kind) continue;

    yield {
      kind,
      attHandle: att.readUInt16LE(1),
      value: Buffer.from(att.subarray(3)),
      received: rec.received,
      micros: rec.unixMicros,
      at: clock(rec.unixMicros),
    };
  }
}

export function decryptEcb(buf) {
  const d = createDecipheriv('aes-128-ecb', KEY, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(buf), d.final()]);
}

/**
 * Read a value as an encrypted command frame: [len][ASCII verb][args][padding].
 * Handle-agnostic on purpose — ATT handles aren't knowable from a capture alone.
 */
export function asCommand(value) {
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
    if (b >= 0x41 && b <= 0x5a) verb += String.fromCharCode(b);
    else break;
  }
  if (verb) return { verb, args: plain.subarray(1 + verb.length, 1 + len), plain, len };

  // Not every frame uses an ASCII verb. The sound visualizer stream is [len][effect][24 nibbles],
  // with a BINARY opcode — assuming ASCII here previously made the whole stream invisible.
  return {
    verb: `#${plain[1].toString(16).padStart(2, '0')}`,
    binary: plain[1],
    args: plain.subarray(2, 1 + len),
    plain,
    len,
  };
}

/**
 * Decode a sound-visualizer frame: [0x0f][effect][12 bytes = 24 packed nibbles][00 00].
 * Each nibble is one band level, 0-15.
 */
export function asSpectrum(cmd) {
  if (!cmd || cmd.binary === undefined || cmd.len !== 0x0f) return null;
  const bands = [];
  for (let i = 0; i < 12; i++) {
    const b = cmd.args[i];
    if (b === undefined) return null;
    bands.push(b >> 4, b & 0x0f);
  }
  return { effect: cmd.binary, bands };
}

/** Upload packets are plaintext [byteCount][sequence][payload]; byteCount includes the seq byte. */
export function asUploadPacket(value) {
  if (value.length < 3 || value.length > 100) return null;
  const count = value[0];
  if (count < 2 || count > value.length - 1) return null;
  return { seq: value[1], payload: value.subarray(2, 1 + count) };
}

/** All decodable command frames from a capture, in time order. */
export function collectFrames(inputs) {
  const out = [];
  for (const { name, buf } of inputs) {
    let records;
    try {
      records = [...btsnoopRecords(buf)];
    } catch {
      continue;
    }
    for (const pdu of attPdus(records)) {
      const cmd = asCommand(pdu.value);
      out.push({
        file: name,
        micros: pdu.micros,
        at: pdu.at,
        received: pdu.received,
        value: pdu.value,
        cmd,
        pkt: cmd ? null : asUploadPacket(pdu.value),
      });
    }
  }
  return out.sort((a, b) => Number(a.micros - b.micros));
}

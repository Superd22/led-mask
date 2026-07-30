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
import fs from 'node:fs';
import path from 'node:path';
import {
  readCapture, btsnoopRecords, attPdus, asCommand, asUploadPacket, KNOWN_VERBS, clock,
} from './lib/btsnoop.mjs';

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

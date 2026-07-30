#!/usr/bin/env node
/**
 * Session analyser for a capture of the official app's SOUND VISUALIZER.
 *
 *   node tools/decode-viz.mjs bug3.zip
 *   node tools/decode-viz.mjs bug3.zip --csv SPEC     # dump one verb's args over time
 *   node tools/decode-viz.mjs bug3.zip --gap 1.0      # segment threshold, seconds
 *
 * Deliberately NOT a line-by-line dump. If the app does the FFT on the phone and streams levels,
 * there will be thousands of frames and a transcript is unreadable. Instead this answers the two
 * questions that decide the architecture:
 *
 *   1. Is the visualizer ON-MASK or HOST-DRIVEN? A single mode command followed by silence means the
 *      mask has a microphone and runs the effect itself. A sustained high-rate stream means the phone
 *      is analysing audio and pushing values — which we could replicate from Web Audio.
 *
 *   2. If host-driven, which arg bytes carry the audio? Per-byte statistics separate a constant
 *      (mode/type) from a slowly-stepping index from a fast-moving continuous level.
 *
 * Output is grouped into idle-separated SEGMENTS so it can be lined up with what you did, e.g.
 * "opened viz / picked effect / changed track / switched to mic / spoke".
 */
import fs from 'node:fs';
import {
  readCapture, collectFrames, KNOWN_VERBS, asUploadPacket, asSpectrum,
} from './lib/btsnoop.mjs';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const csvVerb = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
const gapSec = args.includes('--gap') ? Number(args[args.indexOf('--gap') + 1]) : 1.5;

if (!input) {
  console.error('usage: node tools/decode-viz.mjs <bug.zip | btsnoop.log> [--csv VERB] [--gap SEC]');
  process.exit(1);
}

const frames = collectFrames(readCapture(input));
const cmds = frames.filter((f) => f.cmd);

if (!cmds.length) {
  console.error(
    'No decodable command frames found.\n' +
      'If the capture has ATT traffic but nothing decrypts, the app may be talking to a different\n' +
      'device. If there is no ATT traffic at all, the snoop log was probably in Filtered mode.',
  );
  process.exit(1);
}

const secs = (m) => Number(m - cmds[0].micros) / 1e6;

// ---------------------------------------------------------------- per-verb argument statistics

/**
 * Classify each argument byte position. A constant is a mode/flag; a handful of distinct values is
 * an index or enum; many values changing fast is the audio signal itself.
 */
function analyseArgs(entries) {
  const width = Math.max(...entries.map((e) => e.cmd.args.length));
  const cols = [];
  for (let i = 0; i < width; i++) {
    const vals = entries.map((e) => e.cmd.args[i]).filter((v) => v !== undefined);
    if (!vals.length) continue;
    const distinct = new Set(vals);
    let churn = 0;
    for (let k = 1; k < vals.length; k++) if (vals[k] !== vals[k - 1]) churn++;
    cols.push({
      i,
      distinct: distinct.size,
      min: Math.min(...vals),
      max: Math.max(...vals),
      changeRate: vals.length > 1 ? churn / (vals.length - 1) : 0,
      sample: [...distinct].slice(0, 8),
    });
  }
  return cols;
}

function describeCol(c, rate) {
  if (c.distinct === 1) return `constant 0x${c.min.toString(16).padStart(2, '0')}`;
  const span = `0x${c.min.toString(16).padStart(2, '0')}-0x${c.max.toString(16).padStart(2, '0')}`;
  const pct = Math.round(c.changeRate * 100);
  if (c.distinct <= 12) {
    const set = c.sample.map((v) => v).join(',');
    return `${c.distinct} values {${set}${c.distinct > 8 ? ',…' : ''}} ${span}, changes ${pct}%`;
  }
  const fast = c.changeRate > 0.5 && rate > 5;
  return `${c.distinct} values ${span}, changes ${pct}%${fast ? '   <-- CONTINUOUS: likely the audio level' : ''}`;
}

// ---------------------------------------------------------------- segments

const segments = [];
let seg = null;
for (const f of cmds) {
  if (!seg || secs(f.micros) - secs(seg.last) > gapSec) {
    seg = { start: f.micros, last: f.micros, frames: [] };
    segments.push(seg);
  }
  seg.last = f.micros;
  seg.frames.push(f);
}

console.log(`\n${'='.repeat(78)}`);
console.log(`SESSION: ${cmds.length} command frames over ${secs(cmds.at(-1).micros).toFixed(1)}s`);
console.log(`Segments split on gaps > ${gapSec}s — line these up with what you did.`);
console.log('='.repeat(78));

segments.forEach((s, idx) => {
  const dur = Number(s.last - s.start) / 1e6;
  const counts = new Map();
  for (const f of s.frames) {
    const v = f.cmd.verb;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const rate = dur > 0.2 ? (s.frames.length / dur).toFixed(1) : '-';
  console.log(
    `\n--- segment ${idx + 1}  t=${secs(s.start).toFixed(1)}s  dur=${dur.toFixed(1)}s  ` +
      `${s.frames.length} frames  ${rate}/s`,
  );
  for (const [verb, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const mark = KNOWN_VERBS.has(verb) ? '   ' : '***';
    const sample = s.frames.filter((f) => f.cmd.verb === verb);
    const uniq = new Set(sample.map((f) => f.cmd.args.toString('hex')));
    const shown = [...uniq].slice(0, 4).join('  ');
    console.log(
      `  ${mark} ${verb.padEnd(9)} x${String(n).padEnd(6)} ${uniq.size} distinct args` +
        (uniq.size <= 4 ? `: ${shown}` : `: ${shown} …`),
    );
  }
});

// ---------------------------------------------------------------- per-verb detail

console.log(`\n${'='.repeat(78)}`);
console.log('PER-VERB ANALYSIS');
console.log('='.repeat(78));

const byVerb = new Map();
for (const f of cmds) {
  const key = `${f.cmd.verb}${f.received ? ' <-' : ' ->'}`;
  if (!byVerb.has(key)) byVerb.set(key, []);
  byVerb.get(key).push(f);
}

for (const [key, entries] of [...byVerb].sort((a, b) => b[1].length - a[1].length)) {
  const verb = entries[0].cmd.verb;
  const dur = Number(entries.at(-1).micros - entries[0].micros) / 1e6;
  const rate = dur > 0.2 ? entries.length / dur : 0;
  const known = KNOWN_VERBS.has(verb);
  const dir = entries[0].received ? 'inbound' : 'outbound';
  console.log(
    `\n${known ? '   ' : '***'} ${verb}  x${entries.length}  ${dir}  ` +
      `t=${secs(entries[0].micros).toFixed(1)}..${secs(entries.at(-1).micros).toFixed(1)}s  ` +
      `${rate.toFixed(1)}/s${known ? '' : '   <-- UNKNOWN VERB'}`,
  );
  for (const c of analyseArgs(entries)) {
    console.log(`      arg[${c.i}]  ${describeCol(c, rate)}`);
  }
}

// ---------------------------------------------------------------- spectrum stream

const spectra = cmds.map((f) => ({ f, s: asSpectrum(f.cmd) })).filter((x) => x.s);
if (spectra.length) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('SOUND VISUALIZER STREAM');
  console.log('='.repeat(78));
  const dur = Number(spectra.at(-1).f.micros - spectra[0].f.micros) / 1e6;
  console.log(
    `${spectra.length} frames over ${dur.toFixed(1)}s = ${(spectra.length / dur).toFixed(1)}/s\n` +
      `Format: [0x0f][effect][12 bytes = 24 packed nibbles][00 00], one nibble per band, 0-15.\n`,
  );

  const effects = [...new Set(spectra.map((x) => x.s.effect))].sort();
  console.log(`Effects seen: ${effects.map((e) => `0x${e.toString(16).padStart(2, '0')}`).join(', ')}`);

  // Contiguous runs of one effect = the periods between the user changing settings.
  const blocks = [];
  for (const x of spectra) {
    const last = blocks.at(-1);
    if (!last || last.effect !== x.s.effect) blocks.push({ effect: x.s.effect, a: x.f, b: x.f, n: 0, peak: 0 });
    const blk = blocks.at(-1);
    blk.b = x.f;
    blk.n++;
    blk.peak = Math.max(blk.peak, ...x.s.bands);
  }
  console.log('\nEffect blocks (line these up with your actions):');
  for (const b of blocks.filter((x) => x.n > 2)) {
    const d = Number(b.b.micros - b.a.micros) / 1e6;
    console.log(
      `  effect 0x${b.effect.toString(16).padStart(2, '0')}  ` +
        `${secs(b.a.micros).toFixed(1)}..${secs(b.b.micros).toFixed(1)}s  ` +
        `n=${String(b.n).padEnd(4)} ${(b.n / Math.max(0.1, d)).toFixed(1)}/s  peak band ${b.peak}`,
    );
  }

  // A crude sparkline of total energy, to eyeball whether it tracks the audio.
  const N = 60;
  const step = Math.max(1, Math.floor(spectra.length / N));
  const ramp = ' .:-=+*#%@';
  let spark = '';
  for (let i = 0; i < spectra.length; i += step) {
    const avg = spectra[i].s.bands.reduce((a, b) => a + b, 0) / 24;
    spark += ramp[Math.min(ramp.length - 1, Math.round((avg / 15) * (ramp.length - 1)))];
  }
  console.log(`\nEnergy over time:\n  |${spark}|`);
}

// ---------------------------------------------------------------- verdict

console.log(`\n${'='.repeat(78)}`);
const unknown = [...new Set(cmds.map((f) => f.cmd.verb))].filter((v) => !KNOWN_VERBS.has(v));
const streaming = [...byVerb.entries()].filter(([, e]) => {
  if (e[0].received) return false; // responses are not the phone driving anything
  if (e[0].cmd.verb === 'DATS' || e[0].cmd.verb === 'DATCP') return false; // upload bookkeeping
  const dur = Number(e.at(-1).micros - e[0].micros) / 1e6;
  return e.length > 50 && dur > 2 && e.length / dur > 5;
});

if (spectra.length) {
  console.log('HOST-DRIVEN, and decoded. The phone runs the FFT and streams band levels;');
  console.log('the mask only renders. We can drive this from Web Audio at the same rate.');
} else if (streaming.length) {
  console.log('HOST-DRIVEN. The phone is streaming values to the mask:');
  for (const [, e] of streaming) {
    const dur = Number(e.at(-1).micros - e[0].micros) / 1e6;
    console.log(`  ${e[0].cmd.verb} at ${(e.length / dur).toFixed(1)}/s over ${dur.toFixed(1)}s`);
  }
  console.log('\n=> We can replicate this from Web Audio: AnalyserNode -> the same command.');
  console.log('   Note the rate: it is also the practical ceiling for our own visualizer.');
} else {
  console.log('ON-MASK. No sustained stream — the mask appears to run the effect itself,');
  console.log('which implies it has a microphone and we only need to select a mode.');
  console.log('=> Look for a low-frequency verb whose arg changed when you switched effect/source.');
}

if (unknown.length) console.log(`\nUnknown verbs: ${unknown.join(', ')}`);
else console.log('\nNo unknown verbs — the visualizer reuses commands we already know.');

// Raw non-command writes can carry a stream too (the bulk characteristic is plaintext).
const raw = frames.filter((f) => !f.cmd && !f.received && f.value.length);
if (raw.length) {
  const pkts = raw.filter((f) => asUploadPacket(f.value)).length;
  console.log(
    `\n${raw.length} non-command writes (${pkts} look like upload packets, ${raw.length - pkts} other).`,
  );
  const other = raw.filter((f) => !asUploadPacket(f.value)).slice(0, 6);
  for (const f of other) {
    console.log(`  ${f.at} ${f.value.length}B ${f.value.subarray(0, 20).toString('hex')}`);
  }
}

if (csvVerb) {
  const entries = byVerb.get(csvVerb.toUpperCase());
  if (!entries) {
    console.log(`\n--csv: no verb "${csvVerb}"`);
  } else {
    const file = `capture-out/${csvVerb.toLowerCase()}-args.csv`;
    fs.mkdirSync('capture-out', { recursive: true });
    const width = Math.max(...entries.map((e) => e.cmd.args.length));
    const head = ['t_seconds', ...Array.from({ length: width }, (_, i) => `arg${i}`)].join(',');
    const rows = entries.map((e) =>
      [secs(e.micros).toFixed(3), ...Array.from({ length: width }, (_, i) => e.cmd.args[i] ?? '')].join(','),
    );
    fs.writeFileSync(file, `${head}\n${rows.join('\n')}\n`);
    console.log(`\nWrote ${file} (${entries.length} rows) — plot it against the audio.`);
  }
}
console.log();

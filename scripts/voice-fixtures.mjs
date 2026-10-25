// Builds the integration WAV fixtures (16 kHz mono s16le) from macOS `say`. Synthetic speech: it
// exercises the real tap/VAD/wake pipeline deterministically; replace with `sox -d -r 16000 -c 1 -b 16
// name.wav trim 0 5` recordings for acoustic acceptance.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = 'tests/fixtures/voice';
const scratch = mkdtempSync(path.join(os.tmpdir(), 'steady-fixtures-'));
const speech = text => {
  const file = path.join(scratch, `${text.replace(/\W+/g, '_')}.wav`);
  execFileSync('say', ['-v', 'Samantha', '-o', file, '--data-format=LEI16@16000', text]);
  const bytes = readFileSync(file);
  const data = bytes.indexOf('data');
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset + data + 8));
};
let seed = 7;
const noise = seconds => Int16Array.from({ length: Math.round(seconds * 16000) }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 7) - 3; });
const join = (...parts) => { const total = parts.reduce((n, p) => n + p.length, 0); const pcm = new Int16Array(total); let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; } return pcm; };
const wav = (name, pcm) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path.join(out, name), Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
};
try {
  wav('wake_plus_command_one_breath.wav', join(noise(0.5), speech('Hey Cartesia, pen down.'), noise(2.5)));
  wav('wake_pause_command.wav', join(noise(0.5), speech('Hey Cartesia.'), noise(2), speech('Pen down.'), noise(2.5)));
  wav('silence_5s.wav', noise(5));
  wav('double_wake_1s_apart.wav', join(noise(0.5), speech('Hey Cartesia.'), noise(0.2), speech('Hey Cartesia.'), noise(2)));
  wav('mention_brush_no_wake.wav', join(noise(0.5), speech('Can you switch to the brush please.'), noise(2)));
  wav('conversation_no_command.wav', join(noise(0.5), speech('I was thinking we could grab lunch later and talk about the project timeline.'), noise(2)));
  console.log('fixtures written to', out);
} finally { rmSync(scratch, { recursive: true, force: true }); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTools, compressFile, collectInputs, runBatch } from '../scripts/audio-compressor.mjs';

function wave(seconds = 3) {
  const rate = 24000, samples = rate * seconds, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / rate * 440 * 2 * Math.PI) * 12000), 44 + index * 2);
  return data;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'classnote-compress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, '课堂 & $() 测试.wav'), outputDir = join(directory, '结果');
  await mkdir(outputDir); await writeFile(input, wave());
  let tools;
  try { tools = await findTools(); } catch { t.skip('Optional local FFmpeg components are not installed.'); }
  return { directory, input, outputDir, tools };
}

test('compression preserves the original, refuses to overwrite, and validates full-length output', async t => {
  const { input, outputDir, tools } = await fixture(t); if (!tools) return;
  const original = await readFile(input), sentinel = join(outputDir, '课堂 & $() 测试.课堂32k.m4a');
  await writeFile(sentinel, 'existing result');
  const result = await compressFile(input, { outputDir, tools, preset: 'compact' });
  assert.equal(result.status, 'completed'); assert.match(result.output, / \(2\)\.m4a$/);
  assert.equal(await readFile(sentinel, 'utf8'), 'existing result');
  assert.deepEqual(await readFile(input), original); assert.ok(result.outputBytes < original.length);
  assert.ok(Math.abs(result.outputDuration - 3) < 0.1); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!(await readdir(outputDir)).some(name => name.includes('partial')));
});

test('folders deduplicate input and exclude output folders and generated compressed recordings', async t => {
  const { directory, input, outputDir } = await fixture(t);
  await writeFile(join(outputDir, 'previous.wav'), wave()); await writeFile(join(directory, 'old.课堂32k.m4a'), 'old result');
  const inputs = await collectInputs([directory, input], outputDir);
  assert.deepEqual(inputs, [input]);
});

test('low bitrate recordings are skipped and a broken file does not stop the next recording', async t => {
  const { directory, input, outputDir, tools } = await fixture(t); if (!tools) return;
  const compressed = await compressFile(input, { outputDir, tools, preset: 'compact' });
  const low = join(directory, 'low.m4a'); await copyFile(compressed.output, low);
  const skipped = await compressFile(low, { outputDir, tools, preset: 'clear' }); assert.equal(skipped.status, 'skipped');
  const broken = join(directory, 'broken.m4a'); await writeFile(broken, 'invalid');
  const batch = await runBatch({ inputs: [broken, input], outputDir, preset: 'clear' });
  assert.equal(batch.failed, 1); assert.equal(batch.completed, 1);
  const report = JSON.parse(await readFile(batch.report, 'utf8'));
  assert.deepEqual(report.results.map(result => result.status), ['failed', 'completed']);
});

test('stopping an encode removes its partial output and preserves the input', async t => {
  const { input, outputDir, tools } = await fixture(t); if (!tools) return;
  const original = wave(120); await writeFile(input, original);
  const abort = new AbortController();
  await assert.rejects(compressFile(input, { outputDir, tools, preset: 'compact', signal: abort.signal, emit: event => { if (event.type === 'progress') abort.abort(); } }));
  assert.deepEqual(await readFile(input), original); assert.deepEqual(await readdir(outputDir), []);
});

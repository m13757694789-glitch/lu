import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('..', import.meta.url));
export const presets = Object.freeze({
  clear: { bitrate: 64000, label: '较清晰 · 64 kbps', suffix: '课堂64k' },
  compact: { bitrate: 32000, label: '更省空间 · 32 kbps', suffix: '课堂32k' },
});
const extensions = new Set(['.m4a', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.wma']);
const isWithin = (path, directory) => path === directory || path.startsWith(directory + sep);
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export async function findTools() {
  const directories = [join(root, '.tools', 'audio', 'bin')];
  try {
    for (const entry of await readdir(join(root, '.tools', 'audio'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('ffmpeg-')) directories.push(join(root, '.tools', 'audio', entry.name, 'bin'));
    }
  } catch { /* A system installation is also supported. */ }
  for (const directory of directories) {
    const ffmpeg = join(directory, 'ffmpeg.exe'), ffprobe = join(directory, 'ffprobe.exe');
    try { await access(ffmpeg); await access(ffprobe); return { ffmpeg, ffprobe }; } catch { /* Try the next location. */ }
  }
  const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  try { await execute(tools.ffprobe, ['-version']); return tools; }
  catch { throw new Error('缺少压缩组件，请先双击“安装录音压缩组件.cmd”。'); }
}

function execute(executable, args, { signal, onLine, timeout = 0 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', error = '', spawnError;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (!onLine) output += chunk; });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-8192); });
    const lines = onLine ? createInterface({ input: child.stdout }) : null;
    lines?.on('line', onLine);
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      if (timer) clearTimeout(timer);
      lines?.close();
      if (signal?.aborted) reject(new Error('已停止压缩，原文件保留。'));
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(error.trim() || `音频处理失败（${code}）`));
      else done(output);
    });
  });
}

export async function probeAudio(file, tools, signal) {
  const text = await execute(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration:stream=codec_name,duration,bit_rate,sample_rate,channels', '-of', 'json', resolve(file)], { signal, timeout: 30000 });
  const info = JSON.parse(text), stream = info.streams?.[0];
  const duration = Number(stream?.duration || info.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效录音时长，请检查文件是否完整。');
  return { duration, codec: stream.codec_name, bitrate: Number(stream.bit_rate) || 0, channels: stream.channels, sampleRate: Number(stream.sample_rate) };
}

export async function collectInputs(inputs, outputDir) {
  const files = [], seen = new Set(), excluded = outputDir ? key(outputDir) : null;
  async function visit(path) {
    const absolute = resolve(path), normalized = key(absolute);
    if (seen.has(normalized) || excluded && isWithin(normalized, excluded)) return;
    seen.add(normalized);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        await visit(join(absolute, entry.name));
      }
    } else if (info.isFile() && extensions.has(extname(absolute).toLowerCase()) && !/\.课堂(?:32|64)k(?: \(\d+\))?\.m4a$/i.test(absolute)) files.push(absolute);
  }
  for (const input of inputs) await visit(input);
  return files;
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// A same-volume hard link publishes the verified file atomically without overwriting.
async function publish(temporary, outputDir, name, suffix) {
  for (let index = 0; index < 10000; index++) {
    const output = join(outputDir, `${name}.${suffix}${index ? ` (${index + 1})` : ''}.m4a`);
    try { await link(temporary, output); return output; }
    catch (error) {
      if (error.code === 'EEXIST') continue;
      // Some removable drives do not support links. Exclusive copy still refuses existing files.
      if (['ENOTSUP', 'EPERM', 'EXDEV', 'EINVAL'].includes(error.code)) {
        try { await copyFile(temporary, output, constants.COPYFILE_EXCL); return output; }
        catch (copyError) { if (copyError.code === 'EEXIST') continue; throw copyError; }
      }
      throw error;
    }
  }
  throw new Error('同名文件过多，请选择另一个输出文件夹。');
}

export async function compressFile(input, { outputDir, preset = 'clear', tools, signal, emit = () => {} }) {
  const setting = presets[preset];
  if (!setting) throw new Error('未知压缩档位。');
  input = resolve(input); outputDir = resolve(outputDir);
  const before = await stat(input), info = await probeAudio(input, tools, signal);
  const estimatedBytes = Math.ceil(info.duration * setting.bitrate / 8 * 1.02 + 16384);
  const base = { input, name: basename(input), originalBytes: before.size, duration: info.duration, preset };
  emit({ type: 'probed', ...base, estimatedBytes, originalBitrate: info.bitrate || before.size * 8 / info.duration });
  if (estimatedBytes >= before.size * 0.95 || info.bitrate && info.bitrate <= setting.bitrate) {
    return { ...base, status: 'skipped', reason: '原文件码率已较低，继续压缩预计省不了多少空间。', outputBytes: before.size };
  }
  await mkdir(outputDir, { recursive: true });
  const temporary = join(outputDir, `.classnote-${randomUUID()}.partial.m4a`);
  const started = performance.now();
  try {
    await execute(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-n', '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', String(setting.bitrate),
      '-ac', '1', '-ar', '32000', '-threads', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-stats_period', '0.5', '-f', 'mp4', temporary],
    { signal, onLine: line => {
      if (line.startsWith('out_time_us=')) {
        const seconds = Number(line.slice(12)) / 1e6;
        if (Number.isFinite(seconds)) emit({ type: 'progress', input, progress: Math.min(98, Math.max(0, Math.round(seconds / info.duration * 98))) });
      }
    } });
    emit({ type: 'verifying', input });
    const outputInfo = await probeAudio(temporary, tools, signal);
    if (Math.abs(outputInfo.duration - info.duration) > Math.max(0.5, info.duration * 0.0001)) throw new Error('压缩前后时长不一致，结果未保留。');
    // Full decode catches truncated/corrupt output, including problems near the end of a long recording.
    await execute(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-i', temporary, '-map', '0:a:0', '-f', 'null', '-'], { signal });
    const after = await stat(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('压缩期间原文件发生变化，请重新处理。');
    const outputBytes = (await stat(temporary)).size;
    if (outputBytes >= before.size) return { ...base, status: 'skipped', reason: '实际压缩结果更大，已丢弃结果并保留原文件。', outputBytes: before.size };
    const sha256 = await digest(temporary);
    signal?.throwIfAborted();
    const output = await publish(temporary, outputDir, basename(input, extname(input)), setting.suffix);
    return { ...base, status: 'completed', output, outputBytes, outputDuration: outputInfo.duration, sha256, savedPercent: Math.round((1 - outputBytes / before.size) * 100), elapsedSeconds: Math.round((performance.now() - started) / 100) / 10 };
  } finally { await rm(temporary, { force: true }); }
}

export async function runBatch(manifest, { emit = () => {}, signal } = {}) {
  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.some(value => typeof value !== 'string')) throw new Error('请先添加录音文件或文件夹。');
  if (typeof manifest.outputDir !== 'string' || !manifest.outputDir.trim()) throw new Error('请选择输出文件夹。');
  const preset = manifest.preset || 'clear';
  if (!presets[preset]) throw new Error('未知压缩档位。');
  const outputDir = resolve(manifest.outputDir);
  const tools = await findTools();
  const inputs = await collectInputs(manifest.inputs, outputDir);
  if (!inputs.length) throw new Error('没有找到可处理的音频文件。');
  await mkdir(outputDir, { recursive: true });
  const report = join(outputDir, `压缩记录-${Date.now()}-${randomUUID().slice(0, 6)}.json`);
  const results = [];
  emit({ type: 'batch', count: inputs.length, outputDir });
  for (const [index, input] of inputs.entries()) {
    if (signal?.aborted) break;
    emit({ type: 'start', input, name: basename(input), index, count: inputs.length });
    let result;
    try { result = await compressFile(input, { outputDir, preset, tools, signal, emit }); }
    catch (error) { result = { input, name: basename(input), status: signal?.aborted ? 'cancelled' : 'failed', error: error.message }; }
    results.push(result);
    // A durable per-batch record includes paths, sizes, duration, and hashes. It stays on this computer.
    await writeFile(report, JSON.stringify({ version: 1, preset, results }, null, 2), { encoding: 'utf8', flag: 'w' });
    emit({ type: 'result', ...result, index, count: inputs.length });
  }
  const completed = results.filter(result => result.status === 'completed');
  const summary = { type: 'done', count: inputs.length, completed: completed.length, skipped: results.filter(result => result.status === 'skipped').length, failed: results.filter(result => result.status === 'failed').length, cancelled: !!signal?.aborted, savedBytes: completed.reduce((sum, result) => sum + result.originalBytes - result.outputBytes, 0), report, outputDir };
  emit(summary);
  return { ...summary, results };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const abort = new AbortController();
  process.stdin.setEncoding('utf8');
  const commands = createInterface({ input: process.stdin });
  commands.on('line', command => { if (command.trim() === 'cancel') abort.abort(); });
  process.once('SIGINT', () => abort.abort());
  try {
    if (process.argv[2] === '--check') {
      const tools = await findTools();
      emit({ type: 'ready', tools });
    } else if (process.argv[2] === '--manifest' && process.argv[3]) {
      const manifest = JSON.parse((await readFile(resolve(process.argv[3]), 'utf8')).replace(/^\uFEFF/, ''));
      const summary = await runBatch(manifest, { emit, signal: abort.signal });
      if (summary.failed) process.exitCode = 1;
    } else throw new Error('用法：node scripts/audio-compressor.mjs --manifest <任务文件.json>');
  } catch (error) { emit({ type: 'error', message: error.message }); process.exitCode = 1; }
  finally { commands.close(); process.stdin.destroy(); }
}

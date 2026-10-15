import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const url = 'http://127.0.0.1:3210';
async function health() { try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1200) }); return response.ok ? await response.json() : null; } catch { return null; } }
function openBrowser() { const child = spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' }); child.unref(); }
try {
  if ((await health())?.app === 'ClassNote') { openBrowser(); }
  else {
    const next = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (!existsSync(next) || !existsSync(join(root, '.next', 'BUILD_ID'))) throw new Error('Run npm ci and npm run build in the project folder first.');
    const data = join(root, '.classnote'); mkdirSync(data, { recursive: true });
    const instance = randomUUID(); const out = openSync(join(data, 'server.stdout.log'), 'a'); const err = openSync(join(data, 'server.stderr.log'), 'a');
    const server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', '3210'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CLASSNOTE_INSTANCE_ID: instance } });
    await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); }); server.unref(); closeSync(out); closeSync(err);
    writeFileSync(join(data, 'server.json'), JSON.stringify({ pid: server.pid, instance, executable: process.execPath, next }, null, 2));
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const info = await health(); if (info?.app === 'ClassNote' && info.instance === instance) { ready = true; break; }
      if (server.exitCode !== null) throw new Error('ClassNote could not start. See .classnote/server.stderr.log. Port 3210 may be in use.');
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!ready) throw new Error('ClassNote is not ready. See .classnote/server.stderr.log.');
    console.log('ClassNote is ready: ' + url); openBrowser();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const path = fileURLToPath(new URL('../.classnote/server.json', import.meta.url));
try {
  if (existsSync(path)) {
    const info = JSON.parse(readFileSync(path, 'utf8'));
    const response = await fetch('http://127.0.0.1:3210/api/health', { signal: AbortSignal.timeout(2000) });
    const health = await response.json();
    if (health.app !== 'ClassNote' || health.instance !== info.instance || !Number.isInteger(info.pid)) throw new Error('The process identity does not match. No process was stopped.');
    process.kill(info.pid, 'SIGTERM'); unlinkSync(path); console.log('ClassNote stopped.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

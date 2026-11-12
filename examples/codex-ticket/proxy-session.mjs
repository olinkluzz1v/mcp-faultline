// Codex owns this stdio child. Convert its close/signal into awaited proxy EOF,
// and retain the production proxy's actual exit status outside the agent workspace.
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const startedAt = Date.now();
const log = openSync(join(config.output, 'proxy.stderr.log'), 'wx', 0o600);
const child = spawn(process.execPath, config.proxyArgs, { cwd: config.workspace,
  // Codex closes its MCP process group. Keep the real proxy outside that group
  // so this supervisor can convert the signal into EOF and await finalization.
  detached: true, stdio: ['pipe', 'pipe', log] });
writeFileSync(join(config.output, 'proxy-process.json'), JSON.stringify({
  runId: config.runId, supervisorPid: process.pid, proxyPid: child.pid, startedAt,
}), { flag: 'wx', mode: 0o600 });
let stopped = false, timer, killTimer, failure;
function stop() {
  if (stopped) return;
  stopped = true;
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  timer = setTimeout(() => child.kill('SIGTERM'), 1500);
  killTimer = setTimeout(() => child.kill('SIGKILL'), 3500);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
process.stdin.on('end', stop);
process.stdin.on('error', error => { failure = error.message; stop(); });
process.stdout.on('error', error => { failure = error.message; stop(); });
child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error.message; stop(); });
child.on('error', error => { failure = error.message; stop(); });
process.stdin.pipe(child.stdin, { end: false });
child.stdout.pipe(process.stdout, { end: false });
const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
clearTimeout(timer); clearTimeout(killTimer);
process.stdin.destroy();
closeSync(log);
writeFileSync(join(config.output, 'proxy-exit.json'), JSON.stringify({ runId: config.runId,
  startedAt, endedAt: Date.now(), ...exit, error: failure ?? null }, null, 2), { flag: 'wx', mode: 0o600 });
process.exitCode = failure || exit.signal || exit.code !== 0 ? 2 : 0;

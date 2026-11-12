import { mkdir, mkdtemp, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { finished } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Command } from 'commander';
import YAML from 'yaml';
import { exampleDirectory, repositoryDirectory, expectedTicket, codexArguments,
  proxyArguments, clientEnvironment } from './config.mjs';
import { readEvidence, evaluateEvidence } from './evaluate.mjs';

const execute = promisify(execFile);
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const hash = value => createHash('sha256').update(value).digest('hex');
function boundedInteger(value, name, min, max) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return Number(value);
}

export async function runExample(options) {
  if (process.platform === 'win32') throw new Error('This example currently requires a POSIX host for process-group cleanup.');
  if (!options.model?.trim()) throw new Error('--model must be explicit and nonempty.');
  if (!options.out?.trim()) throw new Error('--out must name a fresh directory.');
  const scenario = options.scenario ?? 'lost-ack';
  if (!['baseline', 'lost-ack'].includes(scenario)) throw new Error('--scenario must be baseline or lost-ack.');
  const timeoutMs = boundedInteger(options.timeoutMs ?? 120000, '--timeout-ms', 100, 600000);
  const maxToolCalls = boundedInteger(options.maxToolCalls ?? 8, '--max-tool-calls', 1, 32);
  const output = resolve(options.out);
  await mkdir(dirname(output), { recursive: true });
  // mkdir is exclusive for files, directories and symlinks, including dangling links.
  await mkdir(output, { mode: 0o700 });
  const manifest = { kind: 'codex-ticket-run', schemaVersion: 1, runId: randomUUID(),
    startedAt: Date.now(), scenario, expectedTicket, modelRequested: options.model,
    modelReported: null, modelReportedNote: 'The exec JSONL protocol does not normally report the model identifier.',
    maxToolCalls, timeoutMs, output, versions: { node: process.version, codex: null, mcpSdk: null, repoCommit: null },
    codexExecutable: options.codex ?? 'codex' };
  const session = { code: null, signal: null, interruption: null, error: null };
  let workspace, child, timeout, killTimer, evidence, interrupting, proxyCleanup;
  const env = clientEnvironment();
  const startup = new AbortController();
  const signalPid = (pid, signal) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') session.error ??= error.message; }
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  async function waitGone(pid, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (alive(pid) && Date.now() < deadline) await delay(20);
    return !alive(pid);
  }
  async function stopProxy() {
    proxyCleanup ??= (async () => {
      let record;
      try { record = JSON.parse(await readFile(join(output, 'proxy-process.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') session.error ??= `Cleanup failed: ${error.message}`; return; }
      if (record.runId !== manifest.runId) { session.error ??= 'Cleanup record belongs to another run.'; return; }
      signalPid(record.supervisorPid, 'SIGTERM');
      if (await waitGone(record.supervisorPid, 4500)) return;
      // Keep parents alive to reap their children. Escalation is a harness failure.
      session.error ??= 'Proxy cleanup required forced termination.';
      try {
        const fixture = JSON.parse(await readFile(join(output, 'state/fixture.json'), 'utf8'));
        if (fixture.runId === manifest.runId) { signalPid(fixture.pid, 'SIGKILL'); await waitGone(fixture.pid, 500); }
      } catch (error) { if (error.code !== 'ENOENT') session.error ??= error.message; }
      signalPid(record.proxyPid, 'SIGKILL'); await waitGone(record.proxyPid, 500);
      signalPid(record.supervisorPid, 'SIGKILL'); await waitGone(record.supervisorPid, 500);
    })();
    return proxyCleanup;
  }
  function stop(reason) {
    session.interruption ??= reason;
    startup.abort();
    interrupting ??= (async () => {
      await stopProxy();
      signalPid(child?.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => {
        if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') session.error ??= error.message;
        }
      }, 1500);
    })();
  }
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    workspace = await mkdtemp(join(tmpdir(), 'faultline-codex-workspace-'));
    manifest.workspace = workspace;
    const stateDirectory = join(output, 'state');
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(join(output, 'runtime'), { mode: 0o700 });
    const prompt = await readFile(options.prompt ? resolve(options.prompt) : join(exampleDirectory, 'prompt.txt'), 'utf8');
    if (!prompt.trim() || Buffer.byteLength(prompt) > 16384) throw new Error('Prompt must be nonempty and at most 16 KiB.');
    await writeFile(join(output, 'prompt.txt'), prompt, { flag: 'wx', mode: 0o600 });
    manifest.promptSha256 = hash(prompt);
    const { loadTask } = await import('../../dist/task/loader.js');
    const task = await loadTask(join(exampleDirectory, 'scenario.yaml'));
    if (scenario === 'baseline') task.fault_injection = [];
    manifest.faultPlan = task.fault_injection;
    const scenarioPath = join(output, 'scenario.yaml');
    const scenarioText = YAML.stringify(task);
    await writeFile(scenarioPath, scenarioText, { flag: 'wx', mode: 0o600 });
    manifest.scenarioSha256 = hash(scenarioText);
    const fixtureConfig = join(output, 'fixture-config.json');
    await writeJSON(fixtureConfig, { runId: manifest.runId, stateDirectory, maxToolCalls });
    const proxy = proxyArguments({ output, fixtureConfig, stateDirectory, scenarioPath });
    manifest.upstream = proxy.upstream;
    const sessionConfig = join(output, 'session-config.json');
    await writeJSON(sessionConfig, { runId: manifest.runId, output, workspace, proxyArgs: proxy.args });
    const args = codexArguments({ model: options.model, workspace, output, sessionConfig });
    await writeJSON(join(output, 'codex-configuration.json'), { command: manifest.codexExecutable, args,
      isolation: 'Scoped MCP allowlist; shell/integrations disabled; workspace-only reads and no writes; reject non-MCP activity.' });
    const sdkPackage = JSON.parse(await readFile(join(repositoryDirectory, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));
    manifest.versions.mcpSdk = sdkPackage.version;
    manifest.versions.repoCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory })).stdout.trim();
    manifest.repoDirty = Boolean((await execute('git', ['status', '--porcelain'], { cwd: repositoryDirectory })).stdout.trim());
    const preflight = { cwd: workspace, env, timeout: 10000, maxBuffer: 256 * 1024, signal: startup.signal };
    manifest.versions.codex = (await execute(manifest.codexExecutable, ['--version'], preflight)).stdout.trim();
    const version = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(manifest.versions.codex);
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 167)) {
      throw new Error('This example requires Codex CLI 0.167 or newer with scoped configuration and filesystem permissions.');
    }
    // Status is evidence of local login configuration only; the model request can still fail.
    // Never save login stdout: API-key status can contain credential fragments.
    await execute(manifest.codexExecutable, ['login', 'status'], preflight).catch(() => {
      throw new Error('Codex CLI has no usable local login configuration. Run codex login separately.');
    });
    if (session.interruption) throw new Error(session.interruption);
    const eventFile = createWriteStream(join(output, 'agent-events.jsonl'), { flags: 'wx', mode: 0o600 });
    const errorFile = createWriteStream(join(output, 'agent.stderr.log'), { flags: 'wx', mode: 0o600 });
    const outputErrors = [eventFile, errorFile].map(stream => finished(stream).catch(error => {
      session.error ??= `Cannot retain agent output: ${error.message}`; stop('output_failure');
    }));
    child = spawn(manifest.codexExecutable, args, { cwd: workspace, env,
      detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const [stream, destination] of [[child.stdout, eventFile], [child.stderr, errorFile]]) {
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { stream.unpipe(destination); stop('output_limit'); destination.end(); }
      });
      stream.pipe(destination);
    }
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') session.error ??= error.message; });
    const exited = new Promise(resolveExit => {
      child.once('error', error => { session.error ??= `Cannot start Codex: ${error.message}`; });
      child.once('close', (code, signal) => { session.code = code; session.signal = signal; resolveExit(); });
    });
    timeout = setTimeout(() => stop('runtime_limit'), timeoutMs);
    child.stdin.end(prompt);
    await exited;
    await Promise.all(outputErrors);
    clearTimeout(timeout);
    // Some clients close their MCP child asynchronously; wait for finalization,
    // never treat a missing capture as a successful empty evaluation.
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      try { await access(join(output, 'proxy-exit.json')); break; } catch { /* still closing */ }
      if (!await readFile(join(output, 'proxy-process.json')).then(() => true, () => false)) break;
      await delay(25);
    }
    if ((await readdir(workspace)).length) session.error ??= 'The fresh agent workspace was unexpectedly modified.';
    evidence = await readEvidence(output);
  } catch (error) {
    session.error ??= error.message;
  } finally {
    clearTimeout(timeout);
    await interrupting;
    await stopProxy();
    clearTimeout(killTimer);
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(error => { session.error ??= error.message; });
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
  manifest.endedAt = Date.now();
  const evaluation = evaluateEvidence(manifest, evidence, session);
  const exitCode = !evaluation.valid ? 2 : evaluation.verdict === 'PASS' ? 0 : 1;
  const summary = { kind: 'codex-ticket-evaluation', schemaVersion: 1, runId: manifest.runId,
    scenario, versions: manifest.versions, modelRequested: manifest.modelRequested, modelReported: manifest.modelReported,
    session: { ...session, status: session.interruption ? 'interrupted' : session.error || session.code !== 0 ? 'failed' : 'completed' },
    evaluation, exitCode, artifacts: { capture: 'proxy-capture.json', agentEvents: 'agent-events.jsonl',
      finalAnswer: 'final-answer.txt', state: 'state/state.json', creations: 'state/creations.jsonl',
      manifest: 'run.json', configuration: 'codex-configuration.json', prompt: 'prompt.txt', scenario: 'scenario.yaml' } };
  await writeJSON(join(output, 'run.json'), manifest);
  await writeJSON(join(output, 'summary.json'), summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = new Command().name('codex-ticket').description('Evaluate a real Codex CLI ticket task through Faultline.')
    .requiredOption('--model <id>', 'Explicit model identifier')
    .requiredOption('--out <directory>', 'Fresh evidence directory (never overwritten)')
    .option('--scenario <name>', 'lost-ack or baseline', 'lost-ack')
    .option('--prompt <file>', 'Use a different prompt for a fresh execution')
    .option('--codex <executable>', 'Codex CLI executable', 'codex')
    .option('--timeout-ms <integer>', 'Maximum agent runtime, 100–600000 ms', '120000')
    .option('--max-tool-calls <integer>', 'Maximum fixture calls, 1–32', '8')
    .allowExcessArguments(false).exitOverride();
  try {
    command.parse();
    const summary = await runExample(command.opts());
    console.log(`Ticket evaluation: ${summary.evaluation.verdict ?? 'INVALID'} (session ${summary.session.status})`);
    for (const reason of summary.evaluation.reasons) console.log(`- ${reason}`);
    console.log(`Evidence: ${resolve(command.opts().out)}`);
    process.exitCode = summary.exitCode;
  } catch (error) {
    if (error.code === 'commander.helpDisplayed') process.exitCode = 0;
    else { console.error(`codex-ticket: ${error.message}`); process.exitCode = 2; }
  }
}

// Offline scripted controls through the real production proxy and ticket fixture.
// No Codex installation, authentication or live model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'examples/codex-ticket/batch.mjs');
const scripted = pathToFileURL(join(root, 'tests/fixtures/scripted-codex.mjs')).href;
const options = { timeout: 45000 };
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function setup(t, controls = ['verify'], hook = '') {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-ticket-batch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'scripted-codex.mjs');
  const counter = join(directory, 'invocations.json');
  const output = join(directory, 'batch');
  await writeFile(counter, '0');
  await writeFile(executable, `#!${process.execPath}
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { run } from ${JSON.stringify(scripted)};
const counter = ${JSON.stringify(counter)};
const output = ${JSON.stringify(output)};
const n = JSON.parse(await readFile(counter, 'utf8'));
const controls = ${JSON.stringify(controls)};
if (process.argv[2] === 'exec') {
  await writeFile(counter, JSON.stringify(n + 1));
  ${hook}
}
await run(controls[n] ?? controls.at(-1));
`, { mode: 0o700 });
  return { directory, executable, counter, output };
}

function invoke(t, fixture, extra = [], env = process.env) {
  const child = spawn(process.execPath, [entry, '--model', 'scripted-model', '--out', fixture.output,
    '--codex', fixture.executable, '--timeout-ms', '8000', ...extra],
  { cwd: fixture.directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, exited };
}

test('default batch: one baseline and three fresh scripted fault runs, with retained evidence and offline HTML', options, async t => {
  const fixture = await setup(t);
  const result = await invoke(t, fixture).exited;
  assert.equal(result.code, 0, result.stderr);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.equal(batch.kind, 'codex-ticket-batch');
  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.planned, 4);
  assert.equal(batch.completed, 4);
  assert.equal(batch.unstarted, 0);
  assert.equal(batch.outcome, 'PASS');
  assert.deepEqual(batch.runs.map(r => r.status), ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.deepEqual(batch.runs.map(r => r.ticketCount), [1, 1, 1, 1]);
  assert.deepEqual(batch.runs.map(r => r.appliedFaultCount), [0, 1, 1, 1]);
  for (const key of ['runId', 'workspace', 'threadId', 'captureRunId']) {
    assert.equal(new Set(batch.runs.map(r => r.provenance[key])).size, 4, key);
  }
  const ticketIds = [];
  for (const run of batch.runs) {
    const output = join(fixture.output, run.directory);
    assert.equal(run.provenance.modelReported, null);
    assert.equal(run.provenance.promptSha256, batch.configuration.promptSha256);
    assert.match(run.provenance.versions.codex, /scripted test double/);
    assert.equal((await json(join(output, 'summary.json'))).evaluation.verdict, 'PASS');
    ticketIds.push((await json(join(output, 'state/state.json'))).tickets[0].id);
    await assert.rejects(readdir(run.provenance.workspace), { code: 'ENOENT' });
    for (const path of Object.values(run.artifacts)) await readFile(join(fixture.output, path));
  }
  assert.equal(new Set(ticketIds).size, 4);
  assert.equal(await json(fixture.counter), 4);
  const html = await readFile(join(fixture.output, 'report.html'), 'utf8');
  assert.match(html, /Baseline/);
  assert.match(html, /Fault runs/);
  assert.match(html, /not a general reliability rate/);
  assert.doesNotMatch(html, /<script\b|<link\b|<img\b/i);
  const before = await readFile(join(fixture.output, 'batch.json'), 'utf8');
  assert.equal((await invoke(t, fixture).exited).code, 2);
  assert.equal(await readFile(join(fixture.output, 'batch.json'), 'utf8'), before);
  assert.equal(await readFile(join(fixture.output, 'report.html'), 'utf8'), html);
  assert.equal(await json(fixture.counter), 4);
});

test('a failed baseline and duplicate fault run remain FAIL while later runs still execute', options, async t => {
  const fixture = await setup(t, ['wrong-ticket', 'duplicate', 'verify']);
  const result = await invoke(t, fixture, ['--fault-runs', '2']).exited;
  assert.equal(result.code, 1, result.stderr);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.deepEqual(batch.runs.map(r => r.status), ['FAIL', 'FAIL', 'PASS']);
  assert.deepEqual(batch.runs.map(r => r.ticketCount), [1, 2, 1]);
  assert.deepEqual(batch.runs.map(r => r.appliedFaultCount), [0, 1, 1]);
  assert.equal(batch.completed, 3);
  assert.equal(batch.unstarted, 0);
  assert.equal(await json(fixture.counter), 3);
  assert.match(batch.runs[0].reasons.join(' '), /reference\/title/);
  assert.match(batch.runs[1].reasons.join(' '), /observed 2/);
  assert.match(await readFile(join(fixture.output, 'report.html'), 'utf8'), /Baseline is FAIL/);
});

test('INVALID stops scheduling, retains earlier FAIL and marks remaining evaluations NOT RUN', options, async t => {
  const fixture = await setup(t, ['wrong-ticket', 'no-tools', 'verify']);
  const result = await invoke(t, fixture).exited;
  assert.equal(result.code, 2, result.stderr);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.equal(batch.exitCode, 2);
  assert.deepEqual(batch.runs.map(r => r.status), ['FAIL', 'INVALID', 'NOT RUN', 'NOT RUN']);
  assert.equal(batch.completed, 1);
  assert.equal(batch.invalid, 1);
  assert.equal(batch.unstarted, 2);
  assert.equal(await json(fixture.counter), 2);
  assert.equal(batch.runs[1].ticketCount, null);
  assert.equal(batch.runs[1].appliedFaultCount, null);
  assert.match(batch.runs[1].reasons.join(' '), /No tool calls/);
  assert.equal((await json(join(fixture.output, batch.runs[0].directory, 'summary.json'))).evaluation.verdict, 'FAIL');
  await assert.rejects(readdir(join(fixture.output, batch.runs[2].directory)), { code: 'ENOENT' });
});

test('the prompt is frozen before execution; source changes do not change later inputs', options, async t => {
  const fixture = await setup(t, ['verify'], `
    if (n === 0) await writeFile(${JSON.stringify('SOURCE_PROMPT')}, 'Changed after batch setup');
  `);
  const prompt = join(fixture.directory, 'source-prompt.txt');
  await writeFile(prompt, 'Original frozen batch prompt');
  await writeFile(fixture.executable, (await readFile(fixture.executable, 'utf8')).replace('SOURCE_PROMPT', prompt));
  const result = await invoke(t, fixture, ['--fault-runs', '1', '--prompt', prompt, '--max-tool-calls', '4']).exited;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(prompt, 'utf8'), 'Changed after batch setup');
  const batch = await json(join(fixture.output, 'batch.json'));
  for (const run of batch.runs) {
    assert.equal(await readFile(join(fixture.output, run.directory, 'prompt.txt'), 'utf8'), 'Original frozen batch prompt');
    assert.equal(run.provenance.maxToolCalls, 4);
    assert.equal(run.provenance.timeoutMs, 8000);
  }
});

test('actual runtime version drift invalidates the batch without rewriting the single-run grade', options, async t => {
  const fixture = await setup(t);
  await writeFile(fixture.executable, (await readFile(fixture.executable, 'utf8')).replace(
    "if (process.argv[2] === 'exec')", `if (n > 0 && process.argv[2] === '--version') {
      console.log('codex-cli 0.168.0 (changed scripted test double)'); process.exit(0);
    }
    if (process.argv[2] === 'exec')`));
  assert.equal((await invoke(t, fixture).exited).code, 2);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.deepEqual(batch.runs.map(r => r.status), ['PASS', 'INVALID', 'NOT RUN', 'NOT RUN']);
  assert.match(batch.runs[1].reasons.join(' '), /versions.*drifted/);
  assert.match(batch.runs[1].provenance.versions.codex, /0.168.0/);
  assert.equal((await json(join(fixture.output, batch.runs[1].directory, 'summary.json'))).evaluation.verdict, 'PASS');
  assert.equal(await json(fixture.counter), 2);
});

test('missing, forged and inconsistent structured results cannot become a passing batch', options, async t => {
  const fixture = await setup(t);
  assert.equal((await invoke(t, fixture, ['--fault-runs', '1']).exited).code, 0);
  const { inspectBatchResult } = await import('../examples/codex-ticket/batch-result.mjs');
  const batch = await json(join(fixture.output, 'batch.json'));
  const entry = batch.runs[1], directory = join(fixture.output, entry.directory);
  const summary = await json(join(directory, 'summary.json'));
  const manifest = await json(join(directory, 'run.json'));
  const context = { output: fixture.output, entry, configuration: batch.configuration,
    scenarios: batch.scenarios, previous: [batch.runs[0]] };
  await assert.rejects(inspectBatchResult(undefined, context));
  await assert.rejects(inspectBatchResult({ exitCode: 0 }, context));
  await assert.rejects(inspectBatchResult({ ...summary, runId: batch.runs[0].provenance.runId }, context), /summaries disagree/);
  await assert.rejects(inspectBatchResult(summary, { ...context, entry: { ...entry, scenario: 'baseline' } }), /identity, scenario/);
  await assert.rejects(inspectBatchResult(summary, { ...context, configuration: { ...batch.configuration, modelRequested: 'other' } }), /configuration drifted/);
  await assert.rejects(inspectBatchResult(summary, { ...context, previous: [entry] }), /reused/);
  const forged = structuredClone(summary);
  forged.evaluation.ticketCount = 200;
  await writeFile(join(directory, 'summary.json'), JSON.stringify(forged));
  await assert.rejects(inspectBatchResult(forged, context), /retained evidence/);
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary));
  await writeFile(join(directory, 'run.json'), JSON.stringify({ ...manifest, promptSha256: 'wrong' }));
  await assert.rejects(inspectBatchResult(summary, context), /Prompt drifted/);
  await writeFile(join(directory, 'run.json'), JSON.stringify(manifest));
  await rm(join(directory, 'proxy-capture.json'));
  await assert.rejects(inspectBatchResult(summary, context), { code: 'ENOENT' });
});

test('arguments, help and output collisions do not launch a client or overwrite reports', options, async t => {
  const fixture = await setup(t);
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '21', '']) {
    assert.equal((await invoke(t, fixture, ['--fault-runs', value]).exited).code, 2, value);
  }
  for (const extra of [['--model', ''], ['--timeout-ms', '0'], ['--max-tool-calls', '33'], ['--unknown'], ['--fault-runs']]) {
    assert.equal((await invoke(t, fixture, extra).exited).code, 2, extra.join(' '));
  }
  const before = await readdir(fixture.directory);
  assert.equal((await invoke(t, fixture, ['--help']).exited).code, 0);
  assert.deepEqual(await readdir(fixture.directory), before);
  await assert.rejects(readdir(fixture.output), { code: 'ENOENT' });
  await writeFile(fixture.output, 'existing report');
  assert.equal((await invoke(t, fixture).exited).code, 2);
  assert.equal(await readFile(fixture.output, 'utf8'), 'existing report');
  await symlink(fixture.output, join(fixture.directory, 'link'));
  assert.equal((await invoke(t, fixture, ['--out', join(fixture.directory, 'link')]).exited).code, 2);
  assert.equal(await json(fixture.counter), 0);
});

async function preload(fixture, body) {
  const path = join(fixture.directory, 'io-hook.mjs');
  await writeFile(path, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (from, to) => {
  ${body}
  return rename(from, to);
};
syncBuiltinESMExports();`);
  return { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
}

test('aggregate HTML output failure takes precedence over FAIL and preserves run evidence', options, async t => {
  const fixture = await setup(t, ['wrong-ticket', 'verify']);
  const env = await preload(fixture, `if (to.endsWith('/report.html')) {
    const html = await fs.readFile(from, 'utf8');
    if (html.includes('1 completed evaluations')) throw Object.assign(new Error('scripted aggregate output failure'), { code: 'EACCES' });
  }`);
  const exit = await invoke(t, fixture, ['--fault-runs', '1'], env).exited;
  assert.equal(exit.code, 2, exit.stderr);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.equal(batch.outcome, 'INVALID');
  assert.deepEqual(batch.runs.map(r => r.status), ['FAIL', 'NOT RUN']);
  assert.match(batch.reasons.join(' '), /aggregate output failure/);
  assert.equal((await json(join(fixture.output, batch.runs[0].directory, 'summary.json'))).evaluation.verdict, 'FAIL');
  assert.equal(await json(fixture.counter), 1);
});

test('aggregate JSON output failure stops the plan and retains the individual evaluation', options, async t => {
  const fixture = await setup(t);
  const env = await preload(fixture, `if (to.endsWith('/batch.json')) {
    const batch = JSON.parse(await fs.readFile(from, 'utf8'));
    if (batch.completed > 0) throw new Error('scripted JSON output failure');
  }`);
  const result = await invoke(t, fixture, ['--fault-runs', '1'], env).exited;
  assert.equal(result.code, 2);
  assert.match(result.stderr, /JSON output failure/);
  const prior = await json(join(fixture.output, 'batch.json'));
  assert.equal(prior.outcome, 'RUNNING', 'last writable snapshot cannot claim final success');
  assert.equal((await json(join(fixture.output, 'runs/00-baseline/summary.json'))).evaluation.verdict, 'PASS');
  assert.equal(await json(fixture.counter), 1);
});

for (const failingReport of ['HTML', 'JSON']) {
  test(`persistent output failure at final ${failingReport} publication cannot leave an authoritative PASS`, options, async t => {
    const fixture = await setup(t);
    const path = join(fixture.directory, 'disk-full.mjs');
    await writeFile(path, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFile;
let full = false;
fs.writeFile = async (path, data, ...args) => {
  if (${failingReport === 'HTML' ? `String(path).includes('.report.html-') && String(data).includes('class="pass">PASS</strong>')`
    : `String(path).includes('.batch.json-') && JSON.parse(data).outcome === 'PASS'`}) full = true;
  if (full) throw Object.assign(new Error('scripted persistent disk full'), { code: 'ENOSPC' });
  return write(path, data, ...args);
};
syncBuiltinESMExports();`);
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
    const result = await invoke(t, fixture, ['--fault-runs', '1'], env).exited;
    assert.equal(result.code, 2);
    assert.match(result.stderr, /persistent disk full/);
    const retained = await json(join(fixture.output, 'batch.json'));
    assert.equal(retained.outcome, 'RUNNING');
    assert.equal(retained.exitCode, null);
    assert.equal(retained.completed, 2);
    const html = await readFile(join(fixture.output, 'report.html'), 'utf8');
    assert.match(html, /Final completion and the actual exit code/);
    assert.doesNotMatch(html, /Exit code: <strong>0/);
    assert.equal((await json(join(fixture.output, 'runs/01-lost-ack/summary.json'))).evaluation.verdict, 'PASS');
  });
}

test('a returned PASS with a missing retained summary is INVALID and stops scheduling', options, async t => {
  const fixture = await setup(t);
  const path = join(fixture.directory, 'missing-summary.mjs');
  await writeFile(path, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFile;
fs.writeFile = async (path, ...args) => {
  if (String(path).endsWith('/summary.json')) return;
  return write(path, ...args);
};
syncBuiltinESMExports();`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
  assert.equal((await invoke(t, fixture, ['--fault-runs', '1'], env).exited).code, 2);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.deepEqual(batch.runs.map(r => r.status), ['INVALID', 'NOT RUN']);
  assert.match(batch.runs[0].reasons.join(' '), /summary.json/);
  assert.equal((await json(join(fixture.output, 'runs/00-baseline/state/state.json'))).tickets.length, 1);
  assert.equal(await json(fixture.counter), 1);
});

test('interruption during run setup is handed to existing cleanup before any client starts', options, async t => {
  const fixture = await setup(t);
  const path = join(fixture.directory, 'setup-interruption.mjs');
  await writeFile(path, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const mkdir = fs.mkdir;
fs.mkdir = async (path, ...args) => {
  if (String(path).endsWith('/runs/00-baseline')) {
    process.kill(process.pid, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return mkdir(path, ...args);
};
syncBuiltinESMExports();`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
  assert.equal((await invoke(t, fixture, ['--fault-runs', '1'], env).exited).code, 2);
  const batch = await json(join(fixture.output, 'batch.json'));
  assert.deepEqual(batch.runs.map(r => r.status), ['INVALID', 'NOT RUN']);
  const summary = await json(join(fixture.output, 'runs/00-baseline/summary.json'));
  assert.equal(summary.session.interruption, 'SIGTERM');
  assert.equal(await json(fixture.counter), 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during a run uses bounded cleanup and retains partial evidence`, options, async t => {
    const fixture = await setup(t, ['hang']);
    const run = invoke(t, fixture);
    const directory = join(fixture.output, 'runs/00-baseline');
    let proxy, state;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      try { proxy = await json(join(directory, 'proxy-process.json')); state = await json(join(directory, 'state/fixture.json')); break; }
      catch { await delay(20); }
    }
    assert.ok(state, 'fixture started before signal');
    run.child.kill(signal);
    assert.equal((await run.exited).code, 2);
    const batch = await json(join(fixture.output, 'batch.json'));
    assert.deepEqual(batch.runs.map(r => r.status), ['INVALID', 'NOT RUN', 'NOT RUN', 'NOT RUN']);
    assert.match(batch.reasons.join(' '), new RegExp(signal));
    assert.equal((await json(join(directory, 'summary.json'))).session.interruption, signal);
    assert.ok(batch.runs[0].artifacts['proxy-capture.json']);
    const manifest = await json(join(directory, 'run.json'));
    await assert.rejects(readdir(manifest.workspace), { code: 'ENOENT' });
    for (const pid of [proxy.supervisorPid, proxy.proxyPid, state.pid]) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    assert.equal(await json(fixture.counter), 1);
  });
}

for (const phase of ['between runs', 'final reporting']) {
  test(`interruption ${phase} cannot launch another run or produce exit zero`, options, async t => {
    const fixture = await setup(t);
    const env = await preload(fixture, `if (to.endsWith('/batch.json')) {
      const batch = JSON.parse(await fs.readFile(from, 'utf8'));
      if (${phase === 'between runs' ? 'batch.completed === 1 && batch.endedAt === null' : "batch.outcome === 'PASS'"}) {
        process.kill(process.pid, 'SIGINT');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }`);
    assert.equal((await invoke(t, fixture, ['--fault-runs', '1'], env).exited).code, 2);
    const batch = await json(join(fixture.output, 'batch.json'));
    assert.equal(batch.outcome, 'INVALID');
    assert.equal(batch.exitCode, 2);
    assert.equal(batch.unstarted, phase === 'between runs' ? 1 : 0);
    assert.equal(await json(fixture.counter), phase === 'between runs' ? 1 : 2);
    assert.equal((await json(join(fixture.output, batch.runs[0].directory, 'summary.json'))).evaluation.verdict, 'PASS');
    await assert.rejects(readdir(batch.runs[0].provenance.workspace), { code: 'ENOENT' });
    assert.match(await readFile(join(fixture.output, 'report.html'), 'utf8'), /Interrupted: SIGINT/);
  });
}

test('batch HTML escapes text and refuses unsafe retained-artifact links', options, async t => {
  const fixture = await setup(t);
  assert.equal((await invoke(t, fixture, ['--fault-runs', '1']).exited).code, 0);
  const { batchHtml } = await import('../examples/codex-ticket/batch-report.mjs');
  const { retainedArtifacts } = await import('../examples/codex-ticket/batch-result.mjs');
  const batch = await json(join(fixture.output, 'batch.json'));
  const hostile = '<img src=x onerror="alert(1)">&\'';
  batch.configuration.modelRequested = hostile;
  batch.runs[0].reasons.push(hostile);
  batch.runs[0].artifacts = { unsafe: 'javascript:alert(1)', parent: 'runs/../../secret',
    absolute: '/tmp/secret', safe: 'runs/00-baseline/summary.json' };
  const html = batchHtml(batch);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;'));
  assert.ok(html.includes('href="runs/00-baseline/summary.json"'));
  assert.doesNotMatch(html, /javascript:|\.\.\/secret|href="\/tmp|<img\b/i);
  const capture = join(fixture.output, batch.runs[0].directory, 'proxy-capture.json');
  await rm(capture);
  await symlink(fixture.counter, capture);
  assert.equal((await retainedArtifacts(fixture.output, batch.runs[0].directory))['proxy-capture.json'], undefined);
});

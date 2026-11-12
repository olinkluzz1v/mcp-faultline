import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const example = fileURLToPath(new URL('../examples/codex-ticket/', import.meta.url));
const options = { timeout: 15_000 };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

async function fixture(t, maxToolCalls = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-ticket-test-'));
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory);
  const config = { runId: randomUUID(), stateDirectory, maxToolCalls };
  const configPath = join(directory, 'fixture-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const client = new Client({ name: 'scripted-ticket-control', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(example, 'fixture.mjs'), configPath], stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport, { timeout: 3000 });
  return { client, config, configPath, directory, stateDirectory, diagnostics,
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 3000 }) };
}

test('ticket fixture permits real duplicates and exposes only business tools', options, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name).sort(), ['create_ticket', 'find_tickets']);
  const args = { reference: 'CASE-42', title: 'Repair the export' };
  const first = await f.call('create_ticket', args);
  const second = await f.call('create_ticket', args);
  assert.equal(first.isError, undefined);
  assert.notEqual(first.structuredContent.ticket.id, second.structuredContent.ticket.id);
  const found = await f.call('find_tickets', { reference: args.reference });
  assert.equal(found.structuredContent.tickets.length, 2);
  const state = await json(join(f.stateDirectory, 'state.json'));
  const creations = await lines(join(f.stateDirectory, 'creations.jsonl'));
  assert.equal(state.runId, f.config.runId);
  assert.equal(state.tickets.length, 2);
  assert.deepEqual(state.tickets, creations.map(entry => entry.ticket));
  assert.deepEqual(state.tickets.map(({ reference, title }) => ({ reference, title })), [args, args]);
  assert.equal((await lines(join(f.stateDirectory, 'calls.jsonl'))).length, 3);
  assert.doesNotMatch(JSON.stringify(found), /stateDirectory|creations\.jsonl|runId|fault/);
});

test('ticket lookup matches reference and rejects instrumentation-shaped arguments', options, async t => {
  const f = await fixture(t);
  await f.call('create_ticket', { reference: 'A', title: 'First' });
  await f.call('create_ticket', { reference: 'B', title: 'Second' });
  assert.equal((await f.call('find_tickets', { reference: 'A' })).structuredContent.tickets.length, 1);
  assert.deepEqual((await f.call('find_tickets', { reference: 'missing' })).structuredContent.tickets, []);
  const invalid = await f.call('create_ticket', { reference: 'A', title: 'Wrong', path: '../state.json' });
  assert.equal(invalid.isError, true);
  assert.equal((await json(join(f.stateDirectory, 'state.json'))).tickets.length, 2);
});

test('fixture call budget stops additional effects and records the limit', options, async t => {
  const f = await fixture(t, 1);
  await f.call('create_ticket', { reference: 'A', title: 'One' });
  assert.equal((await f.call('create_ticket', { reference: 'A', title: 'One' })).isError, true);
  assert.equal((await json(join(f.stateDirectory, 'state.json'))).tickets.length, 1);
  const calls = await lines(join(f.stateDirectory, 'calls.jsonl'));
  assert.equal(calls[1].outcome, 'limit_exceeded');
  await delay(60);
  await assert.rejects(f.call('find_tickets', { reference: 'A' }), /closed|connected/i);
});

test('restarting a fixture cannot overwrite its earlier state', options, async t => {
  const f = await fixture(t);
  await f.call('create_ticket', { reference: 'A', title: 'Preserve me' });
  await f.client.close();
  const before = await readFile(join(f.stateDirectory, 'state.json'), 'utf8');
  const client = new Client({ name: 'scripted-restart', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(example, 'fixture.mjs'), f.configPath], stderr: 'pipe' });
  transport.stderr?.resume();
  t.after(() => client.close());
  await assert.rejects(client.connect(transport, { timeout: 3000 }));
  assert.equal(await readFile(join(f.stateDirectory, 'state.json'), 'utf8'), before);
});

async function exampleRun(t, control = 'verify', extra = []) {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-example-test-'));
  const executable = join(directory, 'scripted-codex');
  const source = fileURLToPath(new URL('./fixtures/scripted-codex.mjs', import.meta.url));
  await writeFile(executable, `#!/usr/bin/env node\nimport { run } from ${JSON.stringify(source)};\nawait run(${JSON.stringify(control)});\n`);
  await chmod(executable, 0o700);
  const output = join(directory, 'result');
  const child = spawn(process.execPath, [join(example, 'run.mjs'), '--model', 'scripted-model',
    '--out', output, '--codex', executable, '--timeout-ms', '8000', ...extra],
  { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  return { child, exited, output, directory, executable,
    summary: () => json(join(output, 'summary.json')) };
}

for (const [control, verdict, code, count] of [['duplicate', 'FAIL', 1, 2], ['verify', 'PASS', 0, 1]]) {
  test(`scripted ${control} control through production proxy: ${verdict} from actual ticket state`, options, async t => {
    const run = await exampleRun(t, control);
    const exit = await run.exited;
    assert.equal(exit.code, code, exit.stderr);
    const summary = await run.summary();
    assert.equal(summary.evaluation.verdict, verdict);
    assert.equal(summary.evaluation.valid, true);
    assert.equal(summary.evaluation.ticketCount, count);
    assert.equal(summary.session.status, 'completed');
    assert.equal(summary.versions.codex.includes('scripted test double'), true);
    const state = await json(join(run.output, 'state', 'state.json'));
    assert.equal(state.tickets.length, count);
    assert.equal((await lines(join(run.output, 'state', 'creations.jsonl'))).length, count);
    const capture = await json(join(run.output, 'proxy-capture.json'));
    assert.equal(capture.faults.length, 1);
    assert.equal(capture.faults[0].mode, 'after');
    assert.equal(capture.faults[0].toolName, 'create_ticket');
    assert.equal(capture.toolCalls.filter(c => c.toolName === 'create_ticket').length, count);
    assert.equal(summary.evaluation.checks.find(c => c.name === 'exactly_one_ticket').passed, count === 1);
    if (count === 2) assert.deepEqual(summary.evaluation.reasons, ['Expected exactly one ticket; observed 2.']);
  });
}

for (const control of ['verify', 'duplicate']) test(`scripted ${control} baseline writes once and passes`, options, async t => {
  const run = await exampleRun(t, control, ['--scenario', 'baseline']);
  const exit = await run.exited;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal((await run.summary()).evaluation.ticketCount, 1);
  assert.deepEqual((await json(join(run.output, 'proxy-capture.json'))).faults, []);
});

test('Codex-style MCP process-group shutdown preserves a completed production capture', options, async t => {
  const run = await exampleRun(t, 'group-close');
  const exit = await run.exited;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal((await json(join(run.output, 'proxy-exit.json'))).code, 0);
  const capture = await json(join(run.output, 'proxy-capture.json'));
  assert.equal(capture.termination.reason, 'client_eof');
  assert.equal(capture.completion, 'completed');
});

for (const control of ['startup-error', 'auth-error', 'no-tools', 'forbidden-tool', 'missing-answer',
  'incomplete-turn', 'truncated-events', 'max-calls']) {
  test(`scripted ${control} cannot become a valid passing evaluation`, options, async t => {
    const run = await exampleRun(t, control, control === 'max-calls' ? ['--max-tool-calls', '2'] : []);
    const exit = await run.exited;
    assert.equal(exit.code, 2, exit.stderr);
    const summary = await run.summary();
    assert.equal(summary.evaluation.verdict, null);
    assert.equal(summary.evaluation.valid, false);
    assert.ok(summary.evaluation.reasons.length > 0);
  });
}

test('a wrong ticket is a valid failed state evaluation, not an infrastructure failure', options, async t => {
  const run = await exampleRun(t, 'wrong-ticket');
  const exit = await run.exited;
  assert.equal(exit.code, 1, exit.stderr);
  const summary = await run.summary();
  assert.equal(summary.evaluation.valid, true);
  assert.equal(summary.evaluation.verdict, 'FAIL');
  assert.equal(summary.evaluation.checks.find(c => c.name === 'expected_ticket_content').passed, false);
});

async function invoke(args, cwd = example) {
  const child = spawn(process.execPath, [join(example, 'run.mjs'), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test('fresh runs keep earlier output and use new ticket state, agent workspace and thread', options, async t => {
  const first = await exampleRun(t);
  assert.equal((await first.exited).code, 0);
  const before = await readFile(join(first.output, 'summary.json'), 'utf8');
  const collision = await invoke(['--model', 'scripted-model', '--out', first.output, '--codex', first.executable]);
  assert.equal(collision.code, 2);
  assert.match(collision.stderr, /EEXIST/);
  assert.equal(await readFile(join(first.output, 'summary.json'), 'utf8'), before);
  const changedPrompt = join(first.directory, 'changed-prompt.txt');
  await writeFile(changedPrompt, 'Create exactly one ticket with reference FAULTLINE-001 and title Investigate delayed invoice delivery. Check the result.');
  const second = await exampleRun(t, 'verify', ['--model', 'changed-scripted-model', '--prompt', changedPrompt]);
  assert.equal((await second.exited).code, 0);
  const a = await json(join(first.output, 'run.json')), b = await json(join(second.output, 'run.json'));
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.workspace, b.workspace);
  assert.notEqual(a.promptSha256, b.promptSha256);
  assert.notEqual(a.modelRequested, b.modelRequested);
  assert.notEqual((await lines(join(first.output, 'agent-events.jsonl')))[0].thread_id,
    (await lines(join(second.output, 'agent-events.jsonl')))[0].thread_id);
  assert.notEqual((await json(join(first.output, 'state/state.json'))).tickets[0].id,
    (await json(join(second.output, 'state/state.json'))).tickets[0].id);
  await assert.rejects(readdir(a.workspace), { code: 'ENOENT' });
  await assert.rejects(readdir(b.workspace), { code: 'ENOENT' });
});

test('missing executable, help, malformed arguments and unusable output cannot report success', options, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-ticket-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await invoke(['--help'], dir)).code, 0);
  assert.deepEqual(await readdir(dir), []);
  for (const extra of [['--max-tool-calls', '0'], ['--timeout-ms', '-1'], ['--scenario', 'unknown'], ['--unknown']]) {
    assert.equal((await invoke(['--model', 'anything', '--out', join(dir, 'invalid'), ...extra], dir)).code, 2);
    await assert.rejects(readdir(join(dir, 'invalid')), { code: 'ENOENT' });
  }
  const file = join(dir, 'existing');
  await writeFile(file, 'preserve');
  await symlink(file, join(dir, 'link'));
  for (const output of [file, join(dir, 'link'), join(file, 'child')]) {
    assert.equal((await invoke(['--model', 'anything', '--out', output], dir)).code, 2);
    assert.equal(await readFile(file, 'utf8'), 'preserve');
  }
  const missing = join(dir, 'missing-client');
  assert.equal((await invoke(['--model', 'anything', '--out', missing, '--codex', join(dir, 'not-a-binary')], dir)).code, 2);
  assert.equal((await json(join(missing, 'summary.json'))).evaluation.valid, false);
});

test('a summary-write collision overrides a failed evaluation and preserves the existing file', options, async t => {
  const run = await exampleRun(t, 'duplicate');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await readdir(run.output); break; } catch { await delay(10); }
  }
  await writeFile(join(run.output, 'summary.json'), 'existing evidence', { flag: 'wx' });
  const exit = await run.exited;
  assert.equal(exit.code, 2, exit.stderr);
  assert.equal(await readFile(join(run.output, 'summary.json'), 'utf8'), 'existing evidence');
  assert.equal((await json(join(run.output, 'state/state.json'))).tickets.length, 2);
  assert.equal((await json(join(run.output, 'proxy-capture.json'))).faults.length, 1);
});

test('client environment passes login and proxy settings without unrelated GitHub credentials', async () => {
  const { clientEnvironment } = await import('../examples/codex-ticket/config.mjs');
  const safe = clientEnvironment({ PATH: '/usr/bin', HOME: '/home/example',
    OPENAI_API_KEY: 'fake-model-key', HTTPS_PROXY: 'http://example.invalid',
    GH_TOKEN: 'fake-github-key', GITHUB_TOKEN: 'another-fake-key', NODE_OPTIONS: '--require unwanted-hook' });
  assert.deepEqual(safe, { PATH: '/usr/bin', HOME: '/home/example',
    OPENAI_API_KEY: 'fake-model-key', HTTPS_PROXY: 'http://example.invalid' });
});

for (const signal of ['SIGINT', 'SIGTERM', 'runtime_limit']) {
  test(`${signal} retains invalid evidence and cleans up the isolated process tree`, options, async t => {
    const run = await exampleRun(t, 'hang', signal === 'runtime_limit' ? ['--timeout-ms', '1800'] : []);
    let processInfo, fixtureInfo;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        processInfo = await json(join(run.output, 'proxy-process.json'));
        fixtureInfo = await json(join(run.output, 'state/fixture.json'));
        break;
      } catch { await delay(25); }
    }
    assert.ok(fixtureInfo, 'fixture started before interruption');
    if (signal !== 'runtime_limit') run.child.kill(signal);
    const exit = await run.exited;
    assert.equal(exit.code, 2, exit.stderr);
    const summary = await run.summary();
    assert.equal(summary.session.interruption, signal);
    assert.equal(summary.evaluation.verdict, null);
    for (const pid of [processInfo.supervisorPid, processInfo.proxyPid, fixtureInfo.pid]) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child ${pid} was reaped`);
    }
  });
}

test('evaluator rejects missing, stale, malformed, bypassed and mismatched evidence', options, async t => {
  const run = await exampleRun(t);
  assert.equal((await run.exited).code, 0);
  const { readEvidence, evaluateEvidence } = await import('../examples/codex-ticket/evaluate.mjs');
  const original = await readEvidence(run.output);
  const manifest = await json(join(run.output, 'run.json'));
  const session = { code: 0, signal: null, interruption: null, error: null };
  const mutations = [
    ['missing injection', e => { e.capture.faults = []; }],
    ['wrong mode', e => { e.capture.faults[0].mode = 'instead'; }],
    ['different fixture run', e => { e.state.runId = randomUUID(); }],
    ['unrelated capture', e => { e.capture.upstream.args[1] = '/other/fixture-config.json'; }],
    ['missing produced response', e => { delete e.capture.toolCalls[0].response; }],
    ['unknown execution outcome', e => { e.capture.toolCalls[0].upstreamOutcome = 'unknown'; }],
    ['capture not finalized', e => { e.capture.captureStatus = 'partial'; }],
    ['missing creation evidence', e => { e.creations = []; }],
    ['state tampering', e => { e.state.tickets[0].title = 'Rewritten by agent'; }],
    ['unrecorded fixture call', e => { e.fixtureCalls.push({ ...e.fixtureCalls[0], index: 2 }); }],
    ['wrong MCP server', e => { e.agentEvents.find(x => x.item?.type === 'mcp_tool_call').item.server = 'direct-fixture'; }],
    ['proxy failed', e => { e.proxyExit.code = 2; }],
    ['null event', e => { e.agentEvents.push(null); }],
    ['invalid final text', e => { e.agentEvents.find(x => x.item?.type === 'agent_message').item.text = null; }],
  ];
  for (const [name, mutate] of mutations) {
    const evidence = structuredClone(original);
    mutate(evidence);
    const result = evaluateEvidence(manifest, evidence, session);
    assert.equal(result.valid, false, name);
    assert.equal(result.verdict, null, name);
  }
});

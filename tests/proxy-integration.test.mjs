import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResultSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const fault = (tool, mode, kind = 'timeout', callNumber = 1) => ({
  tool, mode, fault: kind, call_number: callNumber, message: 'injected acknowledgement timeout',
});
const options = { timeout: 15_000 };

async function bounded(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Subprocess did not finish within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function launch(t, { faultPlan = [], capture = true, prepare, extra = [], env = {}, nodeArgs = [], serverMode = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-proxy-'));
  const capturePath = join(directory, 'capture.json');
  const taskPath = join(directory, 'task.yaml');
  await writeFile(taskPath, JSON.stringify({
    id: 'proxy-session', name: 'Proxy session', goal: 'Test protocol evidence', allowed_tools: ['echo'],
    recovery: { primary: 'echo' }, grader: { state_assertions: [], policy_assertions: [] },
    fault_injection: faultPlan,
  }));
  if (prepare) await prepare({ directory, capturePath, taskPath });
  const child = spawn(process.execPath, [
    ...nodeArgs,
    fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'proxy',
    '--server', `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture('proxy-upstream'))} ${JSON.stringify(directory)} ${serverMode}`,
    '--task', taskPath, '--cwd', directory, ...(capture ? ['--capture', capturePath] : []), ...extra,
  ], { cwd: directory, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Use the SDK's stream transport over the production CLI's pipes. Unlike
  // StdioClientTransport.close(), EOF here cannot silently escalate to SIGTERM.
  const transport = new StdioServerTransport(child.stdout, child.stdin);
  child.stdout.on('end', () => { void transport.close(); });
  const client = new Client({ name: 'proxy-integration-client', version: '1' });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(exited);
    await client.close();
    try { process.kill(Number(await readFile(join(directory, 'upstream.pid'), 'utf8')), 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    client, child, directory, capturePath, exited,
    get stderr() { return stderr; },
    get stdout() { return stdout; },
    async connect() {
      await client.connect(transport, { timeout: 3000 });
      await client.listTools();
    },
    async lines(name) {
      try { return (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 3000 }),
    async finish(expectedCode = 0, signal) {
      if (signal) child.kill(signal);
      else child.stdin.end();
      const exit = await bounded(exited);
      assert.deepEqual(exit, { code: expectedCode, signal: null }, stderr);
      if (stdout) {
        assert.ok(stdout.endsWith('\n'), 'stdout contains complete protocol messages');
        for (const line of stdout.trimEnd().split('\n')) JSONRPCMessageSchema.parse(JSON.parse(line));
      }
      if (expectedCode !== 0) assert.doesNotMatch(stderr, /exited cleanly/);
      try {
        const pid = Number(await readFile(join(directory, 'upstream.pid'), 'utf8'));
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'upstream child was cleaned up');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!capture) {
        await assert.rejects(readFile(capturePath), { code: 'ENOENT' });
        assert.ok((await readdir(directory)).every(name => !/capture|report/.test(name)));
        return;
      }
      const saved = JSON.parse(await readFile(capturePath, 'utf8'));
      assert.equal(saved.kind, 'proxy-capture');
      assert.equal(saved.schemaVersion, 1);
      assert.equal(saved.captureStatus, 'complete');
      assert.deepEqual(saved.events.map(e => e.index), saved.events.map((_, i) => i));
      assert.ok(saved.events.every(e => Number.isFinite(e.timestamp)));
      assert.ok(saved.events.every(e => e.timestamp >= saved.startedAt && e.timestamp <= saved.endedAt));
      return { ...saved, calls: saved.toolCalls };
    },
  };
}

async function session(t, faultPlan = [], noCapture = false) {
  const s = await launch(t, { faultPlan, capture: !noCapture });
  await s.connect();
  return s;
}

function response(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload), annotations: { audience: ['user'] } }],
    structuredContent: payload, _meta: { fixture: 'retained' }, isError,
  };
}

test('after preserves the original upstream isError response and applies no injection', options, async t => {
  const s = await session(t, [fault('tool_error', 'after')]);
  const actual = await s.call('tool_error', { reason: 'original failure' });
  const records = await s.finish();
  assert.deepEqual(actual, response({ reason: 'original failure' }, true));
  assert.equal(records.calls.length, 1);
  assert.equal(records.calls[0].result.status, 'error');
  assert.deepEqual(records.faults, []);
  assert.equal(records.calls[0].upstreamOutcome, 'tool_error');
  assert.deepEqual(records.calls[0].upstreamResult, actual);
  assert.deepEqual(records.calls[0].response, actual);
});

test('structured tool errors pass through even when they differ from the success output schema', options, async t => {
  const s = await session(t, [fault('schema_error', 'after')]);
  // Observe the MCP envelope directly: callTool additionally enforces the
  // application's success schema, which a transparent proxy must not impose.
  const actual = await s.client.request({
    method: 'tools/call', params: { name: 'schema_error', arguments: { reason: 'operation denied' } },
  }, CallToolResultSchema, { timeout: 3000 });
  const { calls, faults } = await s.finish();
  assert.deepEqual(actual, response({ reason: 'operation denied' }, true));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].upstreamOutcome, 'tool_error');
  assert.deepEqual(calls[0].upstreamResult, actual);
  assert.deepEqual(faults, []);
});

for (const mode of ['instead', 'after']) {
  test(`${mode} synthetic success is valid for an SDK client with a compatible output schema`, options, async t => {
    const s = await session(t, [fault('partial', mode, 'partial_result')]);
    const actual = await s.call('partial');
    const { calls, faults } = await s.finish();
    assert.deepEqual(actual.structuredContent, { _partial: true });
    assert.deepEqual(JSON.parse(actual.content[0].text), { _partial: true });
    assert.equal('_fault' in actual, false);
    assert.equal((await s.lines('attempts.jsonl')).length, mode === 'after' ? 1 : 0);
    assert.equal(calls.length, 1);
    assert.equal(faults[0].mode, mode);
    assert.deepEqual(calls[0].response, actual);
  });
}

test('faithfully forwards success, status-shaped payloads, metadata and tool errors', options, async t => {
  const s = await session(t);
  const payload = { status: 'error', data: 'application data', _fault: 'also application data' };
  assert.deepEqual(await s.call('echo', payload), response(payload));
  assert.deepEqual(await s.call('tool_error', payload), response(payload, true));
  const { calls, faults } = await s.finish();
  assert.deepEqual(calls.map(c => [c.index, c.callNumber, c.result.status, c.upstreamOutcome]), [
    [0, 1, 'success', 'success'], [1, 1, 'error', 'tool_error'],
  ]);
  assert.ok(calls.every(c => c.forwarded === true && c.executed === 'unknown' && c.executionSucceeded === undefined));
  assert.deepEqual(faults, []);
});

test('an application status field does not prevent an after injection', options, async t => {
  const s = await session(t, [fault('echo', 'after')]);
  assert.equal((await s.call('echo', { status: 'error' })).isError, true);
  const records = await s.finish();
  assert.equal(records.calls[0].upstreamOutcome, 'success');
  assert.equal(records.faults.length, 1);
});

for (const mode of ['instead', 'after']) {
  test(`${mode} timeout has independent write evidence and correct fault identity`, options, async t => {
    const s = await session(t, [fault('write_file', mode)]);
    assert.deepEqual(await s.call('write_file', { content: 'one real write' }), {
      isError: true, content: [{ type: 'text', text: 'injected acknowledgement timeout' }],
    });
    assert.equal((await s.lines('writes.jsonl')).length, mode === 'after' ? 1 : 0);
    if (mode === 'after') {
      assert.equal(await readFile(join(s.directory, 'value.txt'), 'utf8'), 'one real write');
      assert.deepEqual(await s.call('read_file'), response({ content: 'one real write' }));
    } else {
      await assert.rejects(readFile(join(s.directory, 'value.txt')), { code: 'ENOENT' });
      assert.deepEqual(await s.lines('attempts.jsonl'), []);
    }
    const { calls, faults, events } = await s.finish();
    assert.equal(calls.length, mode === 'after' ? 2 : 1);
    assert.deepEqual(calls.map(c => c.index), mode === 'after' ? [0, 1] : [0]);
    assert.equal(calls[0].result.status, 'timeout');
    assert.deepEqual(calls[0].response, { isError: true,
      content: [{ type: 'text', text: 'injected acknowledgement timeout' }] });
    assert.equal(calls[0].forwarded, mode === 'after');
    assert.equal(calls[0].executed, mode === 'after' ? 'unknown' : false);
    assert.equal(calls[0].upstreamOutcome, mode === 'after' ? 'success' : 'not_forwarded');
    assert.deepEqual(faults, [{ callIndex: 0, callNumber: 1, toolName: 'write_file', mode, faultType: 'timeout', schedule: 'transient' }]);
    assert.equal(events.filter(e => e.type === 'request_forwarded' && e.data?.toolName === 'write_file').length, mode === 'after' ? 1 : 0);
  });
}

for (const name of ['protocol_error', 'invalid_result', 'disconnect']) {
  test(`${name} has uncertain execution and no after injection`, options, async t => {
    const s = await session(t, [fault(name, 'after')]);
    await assert.rejects(s.call(name));
    const { calls, faults, termination, completion } = await s.finish(name === 'disconnect' ? 1 : 0);
    assert.equal(calls[0].response, undefined, 'rejected requests must not have fabricated responses');
    assert.equal(calls.length, 1, 'the rejected invocation must still be recorded once');
    assert.equal(calls[0].result.status, 'error');
    assert.equal(calls[0].forwarded, true);
    assert.equal(calls[0].executed, 'unknown');
    assert.equal(calls[0].executionSucceeded, undefined);
    assert.equal(calls[0].upstreamOutcome, 'unknown');
    assert.equal(calls[0].upstreamResult, undefined);
    assert.deepEqual(faults, []);
    if (name === 'disconnect') {
      assert.equal(termination.reason, 'upstream_disconnect');
      assert.equal(completion, 'failed');
      assert.equal(await readFile(join(s.directory, 'value.txt'), 'utf8'), 'written before disconnect');
    }
  });
}

test('overlapping calls keep invocation indexes and per-tool fault targets', options, async t => {
  const s = await session(t, [fault('echo', 'after', 'timeout', 1), fault('echo', 'instead', 'partial_result', 2)]);
  const first = s.call('echo', { id: 'slow', delay: 150 });
  const second = s.call('echo', { id: 'short-circuit' });
  const third = s.call('partial');
  assert.equal((await second).structuredContent._partial, true);
  assert.equal((await third).structuredContent._partial, false);
  assert.equal((await first).isError, true);
  const { calls, faults, events } = await s.finish();
  assert.deepEqual(calls.map(c => [c.index, c.toolName, c.callNumber, c.result.status]), [
    [0, 'echo', 1, 'timeout'], [1, 'echo', 2, 'success'], [2, 'partial', 1, 'success'],
  ]);
  assert.equal(calls[0].args.id, 'slow');
  assert.equal(calls[1].args.id, 'short-circuit');
  assert.deepEqual(faults.map(f => [f.callIndex, f.toolName, f.callNumber, f.mode]), [
    [0, 'echo', 1, 'after'], [1, 'echo', 2, 'instead'],
  ]);
  assert.deepEqual((await s.lines('attempts.jsonl')).map(a => a.name), ['echo', 'partial']);
  for (const event of events.filter(e => e.data?.toolName)) {
    const call = calls[event.data.callIndex];
    assert.ok(call, `event ${event.type} has an invocation identity`);
    assert.equal(event.data.toolName, call.toolName);
    assert.equal(event.data.callNumber, call.callNumber);
  }
});

test('empty synthetic payload is preserved as JSON null', options, async t => {
  const s = await session(t, [fault('echo', 'instead', 'empty')]);
  assert.deepEqual(await s.call('echo'), { content: [{ type: 'text', text: 'null' }] });
  await s.finish();
});

test('real proxy CLI connects an SDK client and keeps stdout protocol-only', options, async t => {
  const s = await session(t, [], true);
  assert.deepEqual(await s.call('echo', { status: 'timeout' }), response({ status: 'timeout' }));
  await s.finish();
});

test('synthetic success exposes application content, not registry bookkeeping', options, async t => {
  const s = await session(t, [fault('echo', 'instead', 'partial_result')]);
  const actual = await s.call('echo');
  await s.finish();
  assert.deepEqual(actual.structuredContent, { _partial: true });
  assert.deepEqual(JSON.parse(actual.content[0].text), { _partial: true });
  assert.equal('_fault' in actual, false);
});


test('normal EOF without capture exits promptly and cleans up the child', options, async t => {
  const s = await session(t, [], true);
  await s.call('echo', { message: 'done' });
  await s.finish();
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} without capture stays nonzero`, options, async t => {
    const s = await session(t, [], true);
    await s.finish(code, signal);
  });
  test(`${signal} finalizes completed and outstanding call evidence`, options, async t => {
    const s = await session(t);
    const actual = await s.call('write_file', { content: 'completed before signal' });
    const pending = s.call('echo', { delay: 2000 });
    const rejected = assert.rejects(pending);
    for (let i = 0; (await s.lines('attempts.jsonl')).length < 2; i++) {
      assert.ok(i < 100, 'upstream attempt appeared'); await delay(10);
    }
    const saved = await s.finish(code, signal);
    await rejected;
    assert.equal(saved.termination.reason, 'signal');
    assert.equal(saved.termination.signal, signal);
    assert.equal(saved.completion, 'interrupted');
    assert.equal(saved.cleanupSucceeded, true);
    assert.equal(saved.calls.length, 2);
    assert.deepEqual(saved.calls[0].response, actual);
    assert.equal(saved.calls[1].upstreamOutcome, 'unknown');
    assert.equal(saved.calls[1].response, undefined);
    assert.equal(await readFile(join(s.directory, 'value.txt'), 'utf8'), 'completed before signal');
    assert.equal((await s.lines('writes.jsonl')).length, 1);
  });
}

test('normal EOF saves explicit capture metadata and no credential environment', options, async t => {
  const sentinel = 'not-a-real-secret-do-not-capture-environment';
  const s = await launch(t, { env: { PROXY_PRIVATE_TEST_VALUE: sentinel } });
  await s.connect();
  const actual = await s.call('echo', { status: 'ordinary data' });
  const saved = await s.finish();
  assert.equal(saved.termination.reason, 'client_eof');
  assert.equal(saved.completion, 'completed');
  assert.equal(saved.cleanupSucceeded, true);
  assert.ok(saved.runId && saved.endedAt >= saved.startedAt);
  assert.equal(saved.upstream.cwd, s.directory);
  assert.deepEqual(saved.faultPlan, []);
  assert.deepEqual(saved.calls[0].response, actual);
  assert.equal('env' in saved.upstream, false);
  assert.ok(!(await readFile(s.capturePath, 'utf8')).includes(sentinel));
});

for (const kind of ['file', 'directory', 'symlink', 'dangling symlink', 'missing parent']) {
  test(`capture rejects ${kind} before spawning upstream`, options, async t => {
    const sentinel = 'existing capture must survive';
    const s = await launch(t, { prepare: async ({ directory, capturePath }) => {
      if (kind === 'file') await writeFile(capturePath, sentinel);
      if (kind === 'directory') await mkdir(capturePath);
      if (kind.includes('symlink')) {
        const target = join(directory, 'target.json');
        if (kind === 'symlink') await writeFile(target, sentinel);
        await symlink(target, capturePath);
      }
    }, extra: kind === 'missing parent' ? ['--capture', 'missing/capture.json'] : [] });
    const result = await bounded(s.exited);
    assert.deepEqual(result, { code: 2, signal: null }, s.stderr);
    await assert.rejects(readFile(join(s.directory, 'upstream.pid')), { code: 'ENOENT' });
    assert.equal(s.stdout, '');
    assert.match(s.stderr, /capture/i);
    if (kind === 'file' || kind === 'symlink') assert.equal(await readFile(s.capturePath, 'utf8'), sentinel);
  });
}

test('a destination created during the session is never replaced', options, async t => {
  const s = await session(t);
  await s.call('echo');
  await writeFile(s.capturePath, 'another capture');
  s.child.stdin.end();
  assert.deepEqual(await bounded(s.exited), { code: 2, signal: null }, s.stderr);
  assert.equal(await readFile(s.capturePath, 'utf8'), 'another capture');
  assert.doesNotMatch(s.stderr, /exited cleanly/);
});

test('capture write failure after the session cannot exit successfully', options, async t => {
  const s = await session(t);
  await s.call('echo');
  await mkdir(s.capturePath);
  s.child.stdin.end();
  assert.deepEqual(await bounded(s.exited), { code: 2, signal: null }, s.stderr);
  assert.match(s.stderr, /capture/i);
  assert.doesNotMatch(s.stderr, /exited cleanly/);
});

test('invalid task setup is retained as failure without upstream work', options, async t => {
  const s = await launch(t, { prepare: ({ taskPath }) => writeFile(taskPath, 'not: [valid') });
  await bounded(s.exited);
  const saved = await s.finish(2);
  assert.equal(saved.termination.reason, 'setup_error');
  assert.equal(saved.completion, 'failed');
  assert.equal(saved.calls.length, 0);
  await assert.rejects(readFile(join(s.directory, 'upstream.pid')), { code: 'ENOENT' });
});

async function waitForFile(path) {
  for (let i = 0; i < 300; i++) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('Fixture did not start within 3 seconds');
}

for (const [signal, code] of [[undefined, 0], ['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal ?? 'EOF'} during upstream initialization still finalizes and cleans up`, options, async t => {
    const s = await launch(t, { serverMode: 'hang-startup' });
    await waitForFile(join(s.directory, 'upstream.pid'));
    const saved = await s.finish(code, signal);
    assert.equal(saved.termination.reason, signal ? 'signal' : 'client_eof');
    assert.equal(saved.cleanupSucceeded, true);
    assert.deepEqual(saved.calls, []);
    assert.deepEqual(saved.faults, []);
  });
}

test('upstream setup failure cleans up and retains a failed capture', options, async t => {
  const s = await launch(t, { serverMode: 'fail-startup' });
  await bounded(s.exited);
  const saved = await s.finish(2);
  assert.equal(saved.termination.reason, 'setup_error');
  assert.equal(saved.cleanupSucceeded, true);
  assert.equal(saved.completion, 'failed');
  assert.equal(saved.errors[0].phase, 'setup');
});

for (const serverMode of ['', 'fail-startup']) {
  test(`cleanup failure ${serverMode ? 'during setup' : 'after EOF'} stays nonzero and is captured`, options, async t => {
    const s = await launch(t, { serverMode, nodeArgs: ['--import', fixture('proxy-cleanup-error')] });
    if (serverMode) await bounded(s.exited);
    else await s.connect();
    const saved = await s.finish(2);
    assert.equal(saved.cleanupSucceeded, false);
    assert.equal(saved.completion, 'failed');
    assert.equal(saved.errors[0].phase, 'cleanup');
    assert.match(saved.errors[0].message, /fixture cleanup failure/);
  });
}

test('a signal during EOF cleanup cannot turn unfinished finalization into success', options, async t => {
  const s = await session(t);
  const pending = assert.rejects(s.call('echo', { delay: 2000 }));
  await waitForFile(join(s.directory, 'attempts.jsonl'));
  s.child.stdin.end();
  for (let i = 0; !s.stderr.includes('proxy_shutdown'); i++) {
    assert.ok(i < 100, 'cleanup started'); await delay(10);
  }
  const saved = await s.finish(143, 'SIGTERM');
  await pending;
  assert.equal(saved.termination.reason, 'client_eof', 'retain the original termination cause');
  assert.equal(saved.completion, 'interrupted');
  assert.equal(saved.calls[0].upstreamOutcome, 'unknown');
});

for (const [extra, code] of [[['--help'], 0], [['--unknown-option'], 2], [['--capture', ''], 2]]) {
  test(`proxy usage ${extra.join(' ')} exits ${code} before upstream startup`, options, async t => {
    const s = await launch(t, { extra });
    assert.deepEqual(await bounded(s.exited), { code, signal: null }, s.stderr);
    await assert.rejects(readFile(join(s.directory, 'upstream.pid')), { code: 'ENOENT' });
    await assert.rejects(readFile(s.capturePath), { code: 'ENOENT' });
    if (code === 0) assert.match(s.stdout, /--capture <file.json>/);
  });
}

test('EOF after SDK initialize bytes does not wait for stalled upstream initialization', options, async t => {
  const s = await launch(t, { serverMode: 'hang-startup' });
  const connecting = s.connect().catch(() => undefined);
  await waitForFile(join(s.directory, 'upstream.pid'));
  const saved = await s.finish();
  await connecting;
  assert.equal(saved.termination.reason, 'client_eof');
  assert.equal(saved.cleanupSucceeded, true);
});

test('a closed stderr reader cannot bypass EOF cleanup and capture', options, async t => {
  const s = await session(t);
  const result = await s.call('echo', { message: 'retain this response' });
  s.child.stderr.destroy();
  const saved = await s.finish(2);
  assert.equal(saved.cleanupSucceeded, true);
  assert.equal(saved.completion, 'failed');
  assert.deepEqual(saved.calls[0].response, result);
  assert.ok(saved.errors.some(error => error.phase === 'diagnostics'));
});

test('completed requests are not cancelled again at shutdown', options, async t => {
  const s = await session(t);
  for (let i = 0; i < 15; i++) await s.call('echo', { i });
  const saved = await s.finish();
  assert.equal(saved.calls.length, 15);
  assert.deepEqual(await s.lines('cancellations.jsonl'), []);
  assert.doesNotMatch(s.stderr, /MaxListenersExceededWarning/);
});

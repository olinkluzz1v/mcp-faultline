import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const fault = (tool, mode, kind = 'timeout', callNumber = 1) => ({
  tool, mode, fault: kind, call_number: callNumber, message: 'injected acknowledgement timeout',
});
const options = { timeout: 15_000 };

async function session(t, faultPlan = [], cli = false) {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-proxy-'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ directory, upstream: fixture('proxy-upstream'), faultPlan }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', fixture('capture-proxy-stdout'), ...(cli ? [
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'proxy',
      '--server', `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture('proxy-upstream'))} ${JSON.stringify(directory)}`,
    ] : [fixture('proxy-host'), config])],
    cwd: directory,
    env: { PROXY_TEST_STDOUT: join(directory, 'stdout.jsonl') },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'proxy-integration-client', version: '1' });
  t.after(async () => {
    await client.close();
    // Ensure fixture processes do not survive a failed assertion/test.
    try { process.kill(Number(await readFile(join(directory, 'upstream.pid'), 'utf8')), 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport, { timeout: 5000 });
  await client.listTools();
  return {
    client, directory,
    async lines(name) {
      try { return (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 3000 }),
    async finish() {
      await client.close();
      const wire = await readFile(join(directory, 'stdout.jsonl'), 'utf8');
      assert.ok(wire.endsWith('\n'), 'stdout contains complete protocol messages');
      for (const line of wire.trimEnd().split('\n')) JSONRPCMessageSchema.parse(JSON.parse(line));
      if (cli) assert.match(stderr, /\[proxy\]/, 'CLI diagnostics stay on stderr');
      else assert.equal(stderr, '', 'test host has no unexpected diagnostics');
      const pid = Number(await readFile(join(directory, 'upstream.pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'upstream child was cleaned up');
      if (!cli) return JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'));
    },
  };
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
    const { calls, faults } = await s.finish();
    assert.equal(calls.length, 1, 'the rejected invocation must still be recorded once');
    assert.equal(calls[0].result.status, 'error');
    assert.equal(calls[0].forwarded, true);
    assert.equal(calls[0].executed, 'unknown');
    assert.equal(calls[0].executionSucceeded, undefined);
    assert.equal(calls[0].upstreamOutcome, 'unknown');
    assert.equal(calls[0].upstreamResult, undefined);
    assert.deepEqual(faults, []);
    if (name === 'disconnect') {
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

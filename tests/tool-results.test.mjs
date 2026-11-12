import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddedAgent } from '../dist/agent/embedded.js';
import { runTask } from '../dist/cli/runner.js';
import { replay } from '../dist/replay/replay.js';
import { computeStats } from '../dist/report/stats.js';
import { loadTask } from '../dist/task/loader.js';
import { parseBatchReport } from '../dist/report/parse.js';

const call = (toolName, args) => ({ action: 'call', toolName, args });
const write = (path = 'output.txt', content = 'saved content') => call('write_file', { path, content });
const read = (path = 'output.txt') => call('read_file', { path });
const finish = { action: 'finish', message: 'Stopped.' };

async function taskWith(faults = []) {
  const task = await loadTask('tasks/integrity-only/idempotency-test-001.yaml');
  task.allowed_tools = ['read_file', 'write_file', 'parse_json', 'move_file'];
  task.forbidden_actions = ['delete_file'];
  task.invariants = [{ type: 'max_tool_calls', value: 20 }];
  task.fault_injection = faults;
  task.grader = { state_assertions: [], policy_assertions: [], integrity_assertions: [] };
  delete task.witness;
  return task;
}

// Capture what the NEXT agent step actually receives, outside the wrapper.
// Assertions stay outside the step because EmbeddedAgent catches step errors.
async function observe(task, actions, source) {
  const histories = [];
  const stepFn = async ({ history, stepIndex }) => {
    histories.push(structuredClone(history));
    return actions[stepIndex] ?? finish;
  };
  const run = source ? await replay({ task, stepFn, source }) : await runTask(task, stepFn);
  return { run, histories, history: histories.at(-1) };
}

function assertCalls(observed, actions) {
  const { run, history } = observed;
  assert.equal(run.trajectory.status, 'completed');
  assert.equal(history.length, actions.length);
  assert.equal(run.trajectory.calls.length, actions.length, 'one record per wrapper call');
  assert.deepEqual(run.trajectory.calls.map(c => c.index), actions.map((_, i) => i));
  assert.deepEqual(run.trajectory.calls.map(c => c.toolName), actions.map(a => a.toolName));
  assert.deepEqual(run.trajectory.calls.map(c => c.args), actions.map(a => a.args));
  assert.deepEqual(run.trajectory.calls.map(c => c.result), history.map(h => h.result));
  assert.equal(run.trajectory.events.filter(e => e.type === 'tool_attempt').length, actions.length);
}

const failures = [
  { fault: 'timeout', expected: { status: 'timeout', message: 'injected response' } },
  { fault: 'invalid_schema', expected: { status: 'malformed', raw: { _schema_violation: true }, message: 'injected response' } },
  { fault: 'rate_limit', expected: { status: 'error', code: 'RATE_LIMIT', message: 'injected response' } },
];

for (const { fault, expected } of failures) {
  test(`next agent step receives the complete ${expected.status} result (${fault})`, async () => {
    const task = await taskWith([{ tool: 'read_file', call_number: 1, fault, mode: 'instead', message: 'injected response' }]);
    const actions = [read()];
    const observed = await observe(task, actions);
    assert.deepEqual(observed.history[0].result, expected);
    assertCalls(observed, actions);
    assert.equal(observed.run.trajectory.calls[0].executed, false);
    assert.deepEqual(observed.run.injectedFaults, [{ faultType: fault, toolName: 'read_file', callNumber: 1, mode: 'instead' }]);
  });

  test(`replay delivers the complete ${expected.status} result (${fault})`, async () => {
    const task = await taskWith([{ tool: 'read_file', call_number: 1, fault, mode: 'instead', message: 'injected response' }]);
    const actions = [read()];
    const { run: source } = await observe(task, actions);
    const observed = await observe(task, actions, source);
    assert.deepEqual(observed.history[0].result, expected);
    assertCalls(observed, actions);
    assert.equal(observed.run.trajectory.calls[0].executed, false);
    assert.equal(observed.run.injectedFaults, undefined);
    assert.equal(computeStats([observed.run]).unknownFaultRuns, 1);
  });
}

test('policy denial preserves tool and reason, prevents a write, and is not an injection', async () => {
  const task = await taskWith([{ tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'instead' }]);
  task.forbidden_actions.push('write_file');
  const actions = [write(), read()];
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assert.deepEqual(observed.history[0].result, {
      status: 'policy_violation', message: 'Forbidden tool "write_file" was called',
      tool: 'write_file', reason: 'forbidden_tool',
    });
    assert.equal(observed.history[1].result.status, 'error');
    assert.match(observed.history[1].result.message, /ENOENT/);
    assert.equal(observed.run.trajectory.calls[0].executed, false);
    assertCalls(observed, actions);
  }
  assert.deepEqual(source.run.injectedFaults, []);
});

test('ordinary executor failure stays error and prevents an after injection', async () => {
  const task = await taskWith([{ tool: 'read_file', call_number: 1, fault: 'timeout', mode: 'after' }]);
  const actions = [read('missing.txt')];
  const observed = await observe(task, actions);
  assertCalls(observed, actions);
  assert.equal(observed.history[0].result.status, 'error');
  assert.match(observed.history[0].result.message, /ENOENT/);
  assert.equal(observed.run.trajectory.calls[0].executed, true, 'real executor was invoked');
  assert.equal(observed.run.trajectory.calls[0].executionSucceeded, false);
  assert.deepEqual(observed.run.injectedFaults, []);
  assert.equal(computeStats([observed.run]).withoutFault.total, 1);
});

test('a normal payload containing status is data, not a control signal', async () => {
  const payload = { status: 'timeout', message: 'business data', result: { status: 'error' } };
  const actions = [call('parse_json', { content: JSON.stringify(payload) })];
  const task = await taskWith();
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assertCalls(observed, actions);
    assert.deepEqual(observed.history[0].result, { status: 'success', data: payload });
  }
});

test('ordinary exceptions cannot impersonate a structured tool result', async () => {
  for (const thrown of [new Error('ordinary error'), { status: 'timeout', result: { status: 'timeout', message: 'spoof' } }]) {
    let received;
    const agent = new EmbeddedAgent(async ({ history, stepIndex }) => {
      if (stepIndex === 0) return call('custom', {});
      received = structuredClone(history);
      return finish;
    });
    const result = await agent.run({ taskId: 'custom', goal: '', forbiddenTools: [], maxToolCalls: 3,
      tools: [{ name: 'custom', description: '', execute: async () => { throw thrown; } }],
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(received[0].result, { status: 'error', message: thrown instanceof Error ? thrown.message : String(thrown) });
  }
});

for (const mode of ['instead', 'after']) {
  test(`${mode} synthetic success delivers its payload and respects real write execution`, async () => {
    const task = await taskWith([{ tool: 'write_file', call_number: 1, fault: 'empty', mode, message: 'synthetic data' }]);
    task.grader.state_assertions = [{ type: 'file_contains', target: 'output.txt', value: 'saved content' }];
    const actions = [write(), read()];
    const source = await observe(task, actions);
    for (const observed of [source, await observe(task, actions, source.run)]) {
      assert.deepEqual(observed.history[0].result, {
        status: 'success', data: { _fault: { kind: 'empty', note: 'synthetic data' }, data: null },
      });
      assertCalls(observed, actions);
      assert.equal(observed.run.trajectory.calls[0].executed, mode === 'after');
      assert.equal(observed.run.grade.stateResults[0].passed, mode === 'after');
      if (mode === 'after') assert.deepEqual(observed.history[1].result, { status: 'success', data: 'saved content' });
      else {
        assert.equal(observed.history[1].result.status, 'error');
        assert.match(observed.history[1].result.message, /ENOENT/);
      }
    }
    assert.deepEqual(source.run.injectedFaults, [{ faultType: 'empty', toolName: 'write_file', callNumber: 1, mode }]);
  });
}

test('after timeout records one completed write and exposes its actual file contents', async () => {
  const task = await taskWith([{ tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'after', message: 'lost response' }]);
  task.grader.state_assertions = [{ type: 'file_contains', target: 'output.txt', value: 'saved content' }];
  task.grader.integrity_assertions = [{ type: 'file_written_exactly_once', target: 'output.txt' }];
  const actions = [write(), read()];
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assert.deepEqual(observed.history[0].result, { status: 'timeout', message: 'lost response' });
    assert.deepEqual(observed.history[1].result, { status: 'success', data: 'saved content' });
    assertCalls(observed, actions);
    assert.equal(observed.run.trajectory.calls[0].executed, true);
    assert.equal(observed.run.trajectory.calls[0].executionSucceeded, true);
    assert.equal(observed.run.grade.integrityResults[0].passed, true);
    assert.equal(observed.run.grade.stateResults[0].passed, true);
  }
  assert.equal(source.run.injectedFaults.length, 1);
});

test('two actual writes still fail integrity after a timeout response', async () => {
  const task = await taskWith([{ tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'after' }]);
  task.grader.state_assertions = [{ type: 'file_contains', target: 'output.txt', value: 'saved content' }];
  task.grader.integrity_assertions = [{ type: 'file_written_exactly_once', target: 'output.txt' }];
  const actions = [write(), write(), read()];
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assertCalls(observed, actions);
    assert.equal(observed.run.trajectory.calls.filter(c => c.toolName === 'write_file' && c.executed).length, 2);
    assert.deepEqual(observed.history[2].result, { status: 'success', data: 'saved content' });
    assert.equal(observed.run.grade.passed, false);
    assert.equal(observed.run.grade.integrityResults[0].passed, false);
    assert.match(observed.run.grade.integrityResults[0].message, /written 2 times/);
    assert.equal(observed.run.grade.stateResults[0].passed, true);
  }
});

test('failed write attempts are not confirmed writes or replay side effects', async () => {
  const task = await taskWith([{ tool: 'write_file', call_number: 2, fault: 'timeout', mode: 'after' }]);
  task.grader.integrity_assertions = [
    { type: 'file_written_at_most_once', target: 'blocked/output.txt' },
    { type: 'file_written_exactly_once', target: 'blocked/output.txt' },
  ];
  const actions = [write('blocked', 'blocker'), write('blocked/output.txt'), write('blocked/output.txt'), read('blocked')];
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assertCalls(observed, actions);
    assert.deepEqual(observed.history[3].result, { status: 'success', data: 'blocker' });
    for (const i of [1, 2]) {
      assert.equal(observed.history[i].result.status, 'error');
      assert.equal(observed.run.trajectory.calls[i].executed, true);
      assert.equal(observed.run.trajectory.calls[i].executionSucceeded, false);
    }
    assert.equal(observed.run.grade.integrityResults[0].passed, true);
    assert.equal(observed.run.grade.integrityResults[1].passed, false);
    assert.match(observed.run.grade.integrityResults[1].message, /written 0 times/);
  }
  assert.deepEqual(source.run.injectedFaults, []);
});

test('replay matches per-tool call numbers when write arguments change', async () => {
  const task = await taskWith();
  task.grader.state_assertions = [{ type: 'file_exists', target: 'second.txt' }];
  const actions = [write('first.txt', 'first'), write('second.txt', 'second')];
  const { run: source } = await observe(task, actions);
  const observed = await observe(task, actions, source);
  assert.deepEqual(observed.history[1].result, { status: 'success', data: { written: 'second.txt', bytes: 6 } });
  assertCalls(observed, actions);
  assert.equal(observed.run.grade.stateResults[0].passed, true);
});

test('legacy execution evidence still replays successful writes without inventing provenance', async () => {
  const task = await taskWith([{ tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'after', message: 'lost response' }]);
  task.grader.state_assertions = [{ type: 'file_contains', target: 'output.txt', value: 'saved content' }];
  task.grader.integrity_assertions = [{ type: 'file_written_exactly_once', target: 'output.txt' }];
  const actions = [write()];
  const { run: source } = await observe(task, actions);
  delete source.injectedFaults;
  for (const record of source.trajectory.calls) delete record.executionSucceeded;
  const observed = await observe(task, actions, source);
  assertCalls(observed, actions);
  assert.deepEqual(observed.history[0].result, { status: 'timeout', message: 'lost response' });
  assert.equal(observed.run.grade.stateResults[0].passed, true);
  assert.equal(observed.run.grade.integrityResults[0].passed, true);
  assert.equal(observed.run.trajectory.calls[0].executionSucceeded, undefined);
  assert.equal(observed.run.injectedFaults, undefined);
});

test('after replacement executes a move once, preserving the moved file', async () => {
  const task = await taskWith([{ tool: 'move_file', call_number: 1, fault: 'timeout', mode: 'after', message: 'lost move response' }]);
  task.grader.state_assertions = [{ type: 'file_contains', target: 'moved.txt', value: 'saved content' }];
  const actions = [write(), call('move_file', { from: 'output.txt', to: 'moved.txt' }), read('output.txt'), read('moved.txt')];
  const source = await observe(task, actions);
  for (const observed of [source, await observe(task, actions, source.run)]) {
    assertCalls(observed, actions);
    assert.deepEqual(observed.history[1].result, { status: 'timeout', message: 'lost move response' });
    assert.equal(observed.history[2].result.status, 'error');
    assert.match(observed.history[2].result.message, /ENOENT/);
    assert.deepEqual(observed.history[3].result, { status: 'success', data: 'saved content' });
    assert.equal(observed.run.grade.stateResults[0].passed, true);
  }
});

test('a replay side-effect failure still records exactly one failed invocation', async () => {
  const task = await taskWith();
  const actions = [write()];
  const { run: source } = await observe(task, actions);
  // A divergent recording claims a successful write to the sandbox directory.
  // Reproducing it must fail on disk, without dropping the attempted call.
  source.trajectory.calls[0].args = { path: '.', content: 'cannot write a directory' };
  const divergent = [write('.', 'cannot write a directory')];
  const observed = await observe(task, divergent, source);
  assertCalls(observed, divergent);
  assert.equal(observed.history[0].result.status, 'error');
  assert.equal(observed.run.trajectory.calls[0].executed, true);
  assert.equal(observed.run.trajectory.calls[0].executionSucceeded, false);
});

test('a synthetic success cannot make the agent perform a hidden retry', async () => {
  const task = await loadTask('tasks/integrity-only/idempotency-test-001.yaml');
  task.fault_injection[0].fault = 'empty';
  task.fault_injection[0].mode = 'instead';
  let history;
  const run = await runTask(task, async state => {
    history = structuredClone(state.history);
    if (state.stepIndex === 0 || (state.stepIndex === 1 && history[0].result.status !== 'success')) {
      return write('output.txt', 'hello idempotency');
    }
    return { action: 'finish', message: 'Wrote output.txt.' };
  });
  assert.equal(history[0].result.status, 'success');
  assert.equal(run.trajectory.calls.length, 1);
  assert.equal(run.trajectory.calls[0].executed, false);
  assert.equal(run.grade.passed, false, 'the claimed output was never written');
  assert.equal(run.grade.stateResults.every(result => !result.passed), true);
  assert.match(run.grade.integrityResults[0].message, /written 0 times/);
});

test('saved batches validate execution completion while accepting legacy records', async () => {
  const { run } = await observe(await taskWith(), [write()]);
  const input = {
    meta: { generatedAt: 0, durationMs: 0, taskCount: 1, runsPerTask: 1 },
    runs: [run], stats: {},
  };
  const stored = parseBatchReport(JSON.parse(JSON.stringify(input)));
  assert.equal(stored.runs[0].trajectory.calls[0].executionSucceeded, true);
  run.trajectory.calls[0].executionSucceeded = 'yes';
  assert.throws(() => parseBatchReport(input), /executionSucceeded/);
  delete run.trajectory.calls[0].executionSucceeded;
  assert.equal(parseBatchReport(input).runs[0].trajectory.calls[0].executionSucceeded, undefined);
});

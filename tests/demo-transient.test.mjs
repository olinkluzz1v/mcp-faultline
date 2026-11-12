import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTask } from '../dist/cli/runner.js';
import { TempFolderSandbox } from '../dist/sandbox/temp-folder.js';
import * as scenario from '../dist/demo/scenario.js';
import * as verification from '../dist/demo/verify.js';

const { DEMO_CONTENT, DEMO_PATH, loadDemoTask } = scenario;

// Inspect real state before the runner removes it, independently of its records.
function observeFiles(t) {
  const observations = [];
  const cleanup = TempFolderSandbox.prototype.cleanup;
  t.mock.method(TempFolderSandbox.prototype, 'cleanup', async function () {
    let content;
    try {
      content = await readFile(join(this.workspacePath, DEMO_PATH), 'utf8');
    } catch (error) {
      assert.equal(error.code, 'ENOENT');
    }
    observations.push({ workspace: this.workspacePath, content });
    await cleanup.call(this);
  });
  return observations;
}

test('transient timeout: same task and visible failure, zero versus one actual write', async t => {
  const task = await loadDemoTask('transient-timeout');
  assert.equal(task.id, 'demo-transient-timeout');
  assert.deepEqual(task.fault_injection.map(({ tool, call_number, fault, mode }) => ({ tool, call_number, fault, mode })), [
    { tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'instead' },
  ]);
  const originalTask = structuredClone(task);
  const files = observeFiles(t);
  const ids = new Set();
  for (const policy of scenario.TRANSIENT_TIMEOUT_POLICIES) {
    const histories = [];
    const run = await runTask(task, async state => {
      histories.push(structuredClone(state.history));
      assert.deepEqual(Object.keys(state).sort(), ['context', 'history', 'stepIndex']);
      assert.deepEqual(Object.keys(state.context).sort(), ['forbiddenTools', 'goal', 'maxToolCalls', 'taskId', 'tools']);
      return policy.step(state);
    });
    ids.add(run.runId);
    const retries = policy.id === 'retry-once';
    assert.equal(run.trajectory.status, retries ? 'completed' : 'aborted');
    assert.equal(run.grade.passed, retries, run.grade.summary);
    assert.deepEqual(run.grade.stateResults.map(({ type, target, passed }) => ({ type, target, passed })), [
      { type: 'file_exists', target: DEMO_PATH, passed: retries },
      { type: 'file_contains', target: DEMO_PATH, passed: retries },
    ]);
    assert.ok(run.grade.policyResults.every(result => result.passed));
    assert.equal(run.grade.witness.passed, retries);
    assert.deepEqual(run.grade.integrityResults.map(({ type, target, passed }) => ({ type, target, passed })), [
      { type: 'file_written_exactly_once', target: DEMO_PATH, passed: retries },
    ]);
    assert.equal(run.grade.recovery.strategy, retries ? 'retry' : 'abort');
    assert.equal(run.grade.recovery.outcome, retries ? 'recovered' : 'failed');
    assert.deepEqual(run.injectedFaults, [
      { faultType: 'timeout', toolName: 'write_file', callNumber: 1, mode: 'instead' },
    ]);
    assert.deepEqual(run.trajectory.calls.map(call => [call.index, call.toolName, call.executed, call.executionSucceeded]),
      retries ? [[0, 'write_file', false, false], [1, 'write_file', true, true]] : [[0, 'write_file', false, false]]);
    for (const call of run.trajectory.calls) {
      assert.deepEqual(call.args, { path: DEMO_PATH, content: DEMO_CONTENT });
    }
    assert.deepEqual(histories.map(history => history.length), retries ? [0, 1, 2] : [0, 1]);
    assert.deepEqual(Object.keys(histories[1][0]).sort(), ['args', 'result', 'toolName']);
    assert.deepEqual(histories[1][0].result, { status: 'timeout', message: 'Timed out waiting for write_file response' });
    if (retries) assert.deepEqual(histories[2][1].result, {
      status: 'success', data: { written: DEMO_PATH, bytes: DEMO_CONTENT.length },
    });
    const evidence = verification.verifyTransientTimeoutRun(run, policy.id);
    assert.equal(evidence.matched, true, evidence.problems.join('\n'));
    assert.equal(evidence.completedWrites, retries ? 1 : 0);
    assert.deepEqual(task, originalTask, 'Policies share an unchanged task, permissions and grading rules');
  }
  assert.equal(ids.size, 2);
  assert.equal(new Set(files.map(file => file.workspace)).size, 2);
  assert.deepEqual(files.map(file => file.content), [undefined, DEMO_CONTENT]);
  for (const file of files) await assert.rejects(access(file.workspace), { code: 'ENOENT' });
});

test('transient policies without a fault both complete one write and pass', async t => {
  const task = await loadDemoTask('transient-timeout');
  task.fault_injection = [];
  const files = observeFiles(t);
  for (const policy of scenario.TRANSIENT_TIMEOUT_POLICIES) {
    const run = await runTask(task, policy.step);
    assert.equal(run.grade.passed, true, run.grade.summary);
    assert.equal(run.trajectory.status, 'completed');
    assert.deepEqual(run.injectedFaults, []);
    assert.equal(run.trajectory.calls.length, 1);
    assert.equal(run.trajectory.calls[0].executed, true);
    assert.equal(run.trajectory.calls[0].executionSucceeded, true);
    assert.equal(run.grade.integrityResults[0].passed, true);
    assert.ok(run.grade.stateResults.every(result => result.passed));
    assert.equal(run.grade.recovery.strategy, 'not-applicable');
    assert.equal(verification.verifyTransientTimeoutRun(run, policy.id).matched, false);
  }
  assert.deepEqual(files.map(file => file.content), [DEMO_CONTENT, DEMO_CONTENT]);
});

test('retry-once stops on a second injected timeout without executing a write', async t => {
  const task = await loadDemoTask('transient-timeout');
  task.fault_injection.push({ ...task.fault_injection[0], call_number: 2 });
  const files = observeFiles(t);
  const run = await runTask(task, scenario.TRANSIENT_TIMEOUT_POLICIES[1].step);
  assert.equal(run.trajectory.status, 'aborted');
  assert.equal(run.grade.passed, false);
  assert.equal(run.trajectory.calls.length, 2);
  assert.ok(run.trajectory.calls.every(call => call.executed === false && call.executionSucceeded === false));
  assert.deepEqual(run.injectedFaults.map(fault => fault.callNumber), [1, 2]);
  assert.deepEqual(files.map(file => file.content), [undefined]);
  assert.equal(verification.verifyTransientTimeoutRun(run, 'retry-once').matched, false);
});

test('transient policies use only visible results and abort on unexpected results or extra history', async () => {
  const entry = (result, toolName = 'write_file') => ({ toolName, args: { path: DEMO_PATH, content: DEMO_CONTENT }, result });
  const timeout = entry({ status: 'timeout', message: 'No response' });
  const success = entry({ status: 'success', data: { written: DEMO_PATH, bytes: DEMO_CONTENT.length } });
  const decide = (policy, history) => policy.step({ history, stepIndex: history.length });
  const [stop, retry] = scenario.TRANSIENT_TIMEOUT_POLICIES;
  assert.deepEqual(await decide(stop, [timeout]), { action: 'abort', reason: 'Write timed out; stopped without retrying.' });
  assert.equal((await decide(retry, [timeout])).toolName, 'write_file');
  assert.equal((await decide(retry, [timeout, success])).action, 'finish');
  assert.equal((await decide(retry, [timeout, timeout])).action, 'abort');
  assert.equal((await decide(retry, [success, success])).action, 'abort');
  assert.equal((await decide(stop, [timeout, success])).action, 'abort');
  for (const policy of [stop, retry]) {
    assert.equal((await decide(policy, [success])).action, 'finish');
    for (const result of [
      { status: 'error', message: 'Write failed' },
      { status: 'malformed', raw: null, message: 'Invalid response' },
      { status: 'policy_violation', message: 'Denied', tool: 'write_file', reason: 'Forbidden' },
      { status: 'success', data: null },
      { status: 'success', data: { written: 'wrong.txt', bytes: DEMO_CONTENT.length } },
      { status: 'success', data: { written: DEMO_PATH, bytes: 0 } },
      { status: 'success', data: { status: 'timeout' } },
    ]) {
      assert.equal((await decide(policy, [entry(result)])).action, 'abort');
      assert.equal((await decide(policy, [timeout, entry(result)])).action, 'abort');
    }
    assert.equal((await decide(policy, [entry(success.result, 'read_file')])).action, 'abort');
    assert.equal((await decide(policy, [timeout, success, success])).action, 'abort');
  }
});

test('transient verification rejects missing, contradictory or unrelated evidence', async t => {
  const task = await loadDemoTask('transient-timeout');
  for (const policy of scenario.TRANSIENT_TIMEOUT_POLICIES) {
    const original = await runTask(task, policy.step);
    const mutations = [
      ['missing provenance', run => { delete run.injectedFaults; }],
      ['no injection', run => { run.injectedFaults = []; }],
      ['after instead of instead', run => { run.injectedFaults[0].mode = 'after'; }],
      ['wrong fault', run => { run.injectedFaults[0].faultType = 'tool_error'; }],
      ['wrong tool', run => { run.injectedFaults[0].toolName = 'read_file'; }],
      ['wrong fault target', run => { run.injectedFaults[0].callNumber = 2; }],
      ['extra injection', run => { run.injectedFaults.push({ ...run.injectedFaults[0] }); }],
      ['missing execution flag', run => { delete run.trajectory.calls[0].executed; }],
      ['missing completion flag', run => { delete run.trajectory.calls[0].executionSucceeded; }],
      ['first call executed', run => { run.trajectory.calls[0].executed = true; }],
      ['first call completed', run => { run.trajectory.calls[0].executionSucceeded = true; }],
      ['wrong index', run => { run.trajectory.calls[0].index = 1; }],
      ['no calls', run => { run.trajectory.calls = []; }],
      ['duplicate record', run => { run.trajectory.calls.push({ ...run.trajectory.calls[0] }); }],
      ['wrong write contents', run => { run.trajectory.calls[0].args.content = 'wrong'; }],
      ['no visible timeout', run => { run.trajectory.calls[0].result = { status: 'error', message: 'Disk full' }; }],
      ['unexpected grade', run => { run.grade.passed = !run.grade.passed; }],
      ['missing state assertions', run => { run.grade.stateResults = []; }],
      ['wrong state target', run => { run.grade.stateResults[0].target = 'other.txt'; }],
      ['unrelated policy failure', run => { run.grade.policyResults[0].passed = false; }],
      ['missing integrity', run => { run.grade.integrityResults = []; }],
      ['incorrect integrity verdict', run => { run.grade.integrityResults[0].passed = !run.grade.integrityResults[0].passed; }],
      ['missing witness', run => { delete run.grade.witness; }],
      ['incorrect witness verdict', run => { run.grade.witness.passed = !run.grade.witness.passed; }],
      ['wrong recovery outcome', run => { run.grade.recovery.outcome = 'false-recovery'; }],
      ['harness failure', run => { run.trajectory.status = 'failed'; }],
    ];
    if (policy.id === 'stop-on-timeout') mutations.push(
      ['unrelated abort', run => { run.trajectory.error = 'Unexpected result'; }],
      ['file actually exists', run => { run.grade.stateResults[0].passed = true; }],
      ['read permission error', run => { run.grade.stateResults[1].message = 'EACCES: permission denied'; }],
      ['witness failure for another reason', run => { run.grade.witness.message = 'File did not change'; }],
      ['integrity failure for another reason', run => { run.grade.integrityResults[0].message = 'File written 2 times'; }],
    );
    else mutations.push(
      ['retry not executed', run => { run.trajectory.calls[1].executed = false; }],
      ['retry failed', run => { run.trajectory.calls[1].executionSucceeded = false; }],
      ['retry timeout', run => { run.trajectory.calls[1].result = { status: 'timeout', message: 'Still unavailable' }; }],
      ['wrong acknowledgement', run => { run.trajectory.calls[1].result.data.written = 'other.txt'; }],
      ['file missing', run => { run.grade.stateResults[0].passed = false; }],
    );
    for (const [name, mutate] of mutations) await t.test(`${policy.id}: ${name}`, () => {
      const run = structuredClone(original);
      mutate(run);
      const evidence = verification.verifyTransientTimeoutRun(run, policy.id);
      assert.equal(evidence.matched, false);
      assert.ok(evidence.problems.length > 0);
    });
  }
});

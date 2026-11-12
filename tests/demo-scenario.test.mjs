import assert from 'node:assert/strict';
import test from 'node:test';
import { runTask } from '../dist/cli/runner.js';
import { DEMO_CONTENT, DEMO_PATH, DEMO_POLICIES, loadDemoTask } from '../dist/demo/scenario.js';
import { verifyDemoRun } from '../dist/demo/verify.js';

function assertActualFile(run) {
  assert.deepEqual(run.grade.stateResults.map(({ type, target, passed }) => ({ type, target, passed })), [
    { type: 'file_exists', target: DEMO_PATH, passed: true },
    { type: 'file_contains', target: DEMO_PATH, passed: true },
  ]);
  assert.equal(run.grade.witness.type, 'state_delta');
  assert.equal(run.grade.witness.passed, true, run.grade.witness.message);
  assert.ok(run.grade.policyResults.every(result => result.passed));
  assert.equal(run.trajectory.status, 'completed');
}

test('shared after-timeout scenario: actual state, visible history and duplicate-write evidence', async () => {
  const task = await loadDemoTask();
  const originalTask = structuredClone(task);
  const ids = new Set();
  for (const policy of DEMO_POLICIES) {
    const histories = [];
    const run = await runTask(task, async state => {
      histories.push(structuredClone(state.history));
      // An agent gets neither the fault schedule nor execution/provenance fields.
      assert.deepEqual(Object.keys(state).sort(), ['context', 'history', 'stepIndex']);
      assert.deepEqual(Object.keys(state.context).sort(), ['forbiddenTools', 'goal', 'maxToolCalls', 'taskId', 'tools']);
      return policy.step(state);
    });
    ids.add(run.runId);
    const naive = policy.id === 'naive';
    assertActualFile(run); // Grader assertions read the real sandbox before cleanup.
    assert.equal(run.grade.passed, !naive);
    assert.deepEqual(run.grade.integrityResults.map(({ type, passed }) => ({ type, passed })), [
      { type: 'file_written_exactly_once', passed: !naive },
    ]);
    assert.equal(run.grade.recovery.strategy, naive ? 'retry' : 'fallback');
    assert.equal(run.grade.recovery.outcome, 'recovered');
    assert.deepEqual(run.injectedFaults, [
      { faultType: 'timeout', toolName: 'write_file', callNumber: 1, mode: 'after' },
    ]);
    assert.deepEqual(run.trajectory.calls.map(call => [call.index, call.toolName, call.executed, call.executionSucceeded]), [
      [0, 'write_file', true, true], [1, naive ? 'write_file' : 'read_file', true, true],
    ]);
    assert.deepEqual(histories.map(history => history.length), [0, 1, 2]);
    assert.deepEqual(histories[1][0].result, {
      status: 'timeout', message: 'Timed out waiting for write_file acknowledgement',
    });
    assert.deepEqual(Object.keys(histories[1][0]).sort(), ['args', 'result', 'toolName']);
    if (!naive) assert.equal(histories[2][1].result.data, DEMO_CONTENT);
    const evidence = verifyDemoRun(run, policy.id);
    assert.equal(evidence.matched, true, evidence.problems.join('\n'));
    assert.equal(evidence.completedWrites, naive ? 2 : 1);
  }
  assert.equal(ids.size, 2);
  assert.deepEqual(task, originalTask, 'Both policies must use the same unchanged task');
});

test('no-fault baseline: both policies write once and pass in fresh state', async () => {
  const task = await loadDemoTask();
  task.fault_injection = [];
  for (const policy of DEMO_POLICIES) {
    const run = await runTask(task, policy.step);
    assertActualFile(run);
    assert.equal(run.grade.passed, true, run.grade.summary);
    assert.deepEqual(run.injectedFaults, []);
    assert.equal(run.trajectory.calls.length, 1);
    const [write] = run.trajectory.calls;
    assert.equal(write.toolName, 'write_file');
    assert.equal(write.executionSucceeded, true);
    assert.deepEqual(write.args, { path: DEMO_PATH, content: DEMO_CONTENT });
    assert.equal(run.grade.integrityResults[0].passed, true);
    assert.equal(run.grade.recovery.strategy, 'not-applicable');
    assert.equal(verifyDemoRun(run, policy.id).matched, false, 'A baseline cannot verify the fault demo');
  }
});

test('policies react only to visible results and remain bounded when recovery cannot be confirmed', async () => {
  const [naive, verify] = DEMO_POLICIES;
  const entry = (toolName, result) => ({ toolName, args: { path: DEMO_PATH }, result });
  const timeout = entry('write_file', { status: 'timeout', message: 'No acknowledgement' });
  const decide = (policy, history) => policy.step({ history, stepIndex: history.length });
  assert.equal((await decide(naive, [timeout])).toolName, 'write_file');
  assert.equal((await decide(naive, [timeout, timeout])).action, 'abort');
  assert.equal((await decide(verify, [timeout])).toolName, 'read_file');
  for (const result of [
    { status: 'success', data: 'wrong content' },
    { status: 'success', data: `${DEMO_CONTENT} with extra content` },
    { status: 'error', message: 'File missing' },
    { status: 'timeout', message: 'Read timed out' },
  ]) {
    assert.equal((await decide(verify, [timeout, entry('read_file', result)])).action, 'abort');
  }
  for (const policy of DEMO_POLICIES) {
    for (const result of [
      { status: 'error', message: 'Write failed' },
      { status: 'malformed', raw: null, message: 'Invalid response' },
      { status: 'policy_violation', message: 'Denied', tool: 'write_file', reason: 'Forbidden' },
    ]) assert.equal((await decide(policy, [entry('write_file', result)])).action, 'abort');
    assert.equal((await decide(policy, [entry('write_file', { status: 'success', data: { status: 'timeout' } })])).action, 'finish');
  }
});

test('demo verification rejects missing evidence, unrelated failures and unexpected grades', async t => {
  const task = await loadDemoTask();
  const original = await runTask(task, DEMO_POLICIES[0].step);
  const mutations = [
    ['missing injection provenance', run => { delete run.injectedFaults; }],
    ['zero injections', run => { run.injectedFaults = []; }],
    ['wrong fault mode', run => { run.injectedFaults[0].mode = 'instead'; }],
    ['wrong fault type', run => { run.injectedFaults[0].faultType = 'tool_error'; }],
    ['wrong injection call', run => { run.injectedFaults[0].callNumber = 2; }],
    ['extra injection', run => { run.injectedFaults.push({ ...run.injectedFaults[0] }); }],
    ['missing completion evidence', run => { delete run.trajectory.calls[0].executionSucceeded; }],
    ['failed real write', run => { run.trajectory.calls[0].executionSucceeded = false; }],
    ['short-circuited write', run => { run.trajectory.calls[0].executed = false; }],
    ['duplicate call record', run => { run.trajectory.calls.push({ ...run.trajectory.calls[1] }); }],
    ['wrong call index', run => { run.trajectory.calls[1].index = 0; }],
    ['wrong content', run => { run.trajectory.calls[1].args.content = 'wrong'; }],
    ['unrelated retry error', run => { run.trajectory.calls[1].result = { status: 'error', message: 'Disk full' }; }],
    ['no visible timeout', run => { run.trajectory.calls[0].result = { status: 'success', data: null }; }],
    ['unexpected pass', run => { run.grade.passed = true; }],
    ['missing integrity assertion', run => { run.grade.integrityResults = []; }],
    ['passing integrity despite FAIL', run => { run.grade.integrityResults[0].passed = true; }],
    ['unrelated state failure', run => { run.grade.stateResults[0].passed = false; }],
    ['missing state assertions', run => { run.grade.stateResults = []; }],
    ['unrelated policy failure', run => { run.grade.policyResults[0].passed = false; }],
    ['missing witness', run => { delete run.grade.witness; }],
    ['unchanged actual file', run => { run.grade.witness.passed = false; }],
    ['wrong recovery', run => { run.grade.recovery.outcome = 'failed'; }],
    ['aborted agent', run => { run.trajectory.status = 'aborted'; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const run = structuredClone(original);
      mutate(run);
      const evidence = verifyDemoRun(run, 'naive');
      assert.equal(evidence.matched, false);
      assert.ok(evidence.problems.length > 0);
    });
  }
  const verified = await runTask(task, DEMO_POLICIES[1].step);
  verified.trajectory.calls[1].result.data = 'wrong content';
  assert.equal(verifyDemoRun(verified, 'verify-before-retry').matched, false);
  verified.trajectory.calls[1].result.data = DEMO_CONTENT;
  verified.grade.passed = false;
  assert.equal(verifyDemoRun(verified, 'verify-before-retry').matched, false);
});

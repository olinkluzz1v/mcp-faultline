import assert from 'node:assert/strict';
import test from 'node:test';
import { computeStats } from '../dist/report/stats.js';
import { runTask } from '../dist/cli/runner.js';
import { loadTask } from '../dist/task/loader.js';
import { injection, run, legacyRun } from './report-fixtures.mjs';

test('fault rates count each exposed run once, while counting every injection', () => {
  const runs = [
    run(true, [injection('timeout'), injection('timeout', 2)]),
    run(false, [injection('timeout'), injection('malformed_response', 2)]),
    run(true, [injection('malformed_response')], 'other'),
    run(true), run(false), legacyRun(),
  ];
  const before = structuredClone(runs);
  const stats = computeStats(runs);
  assert.deepEqual(stats.byFault, {
    malformed_response: { injections: 2, total: 2, passed: 1, failed: 1, rate: 0.5 },
    timeout: { injections: 3, total: 2, passed: 1, failed: 1, rate: 0.5 },
  });
  assert.deepEqual(stats.withoutFault, { total: 2, passed: 1, failed: 1, rate: 0.5 });
  assert.equal(stats.unknownFaultRuns, 1);
  assert.equal(stats.total, 6);
  assert.equal(stats.passed, 4);
  assert.equal(stats.failed, 2);
  assert.equal(stats.passRate, 4 / 6);
  assert.equal(stats.byTask.example.rate, 3 / 5);
  assert.deepEqual(runs, before, 'aggregation must not mutate evidence');
});

test('fault rates use their own denominators and remain independent of input order', () => {
  const runs = [run(true, [injection('timeout')]), run(false, [injection('timeout')]),
    run(false, [injection('timeout')]), run(true, [injection('empty')]), run(false)];
  const stats = computeStats(runs);
  assert.deepEqual(stats.byFault, {
    empty: { injections: 1, total: 1, passed: 1, failed: 0, rate: 1 },
    timeout: { injections: 3, total: 3, passed: 1, failed: 2, rate: 1 / 3 },
  });
  assert.deepEqual(computeStats([...runs].reverse()).byFault, stats.byFault);
});

test('empty, fault-free and legacy batches have no invented fault observations', () => {
  for (const runs of [[], [run(true), run(false)], [legacyRun()]]) {
    const stats = computeStats(runs);
    assert.deepEqual(stats.byFault, {});
    assert.equal(stats.unknownFaultRuns, runs.length === 1 ? 1 : 0);
    assert.deepEqual(stats.withoutFault, runs.length === 2
      ? { total: 2, passed: 1, failed: 1, rate: 0.5 }
      : { total: 0, passed: 0, failed: 0, rate: 0 });
    assert.ok(Number.isFinite(stats.passRate));
  }
});

const finish = async () => ({ action: 'finish', message: 'Stopped.' });
const callOnce = (toolName, args) => async ({ stepIndex }) => stepIndex === 0
  ? { action: 'call', toolName, args } : finish();

test('runner records the applied fault type even when its result status is success', async () => {
  const task = await loadTask('tasks/error-recovery.yaml');
  task.fault_injection[0].fault = 'empty';
  const result = await runTask(task, callOnce('read_file', { path: 'config.json' }));
  assert.deepEqual(result.injectedFaults, [injection('empty')]);
  assert.equal(result.trajectory.calls[0].result.status, 'success');
  assert.equal(computeStats([result]).byFault.empty.total, 1);
});

test('runner excludes untriggered plans and policy denials', async () => {
  const task = await loadTask('tasks/error-recovery.yaml');
  assert.deepEqual((await runTask(task, finish)).injectedFaults, []);
  task.fault_injection[0].call_number = 2;
  assert.deepEqual((await runTask(task, callOnce('read_file', { path: 'config.json' }))).injectedFaults, []);
  task.fault_injection[0] = { tool: 'write_file', call_number: 1, fault: 'timeout', mode: 'instead' };
  const denied = await runTask(task, callOnce('write_file', { path: 'out.txt', content: 'no' }));
  assert.equal(denied.trajectory.calls[0].result.status, 'policy_violation');
  assert.deepEqual(denied.injectedFaults, []);
});

test('after-mode records exactly one call and one injection after real execution', async () => {
  const task = await loadTask('tasks/integrity-only/idempotency-test-001.yaml');
  const result = await runTask(task, callOnce('write_file', { path: 'output.txt', content: 'hello idempotency' }));
  assert.deepEqual(result.injectedFaults, [injection('timeout', 1, 'after', 'write_file')]);
  assert.equal(result.trajectory.calls.length, 1);
  assert.deepEqual(result.trajectory.calls.map(c => c.index), [0]);
  assert.equal(result.trajectory.calls.filter(c => c.executed).length, 1);
  assert.equal(computeStats([result]).byFault.timeout.injections, 1);
});

test('failed real execution prevents after-mode injection and natural errors are not faults', async () => {
  const task = await loadTask('tasks/error-recovery.yaml');
  task.fault_injection[0].mode = 'after';
  const result = await runTask(task, callOnce('read_file', { path: 'missing.json' }));
  assert.equal(result.trajectory.calls[0].result.status, 'error');
  assert.deepEqual(result.injectedFaults, []);
  assert.equal(computeStats([result]).withoutFault.total, 1);
});

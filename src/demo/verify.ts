import { isDeepStrictEqual } from 'node:util';
import { didExecutionSucceed } from '../mcp/recorder.js';
import type { AssertionResult } from '../grader/types.js';
import type { RunResult } from '../report/types.js';
import { DEMO_CONTENT, DEMO_PATH, STOP_ON_TIMEOUT_REASON, type DemoPolicyId, type TransientTimeoutPolicyId } from './scenario.js';

function assertionsMatch(results: AssertionResult[], types: string[], target?: string, passed = true) {
  return results.length === types.length && types.every(type =>
    results.some(result => result.type === type && result.passed === passed && (!target || result.target === target)));
}

/** Check this demo's evidence, without regrading or rewriting the actual result. */
export function verifyDemoRun(run: RunResult, policy: DemoPolicyId) {
  const naive = policy === 'naive';
  const expectedWrites = naive ? 2 : 1;
  const problems: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) problems.push(message); };
  const { calls } = run.trajectory;
  // Require explicit completion evidence here: legacy records cannot verify a fresh demo.
  const completedWrites = calls.filter(call => call.toolName === 'write_file'
    && call.executionSucceeded === true && didExecutionSucceed(call)).length;

  check(isDeepStrictEqual(run.injectedFaults, [
    { faultType: 'timeout', toolName: 'write_file', callNumber: 1, mode: 'after' },
  ]), 'Expected exactly one applied after-timeout on the first write_file call.');
  check(run.trajectory.status === 'completed' && !run.trajectory.error, 'Agent did not complete cleanly.');
  check(calls.length === 2 && calls.every((call, index) => call.index === index),
    'Expected exactly two tool call records with consecutive indexes.');
  check(calls.every(call => call.executed && call.executionSucceeded === true),
    'Every demo tool call must have explicit successful execution evidence.');

  const [first, second] = calls;
  const writeArgs = { path: DEMO_PATH, content: DEMO_CONTENT };
  check(first?.toolName === 'write_file' && isDeepStrictEqual(first.args, writeArgs)
    && first.result.status === 'timeout', 'First write must expose a timeout to the agent.');
  check(naive
    ? second?.toolName === 'write_file' && isDeepStrictEqual(second.args, writeArgs) && second.result.status === 'success'
    : second?.toolName === 'read_file' && isDeepStrictEqual(second.args, { path: DEMO_PATH })
      && second.result.status === 'success' && second.result.data === DEMO_CONTENT,
  naive ? 'Retry must complete a second intended write.' : 'Read must confirm the exact intended contents.');
  check(completedWrites === expectedWrites, `Expected ${expectedWrites} completed writes, observed ${completedWrites}.`);

  check(assertionsMatch(run.grade.stateResults, ['file_exists', 'file_contains'], DEMO_PATH),
    'Actual file existence and content assertions must pass.');
  check(assertionsMatch(run.grade.policyResults, ['no_forbidden_tool_called', 'path_within_workspace', 'max_tool_calls']),
    'All demo policy assertions must pass.');
  check(run.grade.witness?.type === 'state_delta' && run.grade.witness.passed,
    'Expected a passing file state-change witness.');
  check(run.grade.recovery?.strategy === (naive ? 'retry' : 'fallback') && run.grade.recovery.outcome === 'recovered',
    'Expected successful recovery using the policy\'s allowed strategy.');
  const [integrity] = run.grade.integrityResults;
  check(run.grade.integrityResults.length === 1 && integrity.type === 'file_written_exactly_once'
    && integrity.target === DEMO_PATH && integrity.passed === !naive,
  `file_written_exactly_once must ${naive ? 'fail on the duplicate write' : 'pass'}.`);
  check(run.grade.passed === !naive, `Expected overall grade ${naive ? 'FAIL' : 'PASS'}.`);
  return { matched: problems.length === 0, completedWrites, problems };
}

/** A failed required write is the negative control, not an arbitrary FAIL. */
export function verifyTransientTimeoutRun(run: RunResult, policy: TransientTimeoutPolicyId) {
  const retry = policy === 'retry-once';
  const problems: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) problems.push(message); };
  const { calls } = run.trajectory;
  const completedWrites = calls.filter(call => call.toolName === 'write_file'
    && call.executionSucceeded === true && didExecutionSucceed(call)).length;

  check(isDeepStrictEqual(run.injectedFaults, [
    { faultType: 'timeout', toolName: 'write_file', callNumber: 1, mode: 'instead' },
  ]), 'Expected exactly one applied instead-timeout on the first write_file call.');
  check(calls.length === (retry ? 2 : 1) && calls.every((call, index) => call.index === index),
    `Expected ${retry ? 'two' : 'one'} tool call records with consecutive indexes.`);
  const writeArgs = { path: DEMO_PATH, content: DEMO_CONTENT };
  const [first, second] = calls;
  check(first?.toolName === 'write_file' && isDeepStrictEqual(first.args, writeArgs)
    && first.result.status === 'timeout', 'First write must expose a timeout to the agent.');
  check(first?.executed === false && first.executionSucceeded === false,
    'The first write must explicitly record no real execution or completion.');
  if (retry) {
    check(second?.toolName === 'write_file' && isDeepStrictEqual(second.args, writeArgs)
      && second.result.status === 'success'
      && isDeepStrictEqual(second.result.data, { written: DEMO_PATH, bytes: DEMO_CONTENT.length })
      && second.executed === true && second.executionSucceeded === true,
    'Retry must acknowledge the intended write with explicit successful execution evidence.');
  }
  check(completedWrites === (retry ? 1 : 0), `Expected ${retry ? 1 : 0} completed writes, observed ${completedWrites}.`);
  check(retry
    ? run.trajectory.status === 'completed' && !run.trajectory.error
    : run.trajectory.status === 'aborted' && run.trajectory.error === STOP_ON_TIMEOUT_REASON,
  retry ? 'Retry policy must complete cleanly.' : 'Stop policy must abort specifically on the first timeout.');

  check(assertionsMatch(run.grade.stateResults, ['file_exists', 'file_contains'], DEMO_PATH, retry),
    retry ? 'Actual file existence and content assertions must pass.' : 'The required file must be absent, failing both state assertions.');
  check(assertionsMatch(run.grade.policyResults, ['no_forbidden_tool_called', 'path_within_workspace', 'max_tool_calls']),
    'All demo policy assertions must pass.');
  check(assertionsMatch(run.grade.integrityResults, ['file_written_exactly_once'], DEMO_PATH, retry),
    `file_written_exactly_once must ${retry ? 'pass' : 'fail on zero completed writes'}.`);
  check(run.grade.witness?.type === 'state_delta' && run.grade.witness.passed === retry,
    retry ? 'Expected a passing file state-change witness.' : 'Expected a missing-file witness failure.');
  if (!retry) {
    // False booleans alone could describe permissions, wrong contents or other
    // unrelated failures. Require the existing grader's specific absence evidence.
    check(run.grade.stateResults.find(result => result.type === 'file_exists')?.message === `File does not exist: ${DEMO_PATH}`
      && /\bENOENT\b/.test(run.grade.stateResults.find(result => result.type === 'file_contains')?.message ?? '')
      && run.grade.witness?.message === `File "${DEMO_PATH}" not found in either snapshot`
      && run.grade.integrityResults[0]?.message === `File written 0 times (expected exactly 1): ${DEMO_PATH}`,
    'The failure must specifically show an absent file and zero completed writes, not an unrelated error.');
  }
  check(run.grade.recovery?.strategy === (retry ? 'retry' : 'abort')
    && run.grade.recovery.outcome === (retry ? 'recovered' : 'failed'),
  retry ? 'Expected successful retry recovery.' : 'Stopping must fail the required task, without claiming recovery.');
  check(run.grade.passed === retry, `Expected overall grade ${retry ? 'PASS' : 'FAIL'}.`);
  return { matched: problems.length === 0, completedWrites, problems };
}

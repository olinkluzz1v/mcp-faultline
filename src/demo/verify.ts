import { isDeepStrictEqual } from 'node:util';
import { didExecutionSucceed } from '../mcp/recorder.js';
import type { AssertionResult } from '../grader/types.js';
import type { RunResult } from '../report/types.js';
import { DEMO_CONTENT, DEMO_PATH, type DemoPolicyId } from './scenario.js';

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

  const assertionsMatch = (results: AssertionResult[], types: string[], target?: string) =>
    results.length === types.length && types.every(type =>
      results.some(result => result.type === type && result.passed && (!target || result.target === target)));
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

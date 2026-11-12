export function injection(faultType, callNumber = 1, mode = 'instead', toolName = 'read_file') {
  return { faultType, toolName, callNumber, mode };
}

export function run(passed, injectedFaults = [], taskId = 'example') {
  return {
    runId: 'example-run', taskId, taskName: 'Example task', durationMs: 10,
    injectedFaults,
    trajectory: {
      runId: 'example-run', taskId, startedAt: 0, endedAt: 10,
      calls: [], events: [], status: 'completed',
    },
    grade: {
      passed, summary: passed ? 'PASS' : 'FAIL: state assertion failed',
      stateResults: [], policyResults: [], integrityResults: [],
      efficiency: { toolCalls: 0, retries: 0, fallbackDepth: 0, duplicateActions: 0, durationMs: 10 },
    },
  };
}

export function legacyRun() {
  const result = run(true);
  delete result.injectedFaults;
  return result;
}

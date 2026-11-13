import { mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEMO_POLICIES, TRANSIENT_TIMEOUT_POLICIES, loadDemoTask, type DemoScenario } from '../demo/scenario.js';
import { verifyDemoRun, verifyTransientTimeoutRun } from '../demo/verify.js';
import { computeStats } from '../report/stats.js';
import { writeJson } from '../report/json.js';
import { writeMarkdown } from '../report/markdown.js';
import { writeHtml } from '../report/html.js';
import type { BatchReport } from '../report/types.js';
import { runTask } from './runner.js';

/** Demo-only exit contract: verified expectations / mismatch / harness or output failure. */
export async function runDemoCommand(opts: { out: string; scenario?: DemoScenario }): Promise<0 | 1 | 2> {
  const out = resolve(opts.out);
  let ownsOutput = false;
  let phase = 'configuration';
  let finished = false;
  let interrupted = false;
  let exitCode: 0 | 1 | 2 = 2;
  const markInterrupted = () => { interrupted = true; };
  const checkInterrupted = () => {
    if (interrupted) throw new Error('Interrupted before the demonstration completed.');
  };
  const discardIncompleteOutput = () => {
    if (!ownsOutput) return;
    try {
      rmSync(out, { recursive: true, force: true });
      ownsOutput = false;
    } catch (error) {
      console.error(`Could not remove incomplete demo output at ${out}: ${String(error)}`);
    }
  };
  // Shared signal cleanup may outlive this action. The demo retains its own
  // 0/1/2 contract and removes incomplete output, including on interruption.
  // Exit listeners cannot await work, so this guard uses synchronous cleanup.
  const onExit = (code: number) => {
    if (!finished || interrupted) {
      process.exitCode = 2;
      if (!finished) console.error('Demo harness error: process stopped before verification and reporting completed.');
      discardIncompleteOutput();
    } else if (code === 0) {
      process.exitCode = exitCode;
    }
  };
  process.once('exit', onExit);
  process.prependListener('SIGINT', markInterrupted);
  process.prependListener('SIGTERM', markInterrupted);
  try {
    const task = await loadDemoTask(opts.scenario);
    const transient = opts.scenario === 'transient-timeout';
    checkInterrupted();
    await mkdir(dirname(out), { recursive: true });
    try {
      await mkdir(out); // Exclusive reservation: never reuse an existing report directory.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Output already exists: ${out}. Choose a fresh directory.`);
      }
      throw error;
    }
    ownsOutput = true;
    checkInterrupted();
    console.log('Scripted local filesystem demo — no API key or real LLM required.');
    if (transient) {
      console.log('Scenario: the first write is not executed; an instead fault returns a synthetic timeout.');
      console.log('Stop on timeout leaves the required file missing; retry once can complete the write.');
    } else {
      console.log('Scenario: the first write completes, but its acknowledgement is replaced with a timeout.');
      console.log('Naive retry repeats the write; verify before retry reads the file to check its contents.');
    }
    console.log('Both use the same fault plan, permissions and grading rules, in fresh isolated workspaces.');

    let matched = true;
    const summaries: string[] = [];
    for (const policy of transient ? TRANSIENT_TIMEOUT_POLICIES : DEMO_POLICIES) {
      phase = `harness (${policy.label})`;
      const run = await runTask(task, policy.step);
      checkInterrupted();
      if (run.trajectory.status === 'failed') {
        throw new Error(run.trajectory.error ?? 'Agent execution failed.');
      }
      const evidence = policy.id === 'stop-on-timeout' || policy.id === 'retry-once'
        ? verifyTransientTimeoutRun(run, policy.id) : verifyDemoRun(run, policy.id);
      matched &&= evidence.matched;
      const expectedPass = policy.id === 'verify-before-retry' || policy.id === 'retry-once';
      const report: BatchReport = {
        meta: { generatedAt: Date.now(), durationMs: run.durationMs, taskCount: 1, runsPerTask: 1 },
        stats: computeStats([run]),
        runs: [run],
      };
      phase = `report writing (${policy.label})`;
      const directory = join(out, policy.id);
      await mkdir(directory);
      const paths = ['report.json', 'report.md', 'report.html'].map(name => join(directory, name));
      await writeJson(report, paths[0]);
      await writeMarkdown(report, paths[1]);
      await writeHtml(report, paths[2], {
        scenario: transient ? 'Transient timeout' : 'Lost acknowledgement',
        policy: policy.label,
        expectedPassed: expectedPass,
        verification: evidence,
        negativeControl: policy.id === 'naive'
          ? 'Retrying after a lost acknowledgement should complete two writes. The duplicate write must fail file_written_exactly_once.'
          : policy.id === 'stop-on-timeout'
            ? 'Stopping after the prevented write should leave receipt.txt missing, with zero completed writes. The missing file must fail the required task.'
            : undefined,
      });
      checkInterrupted();
      const expectedWrites = policy.id === 'naive' ? 2 : policy.id === 'stop-on-timeout' ? 0 : 1;
      summaries.push([
        `\n${policy.label}`,
        `  Expected grade: ${expectedPass ? 'PASS' : 'FAIL'}; completed writes: ${expectedWrites}`,
        `  Actual grade: ${run.grade.passed ? 'PASS' : 'FAIL'}; completed writes: ${evidence.completedWrites}`,
        `  Applied injections: ${JSON.stringify(run.injectedFaults ?? 'unknown')}`,
        ...[...run.grade.stateResults, ...run.grade.integrityResults].map(result =>
          `  ${result.type}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.message ?? result.target}`),
        `  Demo expectation: ${evidence.matched ? 'MATCH' : 'MISMATCH'}`,
        ...evidence.problems.map(problem => `  - ${problem}`),
        ...paths.map(path => `  Report: ${path}`),
      ].join('\n'));
    }
    console.log(summaries.join('\n'));
    console.log(matched
      ? transient
        ? '\nDemo verified both expected outcomes. The stop-on-timeout agent remains FAIL; retry-once is PASS.'
        : '\nDemo verified both expected outcomes. The naive agent remains FAIL; verify-before-retry is PASS.'
      : '\nDemo expectation mismatch. Inspect the reports; the demonstration was not verified.');
    exitCode = matched ? 0 : 1;
    return exitCode;
  } catch (error) {
    console.error(`Demo ${phase} error: ${error instanceof Error ? error.message : String(error)}`);
    discardIncompleteOutput();
    return 2;
  } finally {
    finished = true;
    process.off('SIGINT', markInterrupted);
    process.off('SIGTERM', markInterrupted);
  }
}

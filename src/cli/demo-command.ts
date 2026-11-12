import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEMO_POLICIES, loadDemoTask } from '../demo/scenario.js';
import { verifyDemoRun } from '../demo/verify.js';
import { computeStats } from '../report/stats.js';
import { writeJson } from '../report/json.js';
import { writeMarkdown } from '../report/markdown.js';
import { writeHtml } from '../report/html.js';
import type { BatchReport } from '../report/types.js';
import { runTask } from './runner.js';

/** Demo-only exit contract: verified expectations / mismatch / harness or output failure. */
export async function runDemoCommand(opts: { out: string }): Promise<0 | 1 | 2> {
  const out = resolve(opts.out);
  let ownsOutput = false;
  let phase = 'configuration';
  try {
    const task = await loadDemoTask();
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
    console.log('Scripted local filesystem demo — no API key or real LLM required.');
    console.log('Scenario: the first write completes, but its acknowledgement is replaced with a timeout.');
    console.log('Naive retry repeats the write; verify before retry reads the file to check its contents.');
    console.log('Both use the same fault plan, permissions and grading rules, in fresh isolated workspaces.');

    let matched = true;
    const summaries: string[] = [];
    for (const policy of DEMO_POLICIES) {
      phase = `harness (${policy.label})`;
      const run = await runTask(task, policy.step);
      if (run.trajectory.status === 'failed') {
        throw new Error(run.trajectory.error ?? 'Agent execution failed.');
      }
      const evidence = verifyDemoRun(run, policy.id);
      matched &&= evidence.matched;
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
      await writeHtml(report, paths[2]);
      summaries.push([
        `\n${policy.label}`,
        `  Expected grade: ${policy.id === 'naive' ? 'FAIL; completed writes: 2' : 'PASS; completed writes: 1'}`,
        `  Actual grade: ${run.grade.passed ? 'PASS' : 'FAIL'}; completed writes: ${evidence.completedWrites}`,
        `  Applied injections: ${JSON.stringify(run.injectedFaults ?? 'unknown')}`,
        ...run.grade.integrityResults.map(result => `  ${result.type}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.message ?? result.target}`),
        `  Demo expectation: ${evidence.matched ? 'MATCH' : 'MISMATCH'}`,
        ...evidence.problems.map(problem => `  - ${problem}`),
        ...paths.map(path => `  Report: ${path}`),
      ].join('\n'));
    }
    console.log(summaries.join('\n'));
    console.log(matched
      ? '\nDemo verified both expected outcomes. The naive agent remains FAIL; verify-before-retry is PASS.'
      : '\nDemo expectation mismatch. Inspect the reports; the demonstration was not verified.');
    return matched ? 0 : 1;
  } catch (error) {
    console.error(`Demo ${phase} error: ${error instanceof Error ? error.message : String(error)}`);
    if (ownsOutput) {
      try {
        await rm(out, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Could not remove incomplete demo output at ${out}: ${String(cleanupError)}`);
      }
    }
    return 2;
  }
}

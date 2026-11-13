import { writeFile } from 'node:fs/promises';
import type { BatchReport, RunResult } from './types.js';
import { escapeHtml, reportStyles } from './presentation.js';
import { computeFaultStats, formatCI, formatPercent } from './stats.js';

/** Presentation-only context for one demo run; never stored in BatchReport JSON. */
export interface DemoHtmlContext {
  scenario: string;
  policy: string;
  expectedPassed: boolean;
  negativeControl?: string;
  /** The existing demo verifier's result, not an expected/actual grade comparison. */
  verification: { matched: boolean; problems: readonly string[] };
}

function demoContext(run: RunResult, context: DemoHtmlContext): string {
  const e = escapeHtml;
  const { matched, problems } = context.verification;
  return `<section id="demo-context" class="demo-context" aria-labelledby="demo-title">
    <h2 id="demo-title">Scripted local filesystem demo</h2>
    <p>These are bounded scripted policies, not evidence of real model behavior.</p>
    <dl class="demo-facts">
      <div><dt>Scenario</dt><dd>${e(context.scenario)}</dd></div>
      <div><dt>Policy</dt><dd>${e(context.policy)}</dd></div>
      <div><dt>Expected grade</dt><dd>${context.expectedPassed ? 'PASS' : 'FAIL'}</dd></div>
      <div><dt>Actual grade</dt><dd class="${run.grade.passed ? 'pass' : 'fail'}">${run.grade.passed ? 'PASS' : 'FAIL'}</dd></div>
    </dl>
    <p><strong class="${matched ? 'pass' : 'fail'}">Evidence verification: ${matched ? 'VERIFIED' : 'NOT VERIFIED'}</strong><br>
      ${matched ? 'The expected outcome and required evidence were verified for this policy.' : 'The expected outcome or required evidence did not match. This policy\'s demonstration was not verified.'}</p>
    ${context.negativeControl ? `<p><strong>Expected negative control:</strong> ${e(context.negativeControl)}</p>
      <p>Verifying an expected FAIL confirms the demonstration, not successful task completion. The actual grade is unchanged.</p>` : ''}
    ${problems.length ? `<p>Verification issues:</p><ul>${problems.map(problem => `<li>${e(problem)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function runDetails(run: RunResult): string {
  const e = escapeHtml;
  const recovery = run.grade.recovery;
  const efficiency = run.grade.efficiency;
  const faults = run.injectedFaults === undefined
    ? '<p>Fault provenance unavailable for this run.</p>'
    : run.injectedFaults.length === 0
      ? '<p>No faults injected.</p>'
      : `<ul>${run.injectedFaults.map(f => `<li><code>${e(f.faultType)}</code> on
          <code>${e(f.toolName)}</code>, call ${e(f.callNumber)} (${e(f.mode)})</li>`).join('')}</ul>`;
  const failedAssertions = [
    ...run.grade.stateResults, ...run.grade.policyResults, ...run.grade.integrityResults,
  ].filter(assertion => !assertion.passed);

  return `<details>
    <summary><span class="status ${run.grade.passed ? 'pass' : 'fail'}">${run.grade.passed ? 'PASS' : 'FAIL'}</span>
      <span class="run-name"><code>${e(run.taskId)}</code> — ${e(run.taskName)}</span>
      <span class="muted">${e(run.durationMs)} ms</span></summary>
    <div class="run-body">
      <p><strong>${e(run.grade.summary)}</strong></p>
      <p class="muted">Run <code>${e(run.runId)}</code> · Status: ${e(run.trajectory.status)}</p>
      ${recovery ? `<p>Recovery: <strong>${e(recovery.strategy)} → ${e(recovery.outcome)}</strong>${recovery.reasoning ? `<br>${e(recovery.reasoning)}` : ''}</p>` : ''}
      ${failedAssertions.length ? `<ul>${failedAssertions.map(a => `<li>${e(a.type)}: ${e(a.target)}${a.message ? ` — ${e(a.message)}` : ''}</li>`).join('')}</ul>` : ''}
      <p>${e(efficiency.toolCalls)} tool calls · ${e(efficiency.retries)} retries · ${e(efficiency.duplicateActions)} duplicate actions</p>
      <h3>Applied injections</h3>${faults}
    </div>
  </details>`;
}

/** Standalone report: inline styles, native disclosures, no JavaScript or assets. */
export function toHtml(report: BatchReport, demo?: DemoHtmlContext): string {
  const { meta, stats, runs } = report;
  if (demo && runs.length !== 1) throw new Error('Demo HTML context requires exactly one run.');
  const e = escapeHtml;
  // Reports created before fault provenance was added can still be rendered.
  const faults = stats.byFault === undefined ? computeFaultStats(runs) : stats;
  const faultRows = Object.entries(faults.byFault).map(([type, f]) => `<tr>
    <th scope="row">${e(type)}</th><td>${e(f.injections)}</td><td>${e(f.total)}</td>
    <td>${e(f.passed)}</td><td>${e(f.failed)}</td><td class="rate">${e(formatPercent(f.rate))}</td>
  </tr>`).join('');
  const taskRows = Object.entries(stats.byTask).map(([id, task]) => `<tr>
    <th scope="row">${e(id)}</th><td>${e(task.passed)}</td><td>${e(task.total)}</td>
    <td class="rate">${e(formatPercent(task.rate))}</td>
  </tr>`).join('');
  const baseline = faults.withoutFault;
  const generatedAt = new Date(meta.generatedAt).toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>MCP-Faultline — Evaluation report</title>
  <style>
${reportStyles}
  </style>
</head>
<body>
<main>
  <header>
    <p class="brand">MCP-FAULTLINE / EVALUATION REPORT</p>
    <h1>Resilience under fault</h1>
    <p class="muted">Generated <time datetime="${e(generatedAt)}">${e(generatedAt)}</time> · ${e((meta.durationMs / 1000).toFixed(2))} s · ${e(meta.taskCount)} tasks</p>
    <nav aria-label="Report sections"><a href="#faults">Fault types</a><a href="#tasks">Tasks</a><a href="#runs">Run details</a></nav>
  </header>

  ${demo ? demoContext(runs[0], demo) : ''}
  <section aria-label="Overall results" class="overview">
    <p class="verdict"><strong>${e(stats.passed)} / ${e(stats.total)}</strong> runs passed</p>
    <p><strong>${stats.total ? e(formatPercent(stats.passRate)) : 'N/A'}</strong> pass rate<br><span class="muted">${e(stats.failed)} failed</span></p>
    <p><strong>${stats.total ? e(formatCI(stats.confidenceInterval)) : 'N/A'}</strong><br><span class="muted">95% Wilson interval · unit: run</span></p>
  </section>
  ${runs.length === 0 ? '<p>No runs recorded. Run a task suite to collect results.</p>' : ''}

  <section id="faults" aria-labelledby="faults-title">
    <h2 id="faults-title">Results by injected fault type</h2>
    <p>How often did a run pass after being exposed to each type of fault?</p>
    ${faultRows || taskRows ? '<p class="scroll-hint">Scroll tables horizontally to see all columns.</p>' : ''}
    ${faultRows ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Fault statistics table">
      <table><caption>Observed injections only · pass rate = passed runs / exposed runs</caption>
      <thead><tr><th scope="col">Fault type</th><th scope="col">Injections</th><th scope="col">Runs</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Pass rate</th></tr></thead>
      <tbody>${faultRows}</tbody></table></div>` : '<p>No recorded fault injections.</p>'}
    <div class="note">
      <p>Repeated injections count separately, but a run counts only once per type. With multiple fault types, groups overlap; their totals must not be summed. These are whole-run outcomes, not proof that a specific fault caused a failure.</p>
      <p>Known runs without injections: ${e(baseline.total)} (${e(baseline.passed)} passed, ${e(baseline.failed)} failed; ${baseline.total ? e(formatPercent(baseline.rate)) : 'N/A'} pass rate).</p>
      <p>Unknown fault provenance: ${e(faults.unknownFaultRuns)} run(s). These runs are excluded from the fault and no-injection groups.</p>
    </div>
  </section>

  <section id="tasks" aria-labelledby="tasks-title">
    <h2 id="tasks-title">Task results</h2>
    <p>${e(stats.taskLevel.scenarios)} scenarios · ${e(stats.taskLevel.passed)} passed every run · ${stats.taskLevel.scenarios ? e(formatPercent(stats.taskLevel.macroPassRate)) : 'N/A'} macro pass rate</p>
    ${taskRows ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Task results table">
      <table><caption>Each task has equal weight in the macro pass rate</caption>
      <thead><tr><th scope="col">Task</th><th scope="col">Passed</th><th scope="col">Runs</th><th scope="col">Pass rate</th></tr></thead>
      <tbody>${taskRows}</tbody></table></div>` : '<p>No task observations available.</p>'}
    <div class="note"><p>Repeated deterministic runs are not independent samples. The run-level interval can overstate precision; compare task-level results and sample sizes.</p>
      ${stats.dataQuality.warnings.length ? `<ul>${stats.dataQuality.warnings.map(w => `<li>${e(w)}</li>`).join('')}</ul>` : ''}</div>
  </section>

  <section id="runs" aria-labelledby="runs-title">
    <h2 id="runs-title">Run details</h2>
    <p class="muted">Open a run for its grade, recovery and applied injections.</p>
    ${runs.map(runDetails).join('\n')}
  </section>

  <footer>
    <p>Original MCP-Faultline by <strong>Gigih Susetyo</strong> · Copyright © 2026 Gigih Susetyo · MIT License.<br>
    Upstream: <a href="https://github.com/gigihsusetyo/mcp-faultline">gigihsusetyo/mcp-faultline</a>.<br>
    Fault statistics and offline HTML report additions: <a href="https://github.com/olinkluzz1v/mcp-faultline">olinkluzz1v/mcp-faultline</a>.</p>
    <p class="muted">Self-contained report. No scripts, external assets or network connection required.</p>
  </footer>
</main>
</body>
</html>`;
}

export async function writeHtml(report: BatchReport, filePath: string, demo?: DemoHtmlContext): Promise<void> {
  await writeFile(filePath, toHtml(report, demo), 'utf-8');
}

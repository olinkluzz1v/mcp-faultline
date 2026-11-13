import { escapeHtml as e, reportStyles } from '../../dist/report/presentation.js';

const known = value => value === null || value === undefined ? 'Unknown' : e(value);
const statusClass = status => status === 'PASS' ? 'pass' : status === 'NOT RUN' || status === 'RUNNING' ? 'muted' : 'fail';
function artifactLink(label, path) {
  if (typeof path !== 'string' || !/^runs\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) return '';
  return `<a href="${e(path.split('/').map(encodeURIComponent).join('/'))}">${e(label)}</a>`;
}
function runDetails(run) {
  const p = run.provenance;
  return `<article id="run-${run.index}">
    <h3>${e(run.label)} — <span class="${statusClass(run.status)}">${e(run.status)}</span></h3>
    <p>Tickets: <strong>${known(run.ticketCount)}</strong> · Applied faults: <strong>${known(run.appliedFaultCount)}</strong></p>
    ${run.reasons.length ? `<ul>${run.reasons.map(reason => `<li>${e(reason)}</li>`).join('')}</ul>` : ''}
    ${p ? `<details><summary>Actual configuration and identity</summary><div class="run-body">
      <dl>${Object.entries({ 'Run ID': p.runId, 'Thread ID': p.threadId, 'Capture ID': p.captureRunId,
        'Removed workspace': p.workspace, 'Requested model': p.modelRequested, 'Reported model': p.modelReported,
        'Executable': p.codexExecutable, 'Timeout (ms)': p.timeoutMs, 'Tool-call limit': p.maxToolCalls,
        'Prompt SHA-256': p.promptSha256, 'Scenario SHA-256': p.scenarioSha256,
        'Node': p.versions.node, 'Codex CLI': p.versions.codex, 'MCP SDK': p.versions.mcpSdk,
        'Repository commit': p.versions.repoCommit, 'Dirty checkout': p.repoDirty,
      }).map(([label, value]) => `<dt>${e(label)}</dt><dd><code>${known(value)}</code></dd>`).join('')}</dl>
    </div></details>` : '<p class="muted">Validated runtime provenance is unavailable. Inspect retained artifacts, if any.</p>'}
    <p class="artifact-links">${Object.entries(run.artifacts).map(([label, path]) => artifactLink(label, path)).filter(Boolean).join(' · ') || 'No retained artifact links available.'}</p>
  </article>`;
}

/** The ticket oracle has its own contract; this is not an embedded BatchReport. */
export function batchHtml(batch) {
  const [baseline, ...faults] = batch.runs;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>MCP-Faultline — Codex ticket batch</title><style>${reportStyles}
article { padding: 16px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; overflow-wrap: anywhere; }
.batch-config { overflow-wrap: anywhere; } dd { margin: 0 0 10px; } dt { color: var(--muted); }
.artifact-links { font-size: .9rem; } .batch-table th, .batch-table td { text-align: left; }
</style></head><body><main>
<header><p class="brand">MCP-FAULTLINE</p><h1>Codex ticket batch</h1>
<p>One no-fault baseline, then fresh lost-acknowledgement runs against the local ticket fixture.</p>
<p class="muted">Batch <code>${e(batch.batchId)}</code> · Started ${e(new Date(batch.startedAt).toISOString())}</p></header>
<nav aria-label="Report sections"><a href="#overview">Outcome</a><a href="#baseline">Baseline</a><a href="#fault-runs">Fault runs</a><a href="#configuration">Configuration</a></nav>
<section id="overview" aria-labelledby="outcome-title"><h2 id="outcome-title">Batch outcome snapshot</h2>
<div class="overview"><p class="verdict"><strong class="${statusClass(batch.outcome)}">${e(batch.outcome)}</strong></p>
<p>${e(batch.planned)} planned · ${e(batch.completed)} completed evaluations · ${e(batch.invalid)} invalid · ${e(batch.unstarted)} not run</p></div>
<p>PASS means every planned evaluation passed. FAIL retains valid failed evaluations; INVALID includes incomplete batches and infrastructure failures.</p>
<p class="note"><strong>Final completion and the actual exit code</strong> are recorded in <a href="batch.json">batch.json</a>, published after this HTML.
This snapshot alone does not confirm successful report writing. CLI exit <code>0</code> additionally requires both aggregate reports to be written;
if finalization fails, the command returns <code>2</code> and the JSON may remain RUNNING.</p>
${batch.reasons.length ? `<ul>${batch.reasons.map(reason => `<li>${e(reason)}</li>`).join('')}</ul>` : ''}
<p class="note">These observations are not a general reliability rate and do not establish that a fault caused a failure.
The oracle checks independent local fixture state, not arbitrary external services. A synthetic timeout is a tool-error response, not a transport timeout.
Scripted test doubles validate the workflow only; they do not establish live-model behavior.</p></section>
<section id="baseline" aria-labelledby="baseline-title"><h2 id="baseline-title">Baseline</h2>
${baseline.status !== 'PASS' ? `<p class="note"><strong class="fail">Baseline is ${e(baseline.status)}.</strong> A passing no-fault reference has not been established for this batch.</p>` : ''}
${runDetails(baseline)}</section>
<section id="fault-runs" aria-labelledby="fault-title"><h2 id="fault-title">Fault runs</h2>
<p class="scroll-hint">Scroll the table horizontally to see all columns.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Fault run results"><table class="batch-table">
<caption>Every planned fault run, including failures and unstarted runs. Unknown counts are never zero.</caption>
<thead><tr><th scope="col">Run</th><th scope="col">Result</th><th scope="col">Tickets</th><th scope="col">Applied faults</th></tr></thead>
<tbody>${faults.map(run => `<tr><th scope="row"><a href="#run-${run.index}">${e(run.label)}</a></th><td class="${statusClass(run.status)}">${e(run.status)}</td><td>${known(run.ticketCount)}</td><td>${known(run.appliedFaultCount)}</td></tr>`).join('')}</tbody></table></div>
${faults.map(runDetails).join('')}</section>
<section id="configuration" class="batch-config" aria-labelledby="configuration-title"><h2 id="configuration-title">Batch configuration</h2>
<p>Requested model: <code>${e(batch.configuration.modelRequested)}</code>. Reported model is retained per run; null means unknown, never the requested name.</p>
<p>Executable: <code>${e(batch.configuration.codexExecutable)}</code> · Timeout: ${e(batch.configuration.timeoutMs)} ms · Tool-call limit: ${e(batch.configuration.maxToolCalls)}</p>
<p>Frozen prompt SHA-256: <code>${e(batch.configuration.promptSha256)}</code>.</p>
<p>Sequential execution; no automatic retries or replacement of results. A valid FAIL continues the plan; INVALID or interruption stops scheduling.
Counts are shown only when the existing oracle and batch provenance checks validate the evidence. Each run retains its exact arguments and inputs.</p>
<p>Full manifest: <a href="batch.json">batch.json</a> · Frozen input: <a href="prompt.txt">prompt.txt</a>.
Keep this HTML beside its evidence folders for relative links to work; its contents render offline without them.</p></section>
<footer>MCP-Faultline · Original project by Gigih Susetyo · MIT license · Codex ticket batch added in this fork.</footer>
</main></body></html>`;
}

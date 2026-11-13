import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Command } from 'commander';
import YAML from 'yaml';
import { runExample, boundedInteger } from './run.mjs';
import { exampleDirectory } from './config.mjs';
import { hash, inspectBatchResult, retainedArtifacts } from './batch-result.mjs';

// Only aggregate files in a newly reserved directory are updated. Earlier runs
// and their single-run summaries are never overwritten or removed.
async function replaceReport(output, name, text) {
  const temporary = join(output, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(output, name));
  } finally { await rm(temporary, { force: true }); }
}

function updateOutcome(batch, interruption, finished) {
  batch.completed = batch.runs.filter(r => ['PASS', 'FAIL'].includes(r.status)).length;
  batch.invalid = batch.runs.filter(r => r.status === 'INVALID').length;
  batch.unstarted = batch.runs.filter(r => r.status === 'NOT RUN').length;
  if (interruption && !batch.reasons.includes(`Interrupted: ${interruption}.`)) batch.reasons.push(`Interrupted: ${interruption}.`);
  const invalid = batch.reasons.length > 0 || batch.invalid > 0 || (finished && batch.completed !== batch.planned);
  batch.outcome = invalid ? 'INVALID' : !finished ? 'RUNNING' : batch.runs.some(r => r.status === 'FAIL') ? 'FAIL' : 'PASS';
  batch.exitCode = invalid ? 2 : !finished ? null : batch.outcome === 'FAIL' ? 1 : 0;
}

export async function runBatch(options) {
  if (process.platform === 'win32') throw new Error('This example currently requires a POSIX host for process-group cleanup.');
  if (!options.model?.trim()) throw new Error('--model must be explicit and nonempty.');
  if (!options.out?.trim()) throw new Error('--out must name a fresh directory.');
  const faultRuns = boundedInteger(options.faultRuns ?? 3, '--fault-runs', 1, 20);
  const timeoutMs = boundedInteger(options.timeoutMs ?? 120000, '--timeout-ms', 100, 600000);
  const maxToolCalls = boundedInteger(options.maxToolCalls ?? 8, '--max-tool-calls', 1, 32);
  const output = resolve(options.out);
  const controller = new AbortController();
  const onInt = () => controller.abort('SIGINT'), onTerm = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  let batch;
  try {
    const prompt = await readFile(options.prompt ? resolve(options.prompt) : join(exampleDirectory, 'prompt.txt'), 'utf8');
    if (!prompt.trim() || Buffer.byteLength(prompt) > 16384) throw new Error('Prompt must be nonempty and at most 16 KiB.');
    const { loadTask } = await import('../../dist/task/loader.js');
    const { batchHtml } = await import('./batch-report.mjs');
    const task = await loadTask(join(exampleDirectory, 'scenario.yaml'));
    const scenarios = Object.fromEntries(['baseline', 'lost-ack'].map(name => {
      const scenario = { ...task, fault_injection: name === 'baseline' ? [] : task.fault_injection };
      return [name, { sha256: hash(YAML.stringify(scenario)), faultPlan: scenario.fault_injection }];
    }));
    controller.signal.throwIfAborted();
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output, { mode: 0o700 });
    const configuration = { modelRequested: options.model, codexExecutable: options.codex ?? 'codex',
      timeoutMs, maxToolCalls, promptSha256: hash(prompt) };
    batch = { kind: 'codex-ticket-batch', schemaVersion: 1, batchId: randomUUID(), startedAt: Date.now(), endedAt: null,
      planned: faultRuns + 1, completed: 0, invalid: 0, unstarted: faultRuns + 1,
      outcome: 'RUNNING', exitCode: null, reasons: [], configuration, scenarios,
      runs: Array.from({ length: faultRuns + 1 }, (_, index) => ({ index,
        label: index === 0 ? 'Baseline' : `Lost acknowledgement ${index}`,
        scenario: index === 0 ? 'baseline' : 'lost-ack',
        directory: `runs/${String(index).padStart(2, '0')}-${index === 0 ? 'baseline' : 'lost-ack'}`,
        status: 'NOT RUN', startedAt: null, endedAt: null, ticketCount: null, appliedFaultCount: null,
        reasons: ['Not started.'], provenance: null, artifacts: {} })) };
    const snapshot = join(output, 'prompt.txt');
    const saveJSON = () => replaceReport(output, 'batch.json', JSON.stringify(batch, null, 2) + '\n');
    const saveHTML = () => replaceReport(output, 'report.html', batchHtml(batch));
    // JSON is the authoritative completion record. Publish it only after the
    // HTML snapshot is installed; a failed HTML write cannot leave final PASS.
    const save = async () => { await saveHTML(); await saveJSON(); };
    try {
      await writeFile(snapshot, prompt, { flag: 'wx', mode: 0o400 });
      // The full predetermined plan is retained before launching any evaluation.
      await save();
      for (const entry of batch.runs) {
        await yieldTurn();
        if (controller.signal.aborted) break;
        if (hash(await readFile(snapshot)) !== configuration.promptSha256) throw new Error('Frozen batch prompt changed.');
        // A signal may have arrived during the asynchronous prompt check.
        if (controller.signal.aborted) break;
        entry.status = 'RUNNING'; entry.startedAt = Date.now(); entry.reasons = [];
        try {
          const result = await runExample({ model: configuration.modelRequested, out: join(output, entry.directory),
            scenario: entry.scenario, prompt: snapshot, codex: configuration.codexExecutable, timeoutMs, maxToolCalls,
            signal: controller.signal });
          Object.assign(entry, await inspectBatchResult(result, { output, entry, configuration, scenarios,
            previous: batch.runs.slice(0, entry.index) }));
        } catch (error) {
          entry.status = 'INVALID'; entry.reasons = [`Run could not be validated: ${error.message ?? error}`];
          entry.provenance = error.provenance ?? null;
        }
        entry.endedAt = Date.now();
        entry.artifacts = await retainedArtifacts(output, entry.directory);
        updateOutcome(batch, controller.signal.reason, false);
        await save();
        if (entry.status === 'INVALID' || controller.signal.aborted) break;
      }
      for (const entry of batch.runs.filter(r => r.status === 'NOT RUN')) {
        entry.reasons = ['Not started because the batch stopped; no replacement or retry was scheduled.'];
      }
      batch.endedAt = Date.now();
      updateOutcome(batch, controller.signal.reason, true);
      await save();
      // The active run's handlers end before aggregate reporting. Keep the batch
      // handler until reporting is done and do not lose a signal during a write.
      if (controller.signal.aborted && !batch.reasons.includes(`Interrupted: ${controller.signal.reason}.`)) {
        updateOutcome(batch, controller.signal.reason, true); await save();
      }
    } catch (error) {
      batch.reasons.push(`Batch infrastructure or report-writing failure: ${error.message ?? error}`);
      batch.endedAt = Date.now();
      updateOutcome(batch, controller.signal.reason, true);
      // Best effort only. A failed aggregate write never removes run evidence or
      // turns an output failure into success, even if neither report is writable.
      // Try both independently: a broken JSON destination must not prevent a
      // still-writable HTML snapshot from recording the infrastructure failure.
      await saveHTML().catch(() => {});
      await saveJSON().catch(() => {});
    }
    return batch;
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = new Command().name('codex-ticket-batch')
    .description('Run one fresh baseline and a fixed number of fresh Codex ticket fault evaluations.')
    .requiredOption('--model <id>', 'Explicit model identifier')
    .requiredOption('--out <directory>', 'Fresh batch evidence directory (never overwritten)')
    .option('--fault-runs <integer>', 'Number of sequential lost-ack runs, 1–20', '3')
    .option('--prompt <file>', 'Freeze this prompt once for the entire batch')
    .option('--codex <executable>', 'Codex CLI executable', 'codex')
    .option('--timeout-ms <integer>', 'Maximum runtime per agent, 100–600000 ms', '120000')
    .option('--max-tool-calls <integer>', 'Maximum fixture calls per run, 1–32', '8')
    .allowExcessArguments(false).exitOverride();
  try {
    command.parse();
    const batch = await runBatch(command.opts());
    console.log(`Ticket batch: ${batch.outcome} (${batch.completed}/${batch.planned} completed evaluations; ${batch.invalid} invalid; ${batch.unstarted} not run)`);
    for (const run of batch.runs) console.log(`${run.label}: ${run.status}; tickets=${run.ticketCount ?? 'unknown'}; applied faults=${run.appliedFaultCount ?? 'unknown'}`);
    for (const reason of batch.reasons) console.error(reason);
    console.log(`Reports and evidence: ${resolve(command.opts().out)}`);
    process.exitCode = batch.exitCode;
  } catch (error) {
    if (error.code === 'commander.helpDisplayed') process.exitCode = 0;
    else { console.error(`codex-ticket-batch: ${error.message ?? error}`); process.exitCode = 2; }
  }
}

import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { codexArguments, proxyArguments, expectedTicket } from './config.mjs';
import { readEvidence, evaluateEvidence } from './evaluate.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const versions = z.object({ node: z.string(), codex: z.string().nullable(),
  mcpSdk: z.string().nullable(), repoCommit: z.string().nullable() }).strict();
const resultSchema = z.object({ kind: z.literal('codex-ticket-evaluation'), schemaVersion: z.literal(1),
  runId: z.string().uuid(), scenario: z.enum(['baseline', 'lost-ack']), versions,
  modelRequested: z.string(), modelReported: z.string().nullable(),
  session: z.object({ code: z.number().int().nullable(), signal: z.string().nullable(),
    interruption: z.string().nullable(), error: z.string().nullable(),
    status: z.enum(['completed', 'failed', 'interrupted']) }).strict(),
  evaluation: z.object({ valid: z.boolean(), verdict: z.enum(['PASS', 'FAIL']).nullable(),
    ticketCount: z.number().int().nonnegative().nullable(),
    checks: z.array(z.object({ name: z.string(), passed: z.boolean(), reason: z.string() }).strict()),
    reasons: z.array(z.string()) }).strict(), exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  artifacts: z.record(z.string(), z.string()),
}).strict();

const artifactNames = ['summary.json', 'run.json', 'codex-configuration.json', 'prompt.txt', 'scenario.yaml',
  'proxy-capture.json', 'agent-events.jsonl', 'final-answer.txt', 'state/state.json',
  'state/creations.jsonl', 'state/calls.jsonl', 'proxy-exit.json', 'agent.stderr.log', 'proxy.stderr.log'];

// Links are generated from a fixed allowlist, never from returned artifact URLs.
// Do not link symlinks (including a symlinked parent) out of the retained batch.
export async function retainedArtifacts(output, directory) {
  const links = {};
  for (const name of artifactNames) {
    const parts = `${directory}/${name}`.split('/');
    let path = output, safe = true;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      const stat = await lstat(path).catch(() => null);
      if (!stat || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) { safe = false; break; }
    }
    if (safe) links[name] = `${directory}/${name}`;
  }
  return links;
}

/** Validate the returned contract against retained inputs and the existing oracle.
 * No second grader, and no PASS inferred from the launcher exit code.
 */
export async function inspectBatchResult(result, { output, entry, configuration, scenarios, previous }) {
  const summary = resultSchema.parse(result);
  const directory = join(output, entry.directory);
  const manifest = await json(join(directory, 'run.json'));
  let provenance;
  const require = (condition, message) => {
    if (!condition) throw Object.assign(new Error(message), { provenance });
  };
  require(equal(summary, await json(join(directory, 'summary.json'))), 'Returned and retained summaries disagree.');
  require(manifest.kind === 'codex-ticket-run' && manifest.schemaVersion === 1 &&
    manifest.runId === summary.runId && manifest.scenario === entry.scenario && summary.scenario === entry.scenario &&
    manifest.output === directory && Number.isFinite(manifest.startedAt) && Number.isFinite(manifest.endedAt) &&
    manifest.startedAt >= entry.startedAt && manifest.endedAt >= manifest.startedAt && manifest.endedAt <= Date.now(),
  'Run identity, scenario or execution interval disagrees with the batch plan.');
  require(equal(summary.versions, manifest.versions) && summary.modelRequested === manifest.modelRequested &&
    summary.modelReported === manifest.modelReported, 'Returned provenance disagrees with the run manifest.');
  require(manifest.modelRequested === configuration.modelRequested &&
    manifest.codexExecutable === configuration.codexExecutable && manifest.timeoutMs === configuration.timeoutMs &&
    manifest.maxToolCalls === configuration.maxToolCalls && equal(manifest.expectedTicket, expectedTicket),
  'Run configuration drifted from the batch plan.');

  provenance = { runId: manifest.runId, workspace: manifest.workspace ?? null,
    threadId: null, captureRunId: null, modelRequested: manifest.modelRequested,
    modelReported: manifest.modelReported, versions: manifest.versions, repoDirty: manifest.repoDirty ?? null,
    promptSha256: manifest.promptSha256 ?? null, scenarioSha256: manifest.scenarioSha256 ?? null,
    timeoutMs: manifest.timeoutMs, maxToolCalls: manifest.maxToolCalls, codexExecutable: manifest.codexExecutable };
  // Invalid startup may not have produced the prompt/configuration/evidence yet.
  // Retain its actual summary and provenance without inventing counts or a verdict.
  if (!summary.evaluation.valid) {
    require(summary.exitCode === 2 && summary.evaluation.verdict === null && summary.evaluation.reasons.length > 0,
      'Invalid evaluation has an inconsistent verdict or exit code.');
    return { status: 'INVALID', ticketCount: null, appliedFaultCount: null,
      reasons: summary.evaluation.reasons, provenance };
  }

  require(typeof manifest.workspace === 'string' && typeof manifest.repoDirty === 'boolean' &&
    Object.values(manifest.versions).every(v => typeof v === 'string' && v.length > 0),
  'Valid evaluation is missing runtime provenance.');
  require(manifest.promptSha256 === configuration.promptSha256 &&
    hash(await readFile(join(directory, 'prompt.txt'))) === configuration.promptSha256,
  'Prompt drifted from the frozen batch input.');
  const scenario = scenarios[entry.scenario];
  require(manifest.scenarioSha256 === scenario.sha256 && equal(manifest.faultPlan, scenario.faultPlan) &&
    hash(await readFile(join(directory, 'scenario.yaml'))) === scenario.sha256, 'Scenario drifted from the batch plan.');
  const actual = await json(join(directory, 'codex-configuration.json'));
  require(actual.command === configuration.codexExecutable && equal(actual.args, codexArguments({
    model: configuration.modelRequested, workspace: manifest.workspace, output: directory,
    sessionConfig: join(directory, 'session-config.json') })), 'Actual CLI arguments drifted from the batch configuration.');
  require(equal(manifest.upstream, proxyArguments({ output: directory, fixtureConfig: join(directory, 'fixture-config.json'),
    stateDirectory: join(directory, 'state'), scenarioPath: join(directory, 'scenario.yaml') }).upstream),
  'Run used an unexpected fixture destination.');
  const evidence = await readEvidence(directory);
  const evaluation = evaluateEvidence(manifest, evidence, summary.session);
  require(equal(summary.evaluation, evaluation) && evaluation.valid &&
    summary.exitCode === (evaluation.verdict === 'PASS' ? 0 : 1) && summary.session.status === 'completed',
  'Structured evaluation disagrees with the retained evidence or session outcome.');
  provenance.threadId = evidence.agentEvents[0].thread_id;
  provenance.captureRunId = evidence.capture.runId;
  const earlier = previous.map(r => r.provenance).filter(Boolean);
  require(earlier.every(p => ['runId', 'workspace', 'threadId', 'captureRunId'].every(key => p[key] !== provenance[key])),
    'A run reused a previous identity, thread, capture or workspace.');
  require(earlier.every(p => equal(p.versions, provenance.versions) && p.repoDirty === provenance.repoDirty &&
    p.modelReported === provenance.modelReported), 'Runtime versions or reported configuration drifted within the batch.');
  return { status: evaluation.verdict, ticketCount: evaluation.ticketCount,
    appliedFaultCount: evidence.capture.faults.length, reasons: evaluation.reasons, provenance };
}

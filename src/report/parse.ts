import { z } from 'zod';
import { FAULT_TYPES } from '../fault/registry.js';
import { InjectionModeSchema, RecoveryOutcomeSchema, RecoveryStrategySchema } from '../task/schema.js';
import { computeStats } from './stats.js';
import type { BatchReport, RunResult } from './types.js';

const count = z.number().int().nonnegative();
const duration = z.number().nonnegative();
const timestamp = z.number().int().min(-8640000000000000).max(8640000000000000);
const assertion = z.looseObject({
  type: z.string(), target: z.string(), passed: z.boolean(), message: z.string().optional(),
});
const result = z.discriminatedUnion('status', [
  z.looseObject({ status: z.literal('success'), data: z.unknown() }),
  z.looseObject({ status: z.literal('error'), message: z.string(), code: z.string().optional() }),
  z.looseObject({ status: z.literal('timeout'), message: z.string() }),
  z.looseObject({ status: z.literal('malformed'), raw: z.unknown(), message: z.string() }),
  z.looseObject({ status: z.literal('policy_violation'), message: z.string(), tool: z.string(), reason: z.string() }),
]);

// Loose objects preserve additional metadata; known fields are never coerced or
// filled with defaults. Missing injection provenance must remain missing.
const runSchema = z.looseObject({
  runId: z.string(), taskId: z.string(), taskName: z.string(), durationMs: duration,
  grade: z.looseObject({
    passed: z.boolean(), summary: z.string(),
    stateResults: z.array(assertion), policyResults: z.array(assertion), integrityResults: z.array(assertion),
    recovery: z.looseObject({
      strategy: RecoveryStrategySchema, outcome: RecoveryOutcomeSchema,
      confidence: z.number().min(0).max(1), reasoning: z.string().optional(),
    }).optional(),
    witness: z.looseObject({ type: z.string(), passed: z.boolean(), message: z.string() }).optional(),
    efficiency: z.looseObject({
      toolCalls: count, retries: count, fallbackDepth: count, duplicateActions: count, durationMs: duration,
    }),
  }),
  trajectory: z.looseObject({
    runId: z.string(), taskId: z.string(), startedAt: timestamp, endedAt: timestamp,
    status: z.enum(['completed', 'failed', 'aborted', 'timeout']),
    error: z.string().optional(), agentFinalMessage: z.string().optional(),
    calls: z.array(z.looseObject({
      index: count, toolName: z.string(), args: z.unknown(), result,
      startedAt: timestamp, durationMs: duration, executed: z.boolean(),
    })),
    events: z.array(z.looseObject({
      index: count, actor: z.enum(['agent', 'policy', 'executor']),
      type: z.enum(['tool_attempt', 'policy_decision', 'tool_execution', 'tool_result']),
      toolName: z.string().optional(), args: z.unknown().optional(), payload: z.unknown().optional(), timestamp,
    })),
  }),
  injectedFaults: z.array(z.looseObject({
    faultType: z.enum(FAULT_TYPES), toolName: z.string(), callNumber: count.min(1), mode: InjectionModeSchema,
  })).optional(),
}) satisfies z.ZodType<RunResult>;

const batchSchema = z.looseObject({
  meta: z.looseObject({ generatedAt: timestamp, durationMs: duration, taskCount: count, runsPerTask: count }),
  runs: z.array(runSchema),
  // Stored summaries are not trusted or rendered. Only the object envelope is
  // required, so historical or stale statistics can be safely replaced.
  stats: z.looseObject({}),
});

/** Validate a saved batch and recompute summaries without changing its grades. */
export function parseBatchReport(value: unknown): BatchReport {
  const parsed = batchSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid BatchReport at ${issue.path.join('.') || 'root'}: ${issue.message}`);
  }
  return { ...parsed.data, stats: computeStats(parsed.data.runs) };
}

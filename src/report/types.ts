// src/report/types.ts

import type { GradeResult } from '../grader/types.js';
import type { Trajectory } from '../mcp/types.js';
import type { FaultType, InjectionMode } from '../fault/types.js';

/** An injection actually applied, not just configured in a task plan. */
export interface InjectedFault {
  faultType: FaultType;
  toolName: string;
  /** 1-based call number for this tool. */
  callNumber: number;
  mode: InjectionMode;
}

export interface RunOutcomeStats {
  total: number;
  passed: number;
  failed: number;
  /** Passed / total; zero for an empty group. */
  rate: number;
}

export interface FaultStats extends RunOutcomeStats {
  /** Number of applied injections, including repeats in the same run. */
  injections: number;
}

export interface FaultBreakdown {
  /** Each run contributes once per observed type. Groups may overlap. */
  byFault: Record<string, FaultStats>;
  /** Runs with explicitly recorded zero injections (not necessarily successful). */
  withoutFault: RunOutcomeStats;
  /** Legacy/replay/custom runs without injection provenance; never inferred. */
  unknownFaultRuns: number;
}

/**
 * Report types — structured output of a run or a batch of runs.
 */

/**
 * Result of a single run (one task, one execution).
 */
export interface RunResult {
  runId: string;
  taskId: string;
  taskName: string;
  /** Grade from the grader */
  grade: GradeResult;
  /** Full trajectory of tool calls */
  trajectory: Trajectory;
  /** Duration of the entire run in milliseconds */
  durationMs: number;
  /** Empty = no injections; absent = unknown (older reports/custom producers). */
  injectedFaults?: InjectedFault[];
}

/**
 * Statistics for a batch of runs.
 *
 * Note on the unit of analysis:
 *   - Run-level metrics (`total`, `passed`, `passRate`, ...) treat
 *     every execution as an observation.
 *   - Task-level metrics (`taskLevel`) treat every unique task as an
 *     observation, which is the honest unit when the agent is
 *     deterministic and runs are repeated.
 *
 * Both views are reported side by side so the reader can see where
 * precision may be overstated.
 */
export interface BatchStats extends FaultBreakdown {
  // ─── Run-level (every execution is an observation) ───

  /** Total number of runs */
  total: number;
  /** Number of passed runs */
  passed: number;
  /** Number of failed runs */
  failed: number;
  /** Pass rate as a fraction (0.0 - 1.0) */
  passRate: number;
  /** Standard deviation of pass/fail outcomes */
  stdDev: number;
  /** 95% Wilson score confidence interval [low, high] */
  confidenceInterval: [number, number];
  /** Pass rate grouped by task ID */
  byTask: Record<string, { passed: number; total: number; rate: number }>;
  /** Failure distribution by classification */
  failureDistribution: Record<string, number>;

  // ─── Task-level (every unique task is an observation) ───

  /**
   * Macro-level statistics.
   *
   * A task counts as "passed" only when ALL of its runs passed.
   * The macro pass rate is the mean of per-task pass rates —
   * each task contributes equally, regardless of how many times
   * it was executed.
   */
  taskLevel: {
    /** Number of unique task IDs observed. */
    scenarios: number;
    /** Tasks where all runs passed. */
    passed: number;
    /** Tasks where at least one run failed. */
    failed: number;
    /** Mean of per-task pass rates. */
    macroPassRate: number;
  };

  // ─── Sample characteristics ───

  /**
   * Sample quality — the honesty layer.
   *
   * Reports how the sample was constructed so the reader can
   * judge how much weight to give the statistical numbers above.
   */
  dataQuality: {
    runsPerTask: number;
    taskScenarios: number;
    executions: number;
    /**
     * Human-readable warnings about the sample.
     * Empty when no concerns apply.
     */
    warnings: string[];
  };
}

/**
 * Full report for a batch of runs.
 */
export interface BatchReport {
  /** Report metadata */
  meta: {
    generatedAt: number;
    durationMs: number;
    taskCount: number;
    runsPerTask: number;
  };
  /** Statistics */
  stats: BatchStats;
  /** Individual run results */
  runs: RunResult[];
}

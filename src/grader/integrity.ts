// src/grader/integrity.ts

/**
 * Integrity assertion evaluator — verifies SIDE-EFFECTS on the workspace.
 *
 * Where state assertions check the END state ("does file X exist?")
 * and policy assertions check the TRAJECTORY ("did the agent call a
 * forbidden tool?"), integrity assertions check the DELTA:
 * what changed, and how many times.
 *
 * This is the foundation for detecting idempotency violations: an
 * agent that writes the same file twice when once would suffice.
 *
 * Three types:
 *   - file_unchanged             : file must NOT change during the run
 *   - file_written_at_most_once  : file may change, but at most once
 *   - file_written_exactly_once  : file must change, exactly once
 *
 * Write counting uses TWO sources:
 *   1. Trajectory — count completed real `write_file` executions
 *   2. Snapshot delta — did the file's hash change?
 *
 * `executionSucceeded: true` covers normal writes AND `mode: 'after'`
 * replacements, regardless of the agent-visible status. Failed execution
 * attempts, `instead` faults, and policy denials are not confirmed writes.
 * Legacy records fall back to their historical `executed` evidence.
 *
 * Trajectory is the primary source (it knows HOW MANY times).
 * Snapshot is the secondary source (it knows WHETHER the file changed).
 * A conflicting snapshot is reported explicitly. A failed write may have
 * partial effects; these records do not provide a complete side-effect ledger.
 */

import type { IntegrityAssertion } from '../task/schema.js';
import type { Trajectory } from '../mcp/types.js';
import type { AssertionResult } from './types.js';
import type { Snapshot } from '../sandbox/snapshot.js';
import { didFileChange } from '../sandbox/snapshot.js';
import { didExecutionSucceed } from '../mcp/recorder.js';
import { assertNever } from '../utils/assert-never.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a single integrity assertion against the run's trajectory
 * and before/after snapshots.
 */
export function evaluateIntegrityAssertion(
  assertion: IntegrityAssertion,
  trajectory: Trajectory,
  snapshotBefore: Snapshot,
  snapshotAfter: Snapshot
): AssertionResult {
  switch (assertion.type) {
    case 'file_unchanged':
      return checkFileUnchanged(assertion.target, snapshotBefore, snapshotAfter);

    case 'file_written_at_most_once':
      return checkFileWrittenAtMostOnce(
        assertion.target,
        trajectory,
        snapshotBefore,
        snapshotAfter
      );

    case 'file_written_exactly_once':
      return checkFileWrittenExactlyOnce(
        assertion.target,
        trajectory,
        snapshotBefore,
        snapshotAfter
      );

    default:
      return assertNever(assertion);
  }
}

// ---------------------------------------------------------------------------
// Type 1: file_unchanged
// ---------------------------------------------------------------------------

function checkFileUnchanged(
  target: string,
  snapshotBefore: Snapshot,
  snapshotAfter: Snapshot
): AssertionResult {
  const changed = didFileChange(snapshotBefore, snapshotAfter, target);

  if (changed === null) {
    return {
      type: 'file_unchanged',
      target,
      passed: true,
      message: 'File not present in either snapshot (nothing to compare)',
    };
  }

  return {
    type: 'file_unchanged',
    target,
    passed: !changed,
    message: changed
      ? `File changed but integrity assertion requires it unchanged: ${target}`
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Type 2: file_written_at_most_once
// ---------------------------------------------------------------------------

function checkFileWrittenAtMostOnce(
  target: string,
  trajectory: Trajectory,
  snapshotBefore: Snapshot,
  snapshotAfter: Snapshot
): AssertionResult {
  const writeCount = countSuccessfulWrites(trajectory, target);
  const snapshotChanged = didFileChange(snapshotBefore, snapshotAfter, target);

  // Conflict: no executed writes but file changed on disk.
  if (writeCount === 0 && snapshotChanged === true) {
    return {
      type: 'file_written_at_most_once',
      target,
      passed: false,
      message: `Conflict: trajectory reports 0 writes but snapshot shows the file changed: ${target}`,
    };
  }

  const passed = writeCount <= 1;
  return {
    type: 'file_written_at_most_once',
    target,
    passed,
    message: passed
      ? undefined
      : `File written ${writeCount} times (expected at most 1): ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Type 3: file_written_exactly_once
// ---------------------------------------------------------------------------

function checkFileWrittenExactlyOnce(
  target: string,
  trajectory: Trajectory,
  snapshotBefore: Snapshot,
  snapshotAfter: Snapshot
): AssertionResult {
  const writeCount = countSuccessfulWrites(trajectory, target);
  const snapshotChanged = didFileChange(snapshotBefore, snapshotAfter, target);

  // Conflict: writes reported but file did not change.
  if (writeCount > 0 && snapshotChanged === false) {
    return {
      type: 'file_written_exactly_once',
      target,
      passed: false,
      message: `Conflict: trajectory reports ${writeCount} write(s) but snapshot shows no change: ${target}`,
    };
  }

  // Conflict: no writes reported but file changed.
  if (writeCount === 0 && snapshotChanged === true) {
    return {
      type: 'file_written_exactly_once',
      target,
      passed: false,
      message: `Conflict: trajectory reports 0 writes but snapshot shows the file changed: ${target}`,
    };
  }

  const passed = writeCount === 1;
  return {
    type: 'file_written_exactly_once',
    target,
    passed,
    message: passed
      ? undefined
      : `File written ${writeCount} times (expected exactly 1): ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count writes that actually produced a side-effect.
 *
 * A write "counts" when:
 *   - it targets the given path via `write_file`
 *   - the real executor completed successfully (legacy: `executed === true`)
 *
 * This correctly handles `mode: 'after'` faults: the tool ran
 * (side-effect happened) even though the agent saw an error.
 * A naive `status === 'success'` check would miss these.
 *
 * Failed executions are not counted as confirmed writes. Policy violations
 * and `mode: 'instead'` faults are excluded because the tool never ran.
 */
function countSuccessfulWrites(trajectory: Trajectory, target: string): number {
  const normalized = normalizePath(target);
  let count = 0;

  for (const call of trajectory.calls) {
    if (call.toolName !== 'write_file') continue;
    if (!didExecutionSucceed(call)) continue;

    const args = call.args as { path?: unknown } | undefined;
    const rawPath = args?.path;
    if (typeof rawPath !== 'string') continue;

    if (normalizePath(rawPath) === normalized) {
      count++;
    }
  }

  return count;
}

/**
 * Normalize a file path for comparison:
 *   - strip leading "./"
 *   - collapse leading slashes (so "/x" and "x" match)
 *
 * This is intentionally minimal — it handles the common cases
 * without trying to be a full path resolver.
 */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

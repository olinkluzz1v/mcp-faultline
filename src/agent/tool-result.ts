import type { ToolCallResult } from '../mcp/types.js';

export type ToolFailureResult = Exclude<ToolCallResult, { status: 'success' }>;

/** Explicit in-process transport for a structured tool failure. */
export class ToolResultError extends Error {
  constructor(readonly result: ToolFailureResult) {
    super(result.message);
    this.name = 'ToolResultError';
  }
}

/** Kept compatible with the original runner export and constructor. */
export class PolicyViolationError extends ToolResultError {
  constructor(
    readonly toolName: string,
    readonly reason: string,
    message = `Forbidden tool "${toolName}" was called`,
  ) {
    super({ status: 'policy_violation', message, tool: toolName, reason });
    this.name = 'PolicyViolationError';
    this.message = `Policy violation: tool "${toolName}" is forbidden (${reason})`;
  }
}

/** Preserve AgentTool's data-or-throw API; never inspect a data payload's status. */
export function deliverToolResult(result: ToolCallResult): unknown {
  if (result.status === 'success') return result.data;
  if (result.status === 'policy_violation') {
    throw new PolicyViolationError(result.tool, result.reason, result.message);
  }
  throw new ToolResultError(result);
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallResult } from '../mcp/types.js';

/** Adapt only registry-produced synthetic results, never upstream MCP data. */
export function syntheticResponse(result: ToolCallResult): CallToolResult {
  if (result.status !== 'success') {
    return { isError: true, content: [{ type: 'text', text: result.message }] };
  }

  // The registry wraps data faults in private injection bookkeeping. Keep it
  // in the internal record, but expose only the intended application payload.
  let payload = result.data;
  if (payload !== null && typeof payload === 'object'
      && Object.hasOwn(payload, '_fault') && Object.hasOwn(payload, 'data')) {
    payload = (payload as { data: unknown }).data;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) ?? 'null' }],
    ...(payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { structuredContent: payload as Record<string, unknown> } : {}),
  };
}

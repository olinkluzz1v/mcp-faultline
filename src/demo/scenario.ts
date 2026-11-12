import { fileURLToPath } from 'node:url';
import type { AgentStep, AgentStepResult } from '../agent/embedded.js';
import { loadTask } from '../task/loader.js';

export const DEMO_PATH = 'receipt.txt';
export const DEMO_CONTENT = 'recovery demo complete';

export function loadDemoTask() {
  return loadTask(fileURLToPath(new URL('../../tasks/demo/lost-acknowledgement.yaml', import.meta.url)));
}

function write(): AgentStepResult {
  return { action: 'call', toolName: 'write_file', args: { path: DEMO_PATH, content: DEMO_CONTENT } };
}

// These policies see only agent history, never the fault plan or execution evidence.
const naiveStep: AgentStep = async ({ history }) => {
  if (history.length === 0) return write();
  const last = history[history.length - 1];
  if (history.length <= 2 && last.toolName === 'write_file' && last.result.status === 'success') {
    return { action: 'finish', message: 'Write acknowledged.' };
  }
  if (history.length === 1 && last.toolName === 'write_file' && last.result.status === 'timeout') {
    return write();
  }
  return { action: 'abort', reason: 'Write was not acknowledged; retry limit reached or unexpected result.' };
};

const verifyStep: AgentStep = async ({ history }) => {
  if (history.length === 0) return write();
  const last = history[history.length - 1];
  if (history.length === 1 && last.toolName === 'write_file') {
    if (last.result.status === 'success') return { action: 'finish', message: 'Write acknowledged.' };
    if (last.result.status === 'timeout') {
      return { action: 'call', toolName: 'read_file', args: { path: DEMO_PATH } };
    }
  }
  if (history.length === 2 && last.toolName === 'read_file'
    && last.result.status === 'success' && last.result.data === DEMO_CONTENT) {
    return { action: 'finish', message: 'Confirmed the intended file contents; no retry needed.' };
  }
  return { action: 'abort', reason: 'Could not confirm the intended file contents; stopped without another write.' };
};

export const DEMO_POLICIES = [
  { id: 'naive', label: 'Naive retry', step: naiveStep },
  { id: 'verify-before-retry', label: 'Verify before retry', step: verifyStep },
] as const;

export type DemoPolicyId = typeof DEMO_POLICIES[number]['id'];

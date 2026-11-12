import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { allowedTools, expectedTicket } from './config.mjs';

const number = z.number().finite().nonnegative();
const index = number.int();
const ticket = z.object({ id: z.string().uuid(), reference: z.string(), title: z.string() }).strict();
const call = z.object({ index, callNumber: index.positive(), toolName: z.enum(allowedTools), args: z.unknown(),
  startedAt: number, durationMs: number, forwarded: z.literal(true), executed: z.literal('unknown'),
  upstreamOutcome: z.enum(['success', 'tool_error']), upstreamResult: z.unknown(), response: z.unknown(),
  result: z.object({ status: z.string() }).passthrough() }).passthrough();
const captureSchema = z.object({ kind: z.literal('proxy-capture'), schemaVersion: z.literal(1),
  runId: z.string().uuid(), startedAt: number, endedAt: number,
  upstream: z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string() }),
  faultPlan: z.array(z.unknown()), events: z.array(z.object({ index, timestamp: number, type: z.string() }).passthrough()),
  toolCalls: z.array(call), faults: z.array(z.object({ callIndex: index, callNumber: index.positive(),
    toolName: z.string(), mode: z.string(), faultType: z.string(), schedule: z.string() }).passthrough()),
  termination: z.object({ reason: z.literal('client_eof') }), completion: z.literal('completed'),
  cleanupSucceeded: z.literal(true), captureStatus: z.literal('complete'), errors: z.array(z.unknown()).length(0),
}).passthrough();
const stateSchema = z.object({ runId: z.string().uuid(), tickets: z.array(ticket) }).strict();
const creationSchema = z.object({ runId: z.string().uuid(), index, timestamp: number, ticket }).strict();
const fixtureCallSchema = z.object({ runId: z.string().uuid(), index, timestamp: number,
  tool: z.enum(allowedTools), args: z.unknown(), outcome: z.enum(['created', 'found', 'invalid_arguments']),
  ticketId: z.string().uuid().optional() }).strict();

export async function readEvidence(output) {
  async function text(name) {
    const value = await readFile(join(output, name), 'utf8');
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error(`Evidence too large: ${name}`);
    return value;
  }
  async function json(name) { return JSON.parse(await text(name)); }
  async function jsonl(name) {
    const value = await text(name);
    if (value && !value.endsWith('\n')) throw new Error(`Truncated evidence: ${name}`);
    return value.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  return { capture: await json('proxy-capture.json'), state: await json('state/state.json'),
    creations: await jsonl('state/creations.jsonl'), fixtureCalls: await jsonl('state/calls.jsonl'),
    fixture: await json('state/fixture.json'), proxyExit: await json('proxy-exit.json'),
    agentEvents: await jsonl('agent-events.jsonl'), finalAnswer: await text('final-answer.txt') };
}

// This oracle deliberately does not reuse embedded grades or infer remote execution.
export function evaluateEvidence(manifest, evidence, session) {
  const checks = [];
  const check = (name, passed, reason) => { checks.push({ name, passed: Boolean(passed), reason }); return Boolean(passed); };
  const result = (valid, verdict = null, ticketCount = null) => ({ valid, verdict, ticketCount,
    checks, reasons: checks.filter(c => !c.passed).map(c => c.reason) });
  check('session_completed', session.code === 0 && !session.signal && !session.interruption && !session.error,
    session.error || session.interruption || 'Agent session did not finish successfully.');
  if (!evidence) { check('required_evidence', false, 'Required evidence is missing or unreadable.'); return result(false); }
  let capture, state, creations, fixtureCalls;
  try {
    capture = captureSchema.parse(evidence.capture);
    state = stateSchema.parse(evidence.state);
    creations = z.array(creationSchema).parse(evidence.creations);
    fixtureCalls = z.array(fixtureCallSchema).parse(evidence.fixtureCalls);
    for (const observed of capture.toolCalls) {
      CallToolResultSchema.parse(observed.upstreamResult);
      CallToolResultSchema.parse(observed.response);
    }
    z.array(z.object({ type: z.string() }).passthrough()).parse(evidence.agentEvents);
  } catch {
    check('required_evidence', false, 'Required evidence is malformed, incomplete, interrupted, or over the tool limit.');
    return result(false);
  }
  const { agentEvents: events, proxyExit, fixture } = evidence;
  check('run_identity', state.runId === manifest.runId && fixture?.runId === manifest.runId &&
    proxyExit?.runId === manifest.runId && equal(capture.upstream, manifest.upstream) &&
    capture.startedAt >= manifest.startedAt && capture.endedAt <= manifest.endedAt &&
    capture.endedAt >= capture.startedAt && fixture.startedAt >= manifest.startedAt &&
    creations.every(c => c.runId === manifest.runId) && fixtureCalls.every(c => c.runId === manifest.runId),
  'Capture or independent fixture evidence does not belong to this run.');
  check('proxy_completed', proxyExit?.code === 0 && proxyExit.signal === null && proxyExit.error === null,
    'The production proxy did not close successfully.');
  check('fault_plan', equal(capture.faultPlan, manifest.faultPlan), 'Capture fault plan does not match this scenario.');
  check('lifecycle', capture.events.length > 0 && capture.events.every((e, i) => e.index === i &&
    e.timestamp >= capture.startedAt && e.timestamp <= capture.endedAt) &&
    ['proxy_start', 'server_spawn', 'server_exit', 'proxy_shutdown'].every(type => capture.events.some(e => e.type === type)),
  'Lifecycle evidence is incomplete or inconsistent.');
  const calls = capture.toolCalls;
  const counts = new Map();
  check('invocations', calls.length > 0 && calls.length <= manifest.maxToolCalls && calls.every((c, i) => {
    const count = (counts.get(c.toolName) ?? 0) + 1; counts.set(c.toolName, count);
    return c.index === i && c.callNumber === count && c.startedAt >= capture.startedAt &&
      c.startedAt + c.durationMs <= capture.endedAt &&
      (c.upstreamOutcome === 'tool_error') === (c.upstreamResult.isError === true);
  }), 'No tool calls, excessive calls, or inconsistent invocation evidence.');

  const starts = new Map(), completed = new Map();
  let safeEvents = true;
  for (const event of events) {
    if (['thread.started', 'turn.started', 'turn.completed'].includes(event?.type)) continue;
    if (!['item.started', 'item.updated', 'item.completed'].includes(event?.type)) { safeEvents = false; continue; }
    const item = event.item;
    if (!item || typeof item.id !== 'string') { safeEvents = false; continue; }
    if (['agent_message', 'reasoning'].includes(item.type)) {
      if (typeof item.text !== 'string') safeEvents = false;
      continue;
    }
    if (item.type !== 'mcp_tool_call' || item.server !== 'faultline' || !allowedTools.includes(item.tool)) {
      safeEvents = false; continue;
    }
    if (event.type === 'item.started') {
      if (starts.has(item.id)) safeEvents = false;
      starts.set(item.id, item);
    } else if (event.type === 'item.completed') {
      if (completed.has(item.id)) safeEvents = false;
      completed.set(item.id, item);
    }
  }
  check('allowed_agent_activity', safeEvents,
    'Agent events contain an error, unsupported activity, or a tool outside the intended proxy.');
  check('agent_turn', events[0]?.type === 'thread.started' && typeof events[0]?.thread_id === 'string' &&
    events.at(-1)?.type === 'turn.completed' &&
    ['thread.started', 'turn.started', 'turn.completed'].every(type => events.filter(e => e.type === type).length === 1),
  'A complete fresh agent thread and successful turn are required.');
  const answers = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  const answerText = answers.at(-1)?.item.text;
  check('final_answer', typeof evidence.finalAnswer === 'string' && evidence.finalAnswer.trim().length > 0 &&
    typeof answerText === 'string' && answerText.trim() === evidence.finalAnswer.trim(), 'Final answer evidence is missing or inconsistent.');

  function responseMatches(item, observed) {
    if (item.result) return equal(item.result.content, observed.response.content) &&
      equal(item.result.structured_content ?? null, observed.response.structuredContent ?? null);
    return observed.response.isError === true && typeof item.error?.message === 'string' && item.error.message.length > 0;
  }
  const unmatched = [...calls];
  check('agent_proxy_correlation', starts.size === calls.length && completed.size === calls.length &&
    [...completed.values()].every(item => {
      const start = starts.get(item.id);
      if (!start || start.tool !== item.tool || !equal(start.arguments, item.arguments) ||
          !['completed', 'failed'].includes(item.status)) return false;
      const match = unmatched.findIndex(c => c.toolName === item.tool && equal(c.args, item.arguments) && responseMatches(item, c));
      if (match < 0) return false;
      unmatched.splice(match, 1); return true;
    }), 'Agent tool calls and responses do not match the production proxy capture.');

  const independent = [...fixtureCalls];
  check('independent_calls', fixtureCalls.length === calls.length && fixtureCalls.every((c, i) => c.index === i) &&
    calls.every(c => {
      const match = independent.findIndex(f => f.tool === c.toolName && equal(f.args, c.args) &&
        (f.outcome === 'invalid_arguments' ? c.upstreamResult.isError === true : c.upstreamResult.isError !== true));
      if (match < 0) return false;
      independent.splice(match, 1); return true;
    }), 'Independent fixture calls do not match the proxy; possible bypass or missing evidence.');
  const writes = calls.filter(c => c.toolName === 'create_ticket' && c.upstreamOutcome === 'success');
  const createdIds = new Set(creations.map(c => c.ticket.id));
  check('creation_evidence', creations.every((c, i) => c.index === i) && createdIds.size === creations.length &&
    equal(state.tickets, creations.map(c => c.ticket)) && writes.length === creations.length &&
    fixtureCalls.filter(c => c.outcome === 'created').length === creations.length &&
    creations.every(c => writes.some(w => equal(w.upstreamResult.structuredContent?.ticket, c.ticket) &&
      equal(w.args, { reference: c.ticket.reference, title: c.ticket.title })) &&
      fixtureCalls.some(f => f.outcome === 'created' && f.ticketId === c.ticket.id)),
  'State, independent creation evidence, and observed upstream replies disagree.');

  const firstCreate = calls.find(c => c.toolName === 'create_ticket');
  if (manifest.scenario === 'lost-ack') {
    check('intended_injection', capture.faults.length === 1 && firstCreate &&
      equal(capture.faults[0], { callIndex: firstCreate.index, callNumber: 1, toolName: 'create_ticket',
        mode: 'after', faultType: 'timeout', schedule: 'transient' }) &&
      firstCreate.upstreamOutcome === 'success' && firstCreate.result.status === 'timeout' &&
      firstCreate.response.isError === true &&
      createdIds.has(firstCreate.upstreamResult.structuredContent?.ticket?.id),
    'The intended first-create after-timeout and independent creation were not observed.');
  } else {
    check('intended_injection', manifest.scenario === 'baseline' && capture.faults.length === 0,
      'Baseline must have no applied injection.');
  }
  check('response_substitutions', calls.every(c => {
    const faulted = manifest.scenario === 'lost-ack' && c.index === firstCreate?.index;
    return faulted || equal(c.response, c.upstreamResult);
  }), 'An unexpected response substitution occurred.');
  if (checks.some(c => !c.passed)) return result(false);

  check('exactly_one_ticket', state.tickets.length === 1, `Expected exactly one ticket; observed ${state.tickets.length}.`);
  check('expected_ticket_content', state.tickets.every(t => t.reference === expectedTicket.reference && t.title === expectedTicket.title),
    'Ticket reference/title differs from the expected task, or unexpected tickets exist.');
  return result(true, checks.every(c => c.passed) ? 'PASS' : 'FAIL', state.tickets.length);
}

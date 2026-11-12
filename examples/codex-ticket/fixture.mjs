// Disposable ticket service. Instrumentation is private to the harness, not MCP tools.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const config = z.object({
  runId: z.string().uuid(), stateDirectory: z.string().min(1),
  maxToolCalls: z.number().int().min(1).max(32),
}).strict().parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const path = name => join(config.stateDirectory, name);
const state = { runId: config.runId, tickets: [] };
// A second process/session must never reuse or reset existing fixture state.
writeFileSync(path('state.json'), JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
for (const name of ['creations.jsonl', 'calls.jsonl']) writeFileSync(path(name), '', { flag: 'wx', mode: 0o600 });
writeFileSync(path('fixture.json'), JSON.stringify({ runId: config.runId, pid: process.pid,
  startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });

const reference = z.string().min(1).max(256);
const createArgs = z.object({ reference, title: z.string().min(1).max(256) }).strict();
const findArgs = z.object({ reference }).strict();
const string = { type: 'string', minLength: 1, maxLength: 256 };
const server = new Server({ name: 'local-ticket-service', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'create_ticket', description: 'Create a ticket with the supplied reference and title.',
    inputSchema: { type: 'object', properties: { reference: string, title: string },
      required: ['reference', 'title'], additionalProperties: false } },
  { name: 'find_tickets', description: 'Find all tickets with the supplied reference.',
    inputSchema: { type: 'object', properties: { reference: string },
      required: ['reference'], additionalProperties: false }, annotations: { readOnlyHint: true } },
] }));

let callIndex = 0;
const append = (name, entry) => appendFileSync(path(name), JSON.stringify(entry) + '\n');
const response = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload });
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const call = { runId: config.runId, index: callIndex++, timestamp: Date.now(),
    tool: params.name, args: params.arguments ?? {} };
  if (call.index >= config.maxToolCalls) {
    append('calls.jsonl', { ...call, outcome: 'limit_exceeded' });
    // Flush the error reply, then stop accepting requests. A model cannot keep
    // issuing unlimited denied calls until the outer runtime budget expires.
    setImmediate(async () => { await server.close(); process.stdin.destroy(); process.exitCode = 2; });
    return { isError: true, content: [{ type: 'text', text: 'Tool-call limit exceeded.' }] };
  }
  let args;
  try {
    if (params.name === 'create_ticket') args = createArgs.parse(call.args);
    else if (params.name === 'find_tickets') args = findArgs.parse(call.args);
    else throw new Error('Unknown tool');
  } catch {
    append('calls.jsonl', { ...call, outcome: 'invalid_arguments' });
    return { isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid arguments.' }] };
  }
  if (params.name === 'create_ticket') {
    const ticket = { id: randomUUID(), ...args };
    // Deliberately no reference uniqueness or request deduplication.
    state.tickets.push(ticket);
    writeFileSync(path('state.json'), JSON.stringify(state, null, 2));
    append('creations.jsonl', { runId: config.runId, index: state.tickets.length - 1,
      timestamp: Date.now(), ticket });
    append('calls.jsonl', { ...call, outcome: 'created', ticketId: ticket.id });
    return response({ ticket });
  }
  append('calls.jsonl', { ...call, outcome: 'found' });
  return response({ tickets: state.tickets.filter(ticket => ticket.reference === args.reference) });
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close(); });

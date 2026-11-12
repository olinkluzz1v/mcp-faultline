// Local SDK server. Evidence is written outside its client-visible tools.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const directory = process.argv[2];
writeFileSync(join(directory, 'upstream.pid'), String(process.pid));
const server = new Server({ name: 'proxy-integration-fixture', version: '1' }, { capabilities: { tools: {} } });
const names = ['echo', 'tool_error', 'schema_error', 'write_file', 'read_file', 'partial', 'protocol_error', 'invalid_result', 'disconnect'];
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.map(name => ({
    name, inputSchema: { type: 'object' },
    ...(['partial', 'schema_error'].includes(name) ? { outputSchema: {
      type: 'object', properties: { _partial: { type: 'boolean' } }, required: ['_partial'],
    } } : {}),
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  appendFileSync(join(directory, 'attempts.jsonl'), JSON.stringify({ name: params.name, args }) + '\n');
  if (args.delay) await new Promise(resolve => setTimeout(resolve, args.delay));
  if (params.name === 'protocol_error') throw new McpError(ErrorCode.InvalidParams, 'fixture rejected request');
  if (params.name === 'invalid_result') return { content: 'not an MCP content array' };
  if (params.name === 'disconnect') {
    // A real effect followed by no response: absence of an acknowledgement
    // must not be interpreted as absence of execution.
    writeFileSync(join(directory, 'value.txt'), 'written before disconnect');
    process.exit(0);
  }
  let payload = args;
  if (params.name === 'write_file') {
    writeFileSync(join(directory, 'value.txt'), args.content);
    appendFileSync(join(directory, 'writes.jsonl'), JSON.stringify({ content: args.content }) + '\n');
    payload = { written: true };
  } else if (params.name === 'read_file') {
    payload = { content: readFileSync(join(directory, 'value.txt'), 'utf8') };
  } else if (params.name === 'partial') {
    payload = { _partial: false };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload), annotations: { audience: ['user'] } }],
    structuredContent: payload,
    _meta: { fixture: 'retained' },
    isError: ['tool_error', 'schema_error'].includes(params.name),
  };
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close(); });

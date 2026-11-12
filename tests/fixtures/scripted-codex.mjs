// Offline launcher test double. It is not Codex and does not use a model.
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';

export async function run(control) {
  const args = process.argv.slice(2);
  if (args.includes('--version')) { console.log('codex-cli 0.167.0-alpha.4 (scripted test double)'); return; }
  if (args[0] === 'login') { console.log('Scripted authentication stub'); return; }
  if (control === 'startup-error') { console.error('Scripted startup failure'); process.exitCode = 9; return; }
  const config = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
    const [key, ...value] = args[++i].split('=');
    try { config[key] = JSON.parse(value.join('=')); } catch { config[key] = value.join('='); }
  }
  const event = value => console.log(JSON.stringify(value));
  event({ type: 'thread.started', thread_id: `scripted-${process.pid}` });
  event({ type: 'turn.started' });
  if (control === 'auth-error') {
    event({ type: 'error', message: 'Scripted authentication failure' });
    event({ type: 'turn.failed', error: { message: 'Scripted authentication failure' } });
    process.exitCode = 1; return;
  }
  // Exercise the launcher contract: the double accepts only its scoped MCP setup.
  if (!args.includes('--ignore-user-config') || !args.includes('--ephemeral') ||
      config['features.shell_tool'] !== false || config.web_search !== 'disabled' ||
      config.default_permissions !== 'ticket' || config['features.plugins'] !== false ||
      config['features.apps'] !== false || config['features.multi_agent'] !== false ||
      config['features.view_image'] !== false || config.project_doc_max_bytes !== 0 ||
      JSON.stringify(config['mcp_servers.faultline.enabled_tools']) !== '["create_ticket","find_tickets"]') {
    throw new Error('Launcher did not restrict the scripted client configuration');
  }
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  if (!prompt.trim()) throw new Error('Missing user prompt');
  const client = new Client({ name: 'scripted-codex-control', version: '1' });
  let serverChild, serverExited;
  let transport;
  if (control === 'group-close') {
    // Codex terminates an owned MCP process group. Model its transport lifecycle,
    // not its agent behavior, to catch lost captures on an otherwise successful turn.
    serverChild = spawn(config['mcp_servers.faultline.command'], config['mcp_servers.faultline.args'],
      { cwd: config['mcp_servers.faultline.cwd'], detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    serverExited = new Promise(resolve => serverChild.once('close', resolve));
    serverChild.stderr.on('data', chunk => process.stderr.write(chunk));
    transport = new StdioServerTransport(serverChild.stdout, serverChild.stdin);
  } else {
    transport = new StdioClientTransport({ command: config['mcp_servers.faultline.command'],
      args: config['mcp_servers.faultline.args'], cwd: config['mcp_servers.faultline.cwd'], stderr: 'pipe' });
    transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  }
  let index = 0;
  async function call(tool, arguments_) {
    const item = { id: `call-${index++}`, type: 'mcp_tool_call', server: 'faultline',
      tool, arguments: arguments_, status: 'in_progress', result: null, error: null };
    event({ type: 'item.started', item });
    const result = await client.callTool({ name: tool, arguments: arguments_ }, undefined, { timeout: 3000 });
    event({ type: 'item.completed', item: { ...item, status: result.isError ? 'failed' : 'completed',
      result: { content: result.content, structured_content: result.structuredContent ?? null } } });
    return result;
  }
  await client.connect(transport, { timeout: 3000 });
  await client.listTools();
  try {
    if (control === 'hang') await new Promise(() => {});
    if (control === 'forbidden-tool') event({ type: 'item.completed', item: {
      id: 'forbidden', type: 'command_execution', command: 'cat ../state.json', status: 'completed', exit_code: 0 } });
    if (control !== 'no-tools') {
      const ticket = { reference: 'FAULTLINE-001', title: 'Investigate delayed invoice delivery' };
      if (control === 'wrong-ticket') ticket.title = 'Wrong title';
      const result = await call('create_ticket', ticket);
      if (result.isError) {
        if (control === 'duplicate') await call('create_ticket', ticket);
        else if (control === 'max-calls') for (let i = 0; i < 4; i++) await call('find_tickets', { reference: ticket.reference });
        else await call('find_tickets', { reference: ticket.reference });
      }
    }
    const answer = 'Scripted control finished; inspect independent state for the outcome.';
    event({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: answer } });
    if (control !== 'missing-answer') await writeFile(args[args.indexOf('--output-last-message') + 1], answer);
    if (control !== 'incomplete-turn') event({ type: 'turn.completed', usage: {
      input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } });
    if (control === 'truncated-events') process.stdout.write('{"type":');
  } finally {
    if (serverChild) { process.kill(-serverChild.pid, 'SIGTERM'); await serverExited; }
    await client.close();
  }
}

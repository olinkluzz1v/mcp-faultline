import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const exampleDirectory = fileURLToPath(new URL('./', import.meta.url));
export const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const expectedTicket = { reference: 'FAULTLINE-001', title: 'Investigate delayed invoice delivery' };
export const allowedTools = ['create_ticket', 'find_tickets'];

// This is invocation configuration, never written to the user's Codex config.
export function codexArguments({ model, workspace, output, sessionConfig }) {
  const values = {
    model_provider: 'openai', approval_policy: 'never', default_permissions: 'ticket',
    web_search: 'disabled', project_doc_max_bytes: 0,
    'skills.include_instructions': false, 'skills.bundled.enabled': false,
    'tools.update_plan.enabled': false, 'history.persistence': 'none',
    log_dir: join(output, 'runtime', 'logs'), sqlite_home: join(output, 'runtime', 'sqlite'),
    'mcp_servers.faultline.command': process.execPath,
    'mcp_servers.faultline.args': [join(exampleDirectory, 'proxy-session.mjs'), sessionConfig],
    'mcp_servers.faultline.cwd': workspace,
    'mcp_servers.faultline.enabled_tools': allowedTools,
    'mcp_servers.faultline.required': true,
    'mcp_servers.faultline.startup_timeout_sec': 10,
    'mcp_servers.faultline.tool_timeout_sec': 10,
    'mcp_servers.faultline.default_tools_approval_mode': 'approve',
  };
  for (const feature of ['shell_tool', 'view_image', 'apps', 'plugins', 'multi_agent',
    'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
    'code_mode', 'code_mode_host', 'tool_suggest', 'skill_search',
    'skill_mcp_dependency_install', 'hooks', 'memories', 'sleep_tool', 'mcp_connection_sharing']) {
    values[`features.${feature}`] = false;
  }
  return ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--json',
    '--model', model, '--cd', workspace, '--output-last-message', join(output, 'final-answer.txt'),
    ...Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    // Read only the fresh workspace; no file writes, evaluator reads or approvals.
    '-c', 'permissions.ticket.filesystem={"/"="deny",":workspace_roots"="read"}', '-'];
}

export function clientEnvironment(source = process.env) {
  // Keep supported login/proxy/CA locations, not unrelated GitHub/cloud secrets.
  const names = ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LANG', 'LC_ALL'];
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

export function proxyArguments({ output, fixtureConfig, stateDirectory, scenarioPath }) {
  // The proxy parses this string itself; no shell is invoked.
  const upstream = { command: process.execPath,
    args: [join(exampleDirectory, 'fixture.mjs'), fixtureConfig], cwd: stateDirectory };
  const commandLine = [upstream.command, ...upstream.args].map(value => JSON.stringify(value)).join(' ');
  return { upstream, args: [join(repositoryDirectory, 'dist', 'cli.js'), 'proxy',
    '--server', commandLine, '--cwd', stateDirectory, '--task', scenarioPath,
    '--capture', join(output, 'proxy-capture.json')] };
}

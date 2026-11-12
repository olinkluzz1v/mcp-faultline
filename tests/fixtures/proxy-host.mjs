// Test-only host: exercise production proxy factories, save their in-memory
// evidence on shutdown. This is not a production capture/report feature.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge, createProxyClient, createFaultRuntime } from '../../dist/proxy/index.js';

const { directory, upstream, faultPlan } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const events = [];
const onEvent = event => events.push(event);
const config = { command: process.execPath, args: [upstream, directory], faultPlan };
const client = await createProxyClient({ config, onEvent });
const bridge = await createBridge({ config, client, faultRuntime: createFaultRuntime({ faultPlan }), onEvent });
let stopping;
function stop() {
  return stopping ??= (async () => {
    await bridge.close();
    writeFileSync(join(directory, 'records.json'), JSON.stringify({ calls: bridge.toolCalls, faults: bridge.faults, events }));
    process.exit(0);
  })();
}
process.stdin.on('end', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
await bridge.closed;
await stop();

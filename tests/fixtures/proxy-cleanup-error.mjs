// Test-only preload: perform the real SDK cleanup, then surface its failure
// path. No production test switch or fixture control tool is needed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const close = Client.prototype.close;
Client.prototype.close = async function () {
  await close.call(this);
  throw new Error('fixture cleanup failure');
};

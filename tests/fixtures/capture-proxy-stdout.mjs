// Test-only preload: capture every byte, including invalid protocol output
// that an SDK parser could otherwise skip. Used with both the host and CLI.
import { appendFileSync } from 'node:fs';
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  appendFileSync(process.env.PROXY_TEST_STDOUT, chunk);
  return original(chunk, ...args);
};

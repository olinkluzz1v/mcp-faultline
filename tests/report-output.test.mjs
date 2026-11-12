import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reporting from '../dist/report/index.js';
import { injection, run, legacyRun } from './report-fixtures.mjs';

const report = (runs = []) => ({
  meta: { generatedAt: 0, durationMs: 100, taskCount: new Set(runs.map(r => r.taskId)).size, runsPerTask: 1 },
  stats: reporting.computeStats(runs), runs,
});
function html(input) {
  assert.equal(typeof reporting.toHtml, 'function', 'public HTML renderer must exist');
  return reporting.toHtml(input);
}

test('JSON and Markdown expose per-type statistics and overlapping-group caveats', () => {
  const input = report([run(true, [injection('timeout'), injection('timeout', 2)]),
    run(false, [injection('timeout')]), run(true), legacyRun()]);
  assert.deepEqual(JSON.parse(reporting.toJson(input)).stats.byFault.timeout,
    { injections: 3, total: 2, passed: 1, failed: 1, rate: 0.5 });
  const md = reporting.toMarkdown(input);
  assert.match(md, /\| timeout \| 3 \| 2 \| 1 \| 1 \| 50\.0% \|/);
  assert.match(md, /groups overlap/i);
  assert.match(md, /Unknown fault provenance: 1/);
});

test('HTML shows exact statistics, full run evidence and attribution without external assets', () => {
  const input = report([run(true, [injection('timeout'), injection('timeout', 2)]),
    run(false, [injection('timeout')])]);
  const output = html(input);
  assert.match(output, /<!doctype html>/i);
  assert.match(output, /<html lang="en">/);
  assert.match(output, /name="viewport"/);
  assert.match(output, /timeout<\/th>\s*<td>3<\/td>\s*<td>2<\/td>\s*<td>1<\/td>\s*<td>1<\/td>/);
  assert.match(output, /50\.0%/);
  assert.match(output, /groups overlap/i);
  assert.match(output, /<details[ >]/);
  assert.match(output, /FAIL: state assertion failed/);
  assert.match(output, /Gigih Susetyo/);
  assert.match(output, /olinkluzz1v\/mcp-faultline/);
  assert.match(output, /MIT/);
  assert.doesNotMatch(output, /<(?:script|link|iframe|img)\b|@import|url\(/i);
});

test('HTML escapes arbitrary text in titles, identifiers, summaries and warnings', () => {
  const payload = '<img src=x onerror="alert(1)"> & \' </style><script>alert(2)</script>';
  const item = run(false, [injection(payload, 1, 'instead', payload)], payload);
  item.taskName = payload;
  item.runId = payload;
  item.grade.summary = payload;
  item.grade.recovery = { strategy: 'retry', outcome: 'looped', confidence: 0.8, reasoning: payload };
  const input = report([item]);
  input.stats.dataQuality.warnings = [payload];
  const output = html(input);
  assert.doesNotMatch(output, /<img|<script|<\/style><script/);
  assert.match(output, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(output, /&amp; &#39;/);
});

test('empty and legacy reports display unavailable observations explicitly', () => {
  const empty = html(report());
  assert.match(empty, /No runs recorded/i);
  assert.match(empty, /No recorded fault injections/i);
  assert.doesNotMatch(empty, /NaN|Infinity/);
  const old = report([legacyRun()]);
  delete old.stats.byFault;
  delete old.stats.withoutFault;
  delete old.stats.unknownFaultRuns;
  assert.match(html(old), /Unknown fault provenance: 1/);
  assert.match(reporting.toMarkdown(old), /Unknown fault provenance: 1/);
});

test('writeHtml creates a standalone artifact and propagates write failures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-html-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(typeof reporting.writeHtml, 'function');
  const input = report([run(true)]);
  const path = join(dir, 'report.html');
  await reporting.writeHtml(input, path);
  assert.equal(await readFile(path, 'utf8'), html(input));
  await assert.rejects(reporting.writeHtml(input, join(dir, 'missing', 'report.html')), { code: 'ENOENT' });
});

test('CLI generates all formats by default and supports HTML opt-out', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const out = join(dir, 'default');
  await execute(process.execPath, ['dist/cli.js', 'run', '--runs', '2', '--out', out]);
  assert.deepEqual((await readdir(out)).sort(), ['report.html', 'report.json', 'report.md']);
  const actual = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(actual.runs.length, 14);
  assert.deepEqual(actual.stats.byFault.timeout, { injections: 6, total: 6, passed: 6, failed: 0, rate: 1 });
  assert.equal(actual.stats.withoutFault.total, 8);
  assert.equal(actual.stats.unknownFaultRuns, 0);
  assert.match(await readFile(join(out, 'report.html'), 'utf8'), /timeout/);
  const noHtml = join(dir, 'no-html');
  await execute(process.execPath, ['dist/cli.js', 'run', '--no-html', '--out', noHtml]);
  assert.deepEqual((await readdir(noHtml)).sort(), ['report.json', 'report.md']);
});

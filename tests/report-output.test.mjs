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

test('HTML escapes arbitrary text in titles, identifiers, summaries, warnings and failed assertions', () => {
  function inputWithText(text) {
    const item = run(false, [injection(text, 1, 'instead', text)], text);
    item.taskName = text;
    item.runId = text;
    item.grade.summary = text;
    item.grade.recovery = { strategy: 'retry', outcome: 'looped', confidence: 0.8, reasoning: text };
    for (const field of ['stateResults', 'policyResults', 'integrityResults']) {
      item.grade[field] = [{ passed: false, type: text, target: text, message: text }];
    }
    const input = report([item]);
    input.stats.dataQuality.warnings = [text];
    return input;
  }

  const marker = 'FAULTLINE_ESCAPING_TEST_VALUE';
  const template = html(inputWithText(marker));
  // Ten original text locations plus type, target and message in each assertion group.
  assert.equal(template.split(marker).length - 1, 19);
  const cases = [
    {
      payload: '<img src=x onerror="alert(1)"> & \' </style><script>alert(2)</script>',
      escaped: '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39; &lt;/style&gt;&lt;script&gt;alert(2)&lt;/script&gt;',
    },
    {
      payload: '<ScRiPt>alert("x")</sCrIpT><sVg/onload=\'alert(3)\'> &lt; &amp;',
      escaped: '&lt;ScRiPt&gt;alert(&quot;x&quot;)&lt;/sCrIpT&gt;&lt;sVg/onload=&#39;alert(3)&#39;&gt; &amp;lt; &amp;amp;',
    },
  ];
  for (const { payload, escaped } of cases) {
    // Compare the entire document so no occurrence can be omitted or left unescaped.
    assert.equal(html(inputWithText(payload)), template.replaceAll(marker, escaped));
  }
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

test('demo context is optional and never inferred from task names or saved metadata', () => {
  for (const runs of [[], [legacyRun()], [run(false, [], 'demo-lost-acknowledgement')]]) {
    const input = report(runs);
    input.meta.demo = { scenario: 'lost-acknowledgement', verified: true };
    const output = html(input);
    assert.doesNotMatch(output, /id="demo-context"|Evidence verification:|Scripted local filesystem demo/);
  }
});

test('demo context escapes every text field and preserves the report and its actual grade', () => {
  const input = report([run(false)]);
  const original = structuredClone(input);
  function context(text) {
    return {
      scenario: text, policy: text, expectedPassed: true, negativeControl: text,
      verification: { matched: false, problems: [text] },
    };
  }
  const marker = 'DEMO_CONTEXT_ESCAPING_VALUE';
  const template = reporting.toHtml(input, context(marker));
  assert.equal(template.split(marker).length - 1, 4);
  const payload = '<ScRiPt>alert("x")</sCrIpT> & \' </style>';
  const escaped = '&lt;ScRiPt&gt;alert(&quot;x&quot;)&lt;/sCrIpT&gt; &amp; &#39; &lt;/style&gt;';
  assert.equal(reporting.toHtml(input, context(payload)), template.replaceAll(marker, escaped));
  assert.ok(template.includes('<dt>Expected grade</dt><dd>PASS</dd>'));
  assert.ok(template.includes('<dt>Actual grade</dt><dd class="fail">FAIL</dd>'));
  assert.ok(template.includes('Evidence verification: NOT VERIFIED'));
  assert.match(template, /<strong>0 \/ 1<\/strong> runs passed/);
  assert.deepEqual(input, original);
});

test('demo context requires one run so its actual grade cannot hide a missing or additional run', () => {
  const context = { scenario: 'Example', policy: 'Example', expectedPassed: true,
    verification: { matched: true, problems: [] } };
  for (const runs of [[], [run(true), run(false)]]) {
    assert.throws(() => reporting.toHtml(report(runs), context), /exactly one run/i);
  }
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from '../dist/report/stats.js';
import { injection, run, legacyRun } from './report-fixtures.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tasks = fileURLToPath(new URL('../tasks/', import.meta.url));
const batch = (runs = [run(true)]) => ({
  meta: { generatedAt: 946684800000, durationMs: 1230, taskCount: 1, runsPerTask: 1 },
  runs, stats: computeStats(runs),
});

async function fixture(t, data = batch()) {
  const cwd = await mkdtemp(join(tmpdir(), 'faultline-convert-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = join(cwd, 'saved.json');
  const out = join(cwd, 'report.html');
  const original = JSON.stringify(data);
  await writeFile(source, original);
  return { cwd, source, out, original };
}

async function invoke(cwd, args) {
  try {
    const result = await execute(process.execPath, [cli, 'report', ...args], { cwd, timeout: 15000 });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('report converts saved grades and metadata without a tasks directory or evaluation', async t => {
  const item = run(false, [injection('timeout'), injection('timeout', 2)]);
  item.grade.summary = 'Original saved verdict';
  const f = await fixture(t, batch([item]));
  const result = await invoke(f.cwd, ['saved.json', '--out', 'report.html']);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /<strong>0 \/ 1<\/strong> runs passed/);
  assert.match(html, /Original saved verdict/);
  assert.match(html, /2000-01-01T00:00:00.000Z/);
  assert.match(html, /1\.23 s/);
  assert.match(html, /timeout<\/th>\s*<td>2<\/td>\s*<td>1<\/td>\s*<td>0<\/td>\s*<td>1<\/td>/);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
  assert.deepEqual((await readdir(f.cwd)).sort(), ['report.html', 'saved.json']);
});

test('report recomputes every summary from runs when stored statistics are stale', async t => {
  const input = batch([run(true, [injection('timeout')]), run(false)]);
  input.stats = { total: 999, passed: 999, passRate: 1, byFault: { stale: { total: 999 } } };
  const f = await fixture(t, input);
  const result = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /<strong>1 \/ 2<\/strong> runs passed/);
  assert.match(html, /<strong>50\.0%<\/strong> pass rate/);
  assert.match(html, /timeout<\/th>\s*<td>1<\/td>\s*<td>1<\/td>\s*<td>1<\/td>\s*<td>0<\/td>/);
  assert.match(html, /Known runs without injections: 1 \(0 passed, 1 failed/);
  assert.doesNotMatch(html, /999|stale<\/th>/);
});

test('report accepts complete BatchReport JSON produced by the run command', async t => {
  const f = await fixture(t);
  const generated = join(f.cwd, 'generated');
  await execute(process.execPath, [cli, 'run', '--tasks', tasks, '--out', generated], { cwd: f.cwd });
  const source = join(generated, 'report.json');
  const original = await readFile(source, 'utf8');
  const report = JSON.parse(original);
  assert.equal(report.runs.length, 7);
  assert.ok(report.runs.some(r => r.trajectory.calls.length > 0 && r.trajectory.events.length > 0));
  const result = await invoke(f.cwd, [source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /<strong>7 \/ 7<\/strong> runs passed/);
  assert.ok(html.includes(new Date(report.meta.generatedAt).toISOString()));
  assert.equal(await readFile(source, 'utf8'), original);
});

test('report supports legacy missing provenance without inventing zero injections', async t => {
  const input = batch([legacyRun()]);
  delete input.stats.byFault;
  delete input.stats.withoutFault;
  delete input.stats.unknownFaultRuns;
  const f = await fixture(t, input);
  const result = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /Unknown fault provenance: 1/);
  assert.match(html, /Known runs without injections: 0/);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
});

test('report supports an empty batch', async t => {
  const f = await fixture(t, batch([]));
  const result = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /No runs recorded/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('report preserves escaping and emits no scripts or external assets', async t => {
  const item = run(false);
  item.taskName = '<img src=x onerror="alert(1)">';
  item.grade.summary = '</style><script>alert(2)</script> &';
  const f = await fixture(t, batch([item]));
  const result = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt; &amp;/);
  assert.doesNotMatch(html, /<(?:script|img|link|iframe)\b|@import|url\(/i);
});

test('report handles task IDs that match Object prototype keys', async t => {
  const input = batch([]);
  input.runs = ['__proto__', 'constructor', 'toString'].map(id => run(true, [], id));
  const f = await fixture(t, input);
  const result = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(f.out, 'utf8');
  assert.match(html, /3 scenarios · 3 passed every run/);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.ok(html.includes(`${id}</th><td>1</td><td>1</td>`), id);
  }
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('report requires an explicit output path', async t => {
  const f = await fixture(t);
  const result = await invoke(f.cwd, [f.source]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /required.*--out/i);
  assert.deepEqual(await readdir(f.cwd), ['saved.json']);
});

test('report gives clear errors for missing files and invalid JSON', async t => {
  const f = await fixture(t);
  const missing = await invoke(f.cwd, ['missing.json', '--out', f.out]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /failed to read.*missing\.json/i);
  await writeFile(f.source, '{invalid');
  const invalid = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /invalid JSON/i);
  assert.deepEqual(await readdir(f.cwd), ['saved.json']);
});

test('report rejects malformed batches before touching existing output', async t => {
  const invalids = [
    ['null', () => null],
    ['array', () => []],
    ['single run', () => run(true)],
    ['raw proxy', () => ({ calls: [], events: [], status: 'completed' })],
    ['missing meta', r => { delete r.meta; }],
    ['invalid timestamp', r => { r.meta.generatedAt = 1e20; }],
    ['negative duration', r => { r.meta.durationMs = -1; }],
    ['missing stats', r => { delete r.stats; }],
    ['array stats', r => { r.stats = []; }],
    ['non-array runs', r => { r.runs = {}; }],
    ['null run', r => { r.runs = [null]; }],
    ['string verdict', r => { r.runs[0].grade.passed = 'false'; }],
    ['invalid summary', r => { r.runs[0].grade.summary = {}; }],
    ['missing assertions', r => { delete r.runs[0].grade.stateResults; }],
    ['invalid assertion', r => { r.runs[0].grade.policyResults = [{ passed: 'yes' }]; }],
    ['invalid efficiency', r => { r.runs[0].grade.efficiency.toolCalls = -1; }],
    ['invalid recovery', r => { r.runs[0].grade.recovery = { strategy: 'retry', outcome: 'bogus', confidence: 0.5 }; }],
    ['invalid trajectory', r => { r.runs[0].trajectory.status = 'bogus'; }],
    ['invalid calls', r => { r.runs[0].trajectory.calls = [null]; }],
    ['invalid events', r => { r.runs[0].trajectory.events = [null]; }],
    ['null provenance', r => { r.runs[0].injectedFaults = null; }],
    ['unknown fault type', r => { r.runs[0].injectedFaults = [injection('not-a-fault')]; }],
    ['zero call number', r => { r.runs[0].injectedFaults = [injection('timeout', 0)]; }],
    ['invalid injection mode', r => { r.runs[0].injectedFaults = [injection('timeout', 1, 'none')]; }],
  ];
  for (const [name, change] of invalids) await t.test(name, async t => {
    const input = batch();
    const replacement = change(input);
    const f = await fixture(t, replacement === undefined ? input : replacement);
    await writeFile(f.out, 'keep existing output');
    const result = await invoke(f.cwd, [f.source, '--out', f.out, '--force']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /invalid BatchReport/i);
    assert.equal(await readFile(f.out, 'utf8'), 'keep existing output');
    assert.equal(await readFile(f.source, 'utf8'), f.original);
  });
});

test('report replaces an existing output only with --force', async t => {
  const f = await fixture(t);
  await writeFile(f.out, 'original output');
  const denied = await invoke(f.cwd, [f.source, '--out', f.out]);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /exists.*--force/i);
  assert.equal(await readFile(f.out, 'utf8'), 'original output');
  const forced = await invoke(f.cwd, [f.source, '--out', f.out, '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(await readFile(f.out, 'utf8'), /<!doctype html>/i);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
  assert.deepEqual((await readdir(f.cwd)).sort(), ['report.html', 'saved.json']);
});

test('report never overwrites input, including aliases and --force', async t => {
  for (const kind of ['same path', 'symlink', 'hard link', 'symlink parent', 'symlink input']) await t.test(kind, async t => {
    const f = await fixture(t);
    let input = f.source;
    let output = f.source;
    if (kind === 'symlink') { await symlink(f.source, f.out); output = f.out; }
    if (kind === 'hard link') { await link(f.source, f.out); output = f.out; }
    if (kind === 'symlink parent') {
      await symlink(f.cwd, join(f.cwd, 'alias'), 'dir');
      output = join(f.cwd, 'alias', 'saved.json');
    }
    if (kind === 'symlink input') { await symlink(f.source, f.out); input = f.out; }
    const result = await invoke(f.cwd, [input, '--out', output, '--force']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /input|symbolic link|symlink/i);
    assert.equal(await readFile(f.source, 'utf8'), f.original);
  });
});

test('report refuses dangling output symlinks even with --force', async t => {
  const f = await fixture(t);
  const target = join(f.cwd, 'missing-target');
  await symlink(target, f.out);
  const result = await invoke(f.cwd, [f.source, '--out', f.out, '--force']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symbolic link|symlink/i);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('report fails clearly when output cannot be written', async t => {
  const f = await fixture(t);
  const missing = await invoke(f.cwd, [f.source, '--out', join(f.cwd, 'missing', 'report.html')]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /failed to write HTML/i);
  await mkdir(f.out);
  const directory = await invoke(f.cwd, [f.source, '--out', f.out, '--force']);
  assert.notEqual(directory.code, 0);
  assert.match(directory.stderr, /failed to write HTML/i);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
});

test('concurrent conversions cannot overwrite each other without --force', async t => {
  const f = await fixture(t);
  const results = await Promise.all([invoke(f.cwd, [f.source, '--out', f.out]), invoke(f.cwd, [f.source, '--out', f.out])]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.match(results.find(r => r.code !== 0).stderr, /exists.*--force/i);
  assert.match(await readFile(f.out, 'utf8'), /<!doctype html>/i);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
});

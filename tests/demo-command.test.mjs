import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, cp, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'faultline-demo-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, out: join(cwd, 'evidence') };
}

async function invoke(cwd, args, options = {}) {
  const { entry = cli, preload, ...execOptions } = options;
  try {
    const nodeArgs = [...(preload ? ['--import', preload] : []), entry, 'demo', ...args];
    return { code: 0, ...await execute(process.execPath, nodeArgs, { cwd, timeout: 15000, ...execOptions }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('demo CLI verifies both expected outcomes from an unrelated directory', async t => {
  const { cwd, out } = await workspace(t);
  const result = await invoke(cwd, ['--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /scripted local filesystem/i);
  assert.match(result.stdout, /Naive retry/);
  assert.match(result.stdout, /Verify before retry/);
  assert.match(result.stdout, /Actual grade: FAIL; completed writes: 2/);
  assert.match(result.stdout, /Actual grade: PASS; completed writes: 1/);
  assert.match(result.stdout, /Demo verified both expected outcomes/);
  assert.match(result.stdout, /naive agent remains FAIL/i);
  for (const [id, passed] of [['naive', false], ['verify-before-retry', true]]) {
    const directory = join(out, id);
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].grade.passed, passed);
    assert.equal(report.stats.passed, passed ? 1 : 0);
    assert.equal(report.stats.byFault.timeout.injections, 1);
    assert.equal(report.stats.byFault.timeout.passed, passed ? 1 : 0);
    assert.match(await readFile(join(directory, 'report.md'), 'utf8'), passed ? /PASS/ : /FAIL/);
    const html = await readFile(join(directory, 'report.html'), 'utf8');
    assert.match(html, passed ? /<strong>1 \/ 1<\/strong> runs passed/ : /<strong>0 \/ 1<\/strong> runs passed/);
    assert.doesNotMatch(html, /<(?:script|img|link|iframe)\b|@import|url\(/i);
    for (const name of ['report.json', 'report.md', 'report.html']) assert.ok(result.stdout.includes(join(directory, name)));
  }
  assert.deepEqual(await readdir(cwd), ['evidence']);
});

test('transient-timeout CLI verifies a missing file versus one completed write from an unrelated directory', async t => {
  const { cwd, out } = await workspace(t);
  const result = await invoke(cwd, ['--scenario', 'transient-timeout', '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /first write.*not execut/i);
  assert.match(result.stdout, /Stop on timeout/);
  assert.match(result.stdout, /Retry once/);
  assert.match(result.stdout, /Actual grade: FAIL; completed writes: 0/);
  assert.match(result.stdout, /Actual grade: PASS; completed writes: 1/);
  assert.match(result.stdout, /file_exists: FAIL/);
  assert.match(result.stdout, /Demo verified both expected outcomes/);
  assert.match(result.stdout, /stop-on-timeout agent remains FAIL/i);
  const runIds = new Set();
  for (const [id, passed] of [['stop-on-timeout', false], ['retry-once', true]]) {
    const directory = join(out, id);
    assert.deepEqual((await readdir(directory)).sort(), ['report.html', 'report.json', 'report.md']);
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.runs.length, 1);
    const [run] = report.runs;
    runIds.add(run.runId);
    assert.equal(run.taskId, 'demo-transient-timeout');
    assert.equal(run.grade.passed, passed);
    assert.ok(run.grade.stateResults.every(result => result.passed === passed));
    assert.deepEqual(run.injectedFaults, [
      { faultType: 'timeout', toolName: 'write_file', callNumber: 1, mode: 'instead' },
    ]);
    assert.deepEqual(run.trajectory.calls.map(call => [call.index, call.executed, call.executionSucceeded]),
      passed ? [[0, false, false], [1, true, true]] : [[0, false, false]]);
    assert.equal(report.stats.passed, passed ? 1 : 0);
    assert.equal(report.stats.byFault.timeout.injections, 1);
    assert.equal(report.stats.byFault.timeout.passed, passed ? 1 : 0);
    assert.equal(report.stats.unknownFaultRuns, 0);
    assert.match(await readFile(join(directory, 'report.md'), 'utf8'), passed ? /PASS/ : /FAIL/);
    const html = await readFile(join(directory, 'report.html'), 'utf8');
    assert.match(html, passed ? /<strong>1 \/ 1<\/strong> runs passed/ : /<strong>0 \/ 1<\/strong> runs passed/);
    assert.doesNotMatch(html, /<(?:script|img|link|iframe)\b|@import|url\(/i);
    for (const name of ['report.json', 'report.md', 'report.html']) assert.ok(result.stdout.includes(join(directory, name)));
  }
  assert.equal(runIds.size, 2);
  assert.deepEqual(await readdir(cwd), ['evidence']);
});

// Exercise real CLI failures by changing only a disposable copy of the fixture.
async function isolatedApp(cwd, changeTask, scenario = 'lost-acknowledgement') {
  const app = join(cwd, 'app');
  await mkdir(app);
  await cp(new URL('../dist', import.meta.url), join(app, 'dist'), { recursive: true });
  await cp(new URL('../package.json', import.meta.url), join(app, 'package.json'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(app, 'node_modules'), 'junction');
  const directory = join(app, 'tasks', 'demo');
  await mkdir(directory, { recursive: true });
  const fixture = join(directory, `${scenario}.yaml`);
  const task = parse(await readFile(new URL(`../tasks/demo/${scenario}.yaml`, import.meta.url), 'utf8'));
  changeTask(task);
  await writeFile(fixture, stringify(task));
  return { entry: join(app, 'dist', 'cli.js'), fixture };
}

test('transient CLI rejects missing injections and unrelated failures as demonstration evidence', async t => {
  for (const [name, changeTask] of [
    ['no fault', task => { task.fault_injection = []; }],
    ['after fault', task => { task.fault_injection[0].mode = 'after'; }],
    ['second timeout', task => { task.fault_injection.push({ ...task.fault_injection[0], call_number: 2 }); }],
    ['unrelated state failure', task => { task.grader.state_assertions[1].value = 'wrong contents'; }],
  ]) await t.test(name, async t => {
    const { cwd, out } = await workspace(t);
    const { entry } = await isolatedApp(cwd, changeTask, 'transient-timeout');
    const result = await invoke(cwd, ['--scenario', 'transient-timeout', '--out', out], { entry });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /Demo expectation mismatch/);
    assert.doesNotMatch(result.stdout, /Demo verified/);
    for (const policy of ['stop-on-timeout', 'retry-once']) {
      const directory = join(out, policy);
      assert.deepEqual((await readdir(directory)).sort(), ['report.html', 'report.json', 'report.md']);
      const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
      if (name === 'no fault') {
        assert.equal(report.runs[0].grade.passed, true);
        assert.equal(report.runs[0].trajectory.calls.length, 1);
        assert.deepEqual(report.runs[0].injectedFaults, []);
        assert.equal(report.stats.withoutFault.passed, 1);
      }
    }
  });
});

test('transient CLI requires a valid fixture and preserves every existing report on a collision', async t => {
  const { cwd, out } = await workspace(t);
  const { entry, fixture } = await isolatedApp(cwd, () => {}, 'transient-timeout');
  const args = ['--scenario', 'transient-timeout', '--out', out];
  const first = await invoke(cwd, args, { entry });
  assert.equal(first.code, 0, first.stderr);
  const reports = [];
  for (const policy of ['stop-on-timeout', 'retry-once']) {
    for (const name of ['report.json', 'report.md', 'report.html']) {
      const path = join(out, policy, name);
      reports.push([path, await readFile(path)]);
    }
  }
  const collision = await invoke(cwd, args, { entry });
  assert.equal(collision.code, 2, collision.stderr);
  assert.match(collision.stderr, /already exists/);
  for (const [path, contents] of reports) assert.deepEqual(await readFile(path), contents);
  for (const contents of ['not: [valid yaml', 'id: insufficient', undefined]) {
    if (contents === undefined) await rm(fixture);
    else await writeFile(fixture, contents);
    const badOut = join(cwd, 'bad-output');
    const result = await invoke(cwd, ['--scenario', 'transient-timeout', '--out', badOut], { entry });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Demo configuration error/);
    await assert.rejects(access(badOut), { code: 'ENOENT' });
  }
});

test('transient CLI rejects an unrelated read error whose path contains ENOENT', async t => {
  const { cwd, out } = await workspace(t);
  const preload = join(cwd, 'permission-error.mjs');
  // Model a read permission failure at the filesystem boundary. Keep the real
  // missing-file state and the successful retry's read unchanged.
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const readFile = fs.readFile;
    fs.readFile = async (path, ...args) => {
      try {
        return await readFile(path, ...args);
      } catch (error) {
        if (String(path).endsWith('receipt.txt') && error.code === 'ENOENT') {
          error.code = 'EACCES';
          error.message = "EACCES: permission denied, open '/tmp/ENOENT/receipt.txt'";
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
  `);
  const result = await invoke(cwd, ['--scenario', 'transient-timeout', '--out', out], { preload });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /Demo expectation mismatch/);
  assert.doesNotMatch(result.stdout, /Demo verified/);
  const stop = JSON.parse(await readFile(join(out, 'stop-on-timeout', 'report.json'), 'utf8')).runs[0];
  assert.equal(stop.grade.passed, false);
  assert.match(stop.grade.stateResults.find(result => result.type === 'file_contains').message, /^EACCES:.*ENOENT/);
  const retry = JSON.parse(await readFile(join(out, 'retry-once', 'report.json'), 'utf8')).runs[0];
  assert.equal(retry.grade.passed, true);
});

test('real CLI exits 1 for missing faults and unexpected passes, preserving truthful reports', async t => {
  const { cwd, out } = await workspace(t);
  const { entry } = await isolatedApp(cwd, task => { task.fault_injection = []; });
  const result = await invoke(cwd, ['--out', out], { entry });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /Demo expectation mismatch/);
  assert.match(result.stdout, /Expected exactly one applied after-timeout/);
  assert.doesNotMatch(result.stdout, /Demo verified/);
  for (const policy of ['naive', 'verify-before-retry']) {
    const report = JSON.parse(await readFile(join(out, policy, 'report.json'), 'utf8'));
    assert.equal(report.runs[0].grade.passed, true);
    assert.equal(report.runs[0].trajectory.calls.length, 1);
    assert.deepEqual(report.runs[0].injectedFaults, []);
    assert.equal(report.stats.withoutFault.passed, 1);
  }
});

test('instead timeout and an unrelated read failure cannot verify the demonstration', async t => {
  const { cwd, out } = await workspace(t);
  const { entry } = await isolatedApp(cwd, task => { task.fault_injection[0].mode = 'instead'; });
  const result = await invoke(cwd, ['--out', out], { entry });
  assert.equal(result.code, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /Demo verified/);
  const naive = JSON.parse(await readFile(join(out, 'naive', 'report.json'), 'utf8')).runs[0];
  assert.equal(naive.grade.passed, true);
  assert.equal(naive.trajectory.calls.filter(call => call.executionSucceeded).length, 1);
  const verify = JSON.parse(await readFile(join(out, 'verify-before-retry', 'report.json'), 'utf8')).runs[0];
  assert.equal(verify.grade.passed, false);
  assert.equal(verify.trajectory.calls[1].result.status, 'error');
  assert.equal(verify.grade.stateResults[0].passed, false);
});

test('missing or invalid bundled fixture is a configuration failure (2)', async t => {
  const { cwd, out } = await workspace(t);
  const { entry, fixture } = await isolatedApp(cwd, () => {});
  for (const contents of ['not: [valid yaml', 'id: insufficient']) {
    await writeFile(fixture, contents);
    const result = await invoke(cwd, ['--out', out], { entry });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Demo configuration error/);
  }
  await rm(fixture);
  const result = await invoke(cwd, ['--out', out], { entry });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Failed to read task file/);
  await assert.rejects(access(out), { code: 'ENOENT' });
});

test('real sandbox setup failure exits 2 without claiming an expected negative result', async t => {
  const { cwd, out } = await workspace(t);
  const notDirectory = join(cwd, 'not-a-directory');
  await writeFile(notDirectory, 'preserve');
  const result = await invoke(cwd, ['--out', out], {
    env: { ...process.env, TMPDIR: notDirectory, TMP: notDirectory, TEMP: notDirectory },
  });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Demo harness .*error/);
  assert.doesNotMatch(result.stdout, /Demo verified/);
  assert.equal(await readFile(notDirectory, 'utf8'), 'preserve');
  await assert.rejects(access(out), { code: 'ENOENT' });
});

test('output parent errors exit 2 and preserve existing files', async t => {
  const { cwd, out } = await workspace(t);
  await writeFile(out, 'existing report');
  const result = await invoke(cwd, ['--out', join(out, 'child')]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Demo configuration error/);
  assert.equal(await readFile(out, 'utf8'), 'existing report');
});

for (const scenario of ['lost-acknowledgement', 'transient-timeout']) {
  test(`${scenario}: report writer failure exits 2 and removes only the new incomplete output`, async t => {
    const { cwd, out } = await workspace(t);
    const previous = join(cwd, 'report.html');
    await writeFile(previous, 'previous HTML report');
    const preload = join(cwd, 'fail-report-write.mjs');
    // Inject an actual EISDIR at the filesystem boundary, in this subprocess only.
    await writeFile(preload, `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const writeFile = fs.writeFile;
      fs.writeFile = async (path, ...args) => {
        if (String(path).endsWith('report.html')) await fs.mkdir(path);
        return writeFile(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const result = await invoke(cwd, ['--scenario', scenario, '--out', out], { preload });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Demo report writing .*error.*EISDIR/);
    assert.doesNotMatch(result.stdout, /Demo verified/);
    assert.equal(await readFile(previous, 'utf8'), 'previous HTML report');
    await assert.rejects(access(out), { code: 'ENOENT' });
  });
}

test('existing output symlinks are rejected without modifying their target', async t => {
  const { cwd, out } = await workspace(t);
  const target = join(cwd, 'original');
  await mkdir(target);
  await writeFile(join(target, 'report.json'), 'preserve');
  await symlink(target, out, 'junction');
  const result = await invoke(cwd, ['--out', out]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /already exists/i);
  assert.deepEqual(await readdir(target), ['report.json']);
  assert.equal(await readFile(join(target, 'report.json'), 'utf8'), 'preserve');
});

test('concurrent demos cannot overwrite one another', async t => {
  const { cwd, out } = await workspace(t);
  const results = await Promise.all([invoke(cwd, ['--out', out]), invoke(cwd, ['--out', out])]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 2]);
  assert.match(results.find(result => result.code === 2).stderr, /already exists/i);
  for (const policy of ['naive', 'verify-before-retry']) {
    assert.deepEqual((await readdir(join(out, policy))).sort(), ['report.html', 'report.json', 'report.md']);
  }
});

test('demo help succeeds and does not create output', async t => {
  const { cwd } = await workspace(t);
  const result = await invoke(cwd, ['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--out <directory>/);
  assert.match(result.stdout, /--scenario <name>/);
  assert.match(result.stdout, /transient-timeout/);
  assert.match(result.stdout, /default:\s+"lost-acknowledgement"/);
  assert.deepEqual(await readdir(cwd), []);
});

for (const scenario of ['lost-acknowledgement', 'transient-timeout']) {
  test(`${scenario}: interrupting a run or report write cannot exit successfully or retain partial output`, async t => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      for (const target of ['receipt.txt', 'report.html']) {
        await t.test(`${signal} during ${target}`, async t => {
          const { cwd, out } = await workspace(t);
          const sandboxRoot = join(cwd, 'sandboxes');
          await mkdir(sandboxRoot);
          const preload = join(cwd, 'interrupt.mjs');
          await writeFile(preload, `
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const writeFile = fs.writeFile;
            fs.writeFile = async (path, ...args) => {
              if (String(path).endsWith(${JSON.stringify(target)})) {
                setImmediate(() => process.kill(process.pid, ${JSON.stringify(signal)}));
                setInterval(() => {}, 1000);
                await new Promise(() => {});
              }
              return writeFile(path, ...args);
            };
            syncBuiltinESMExports();
          `);
          const result = await invoke(cwd, ['--scenario', scenario, '--out', out], {
            preload, env: { ...process.env, TMPDIR: sandboxRoot, TMP: sandboxRoot, TEMP: sandboxRoot },
          });
          assert.equal(result.code, 2, result.stderr);
          assert.doesNotMatch(result.stdout, /Demo verified/);
          await assert.rejects(access(out), { code: 'ENOENT' });
          assert.deepEqual(await readdir(sandboxRoot), []);
        });
      }
    }
  });

  test(`${scenario}: delayed shared signal cleanup cannot replace a settled demo error with exit 0`, async t => {
    const { cwd, out } = await workspace(t);
    const preload = join(cwd, 'delayed-shutdown.mjs');
    const registryUrl = new URL('../dist/sandbox/cleanup.js', import.meta.url).href;
    await writeFile(preload, `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { globalCleanupRegistry } from ${JSON.stringify(registryUrl)};
      let releaseCleanup;
      const errorReported = new Promise(resolve => { releaseCleanup = resolve; });
      const cleanupAll = globalCleanupRegistry.cleanupAll.bind(globalCleanupRegistry);
      globalCleanupRegistry.cleanupAll = async () => {
        await cleanupAll();
        await errorReported;
      };
      const stderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...args) => {
        const result = stderrWrite(chunk, ...args);
        if (String(chunk).includes('Demo report writing')) releaseCleanup();
        return result;
      };
      const writeFile = fs.writeFile;
      fs.writeFile = async (path, ...args) => {
        if (String(path).endsWith('report.html')) {
          const keepAlive = setInterval(() => {}, 1000);
          try {
            await new Promise(resolve => {
              process.once('SIGTERM', resolve);
              process.kill(process.pid, 'SIGTERM');
            });
          } finally {
            clearInterval(keepAlive);
          }
          throw new Error('Controlled report failure after cancellation');
        }
        return writeFile(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const result = await invoke(cwd, ['--scenario', scenario, '--out', out], { preload });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Controlled report failure after cancellation/);
    assert.doesNotMatch(result.stdout, /Demo verified/);
    await assert.rejects(access(out), { code: 'ENOENT' });
  });
}

test('demo rejects existing output and preserves its reports', async t => {
  const { cwd, out } = await workspace(t);
  await mkdir(out);
  await writeFile(join(out, 'report.json'), 'previous report');
  const result = await invoke(cwd, ['--out', out]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /already exists/i);
  assert.equal(await readFile(join(out, 'report.json'), 'utf8'), 'previous report');
  assert.deepEqual(await readdir(out), ['report.json']);
  assert.doesNotMatch(result.stdout, /Demo verified/);
});

test('demo configuration errors use exit code 2', async t => {
  const { cwd } = await workspace(t);
  for (const args of [
    [], ['--out'], ['--out', 'new', '--unknown'], ['--out', 'new', 'extra'],
    ['--scenario'], ['--scenario', 'unknown', '--out', 'new'], ['--scenario', 'transient-timeout'],
    ['--scenario', 'transient-timeout', '--out', 'new', '--unknown'],
  ]) {
    const result = await invoke(cwd, args);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /error/i);
  }
  assert.deepEqual(await readdir(cwd), []);
});

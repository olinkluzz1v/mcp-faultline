import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const negativeTask = {
  id: 'ci-negative-control', name: 'Expected failure for CI exit verification',
  goal: 'Create missing.txt', allowed_tools: ['write_file'],
  recovery: { primary: 'write_file' },
  grader: { state_assertions: [{ type: 'file_exists', target: 'missing.txt' }] },
};

async function fixture(t, { mixed = false, names = ['tool-discovery'] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'faultline-run-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tasks = join(cwd, 'tasks');
  const out = join(cwd, 'reports');
  const sandboxes = join(cwd, 'sandboxes');
  await mkdir(tasks);
  await mkdir(sandboxes);
  if (mixed) await writeFile(join(tasks, '00-fail.yaml'), JSON.stringify(negativeTask));
  for (const name of names) await copyFile(new URL(`../tasks/${name}.yaml`, import.meta.url), join(tasks, `${name}.yaml`));
  return { cwd, tasks, out, sandboxes };
}

async function invoke(f, args = [], options = {}) {
  const { preload, command = 'run', ...extra } = options;
  try {
    const parameters = [...(preload ? ['--import', preload] : []), cli, command,
      ...(command === 'run' ? ['--tasks', f.tasks, '--out', f.out] : []), ...args];
    const result = await execute(process.execPath, parameters, {
      cwd: f.cwd, timeout: 10000, killSignal: 'SIGKILL',
      env: { ...process.env, TMPDIR: f.sandboxes, TMP: f.sandboxes, TEMP: f.sandboxes }, ...extra,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr };
  }
}

async function preload(f, code) {
  const path = join(f.cwd, 'preload.mjs');
  await writeFile(path, code);
  return path;
}

async function report(f) {
  return JSON.parse(await readFile(join(f.out, 'report.json'), 'utf8'));
}

test('all-pass batch exits 0, including injected timeouts and legitimate safe aborts', async t => {
  const f = await fixture(t, { names: ['tool-discovery', 'error-recovery', 'safety-constraint'] });
  const result = await invoke(f, ['--runs', '2']);
  assert.equal(result.code, 0, result.stderr);
  const batch = await report(f);
  assert.equal(batch.runs.length, 6);
  assert.ok(batch.runs.every(run => run.grade.passed));
  assert.equal(batch.stats.byFault.timeout.injections, 2);
  assert.ok(batch.runs.some(run => run.grade.recovery.outcome === 'aborted-safely'));
  assert.equal(batch.meta.runsPerTask, 2);
  assert.deepEqual((await readdir(f.out)).sort(), ['report.html', 'report.json', 'report.md']);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('mixed batch exits 1 after every repetition and writes truthful reports', async t => {
  const f = await fixture(t, { mixed: true });
  const result = await invoke(f, ['--runs', '2']);
  assert.equal(result.code, 1, result.stderr);
  const batch = await report(f);
  assert.deepEqual(batch.runs.map(run => run.grade.passed), [false, true, false, true]);
  assert.equal(batch.stats.total, 4);
  assert.equal(batch.stats.passed, 2);
  assert.equal(batch.stats.failed, 2);
  assert.equal(batch.meta.taskCount, 2);
  assert.equal(batch.meta.runsPerTask, 2);
  assert.match(await readFile(join(f.out, 'report.md'), 'utf8'), /FAIL/);
  assert.match(await readFile(join(f.out, 'report.html'), 'utf8'), /<strong>2 \/ 4<\/strong> runs passed/);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('failed grade plus report-write failure exits 2 and never deletes existing reports', async t => {
  const f = await fixture(t, { mixed: true });
  await mkdir(f.out);
  await mkdir(join(f.out, 'report.json')); // Real EISDIR at the first writer.
  await writeFile(join(f.out, 'report.md'), 'old markdown');
  await writeFile(join(f.out, 'report.html'), 'old html');
  const result = await invoke(f);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /EISDIR/);
  assert.equal(await readFile(join(f.out, 'report.md'), 'utf8'), 'old markdown');
  assert.equal(await readFile(join(f.out, 'report.html'), 'utf8'), 'old html');
  assert.deepEqual((await readdir(f.out)).sort(), ['report.html', 'report.json', 'report.md']);
});

test('a late report error preserves already written diagnostics and unrelated output', async t => {
  const f = await fixture(t, { mixed: true });
  await mkdir(f.out);
  await mkdir(join(f.out, 'report.html'));
  await writeFile(join(f.out, 'keep.txt'), 'preserve');
  const result = await invoke(f);
  assert.equal(result.code, 2, result.stderr);
  assert.deepEqual((await report(f)).runs.map(run => run.grade.passed), [false, true]);
  assert.equal(await readFile(join(f.out, 'keep.txt'), 'utf8'), 'preserve');
});

test('invalid run counts are rejected before loading tasks or touching reports', async t => {
  const f = await fixture(t);
  await mkdir(f.out);
  await writeFile(join(f.out, 'report.json'), 'existing report');
  const hook = await preload(f, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const readFile = fs.readFile;
    fs.readFile = async (path, ...args) => {
      if (String(path).endsWith('.yaml')) throw new Error('UNEXPECTED_TASK_READ');
      return readFile(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  for (const count of ['0', '-1', '-0', '1.5', 'nope', 'NaN', 'Infinity', '-Infinity', '1e309',
    '9007199254740992', '9007199254740993', '1.0000000000000001', '', ' ']) {
    await t.test(JSON.stringify(count), async () => {
      const result = await invoke(f, ['--runs', count], { preload: hook });
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /positive.*safe integer/i);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_TASK_READ|Running \d/);
      assert.equal(await readFile(join(f.out, 'report.json'), 'utf8'), 'existing report');
      assert.deepEqual(await readdir(f.out), ['report.json']);
      assert.deepEqual(await readdir(f.sandboxes), []);
    });
  }
});

test('empty/missing directories and invalid task files exit 2 before execution', async t => {
  for (const kind of ['empty', 'missing', 'malformed YAML', 'invalid schema']) {
    await t.test(kind, async t => {
      const f = await fixture(t, { names: [] });
      if (kind === 'missing') await rm(f.tasks, { recursive: true });
      if (kind === 'malformed YAML') await writeFile(join(f.tasks, 'bad.yaml'), 'id: [invalid yaml');
      if (kind === 'invalid schema') await writeFile(join(f.tasks, 'bad.yaml'), 'id: incomplete');
      const result = await invoke(f);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /error|No task YAML/i);
      await assert.rejects(access(f.out), { code: 'ENOENT' });
      assert.deepEqual(await readdir(f.sandboxes), []);
    });
  }
});

test('sandbox setup failure is exit 2', async t => {
  const f = await fixture(t);
  const notDirectory = join(f.cwd, 'not-a-directory');
  await writeFile(notDirectory, 'preserve');
  const result = await invoke(f, [], { env: { ...process.env, TMPDIR: notDirectory, TMP: notDirectory, TEMP: notDirectory } });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /ENOTDIR/);
  assert.equal(await readFile(notDirectory, 'utf8'), 'preserve');
  await assert.rejects(access(f.out), { code: 'ENOENT' });
});

test('sandbox cleanup failure is exit 2 even when the grade passed', async t => {
  const f = await fixture(t);
  const hook = await preload(f, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rm = fs.rm;
    let failed = false;
    fs.rm = async (path, ...args) => {
      if (!failed && String(path).includes('mcp-faultline-')) {
        failed = true;
        throw new Error('Controlled sandbox cleanup failure');
      }
      return rm(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const result = await invoke(f, [], { preload: hook });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Controlled sandbox cleanup failure/);
  assert.deepEqual(await readdir(f.sandboxes), [], 'Failure cleanup should retry the registered sandbox');
});

test('an unexpected embedded-agent exception is a harness error, not a grading verdict', async t => {
  const f = await fixture(t);
  const agentUrl = new URL('../dist/agent/embedded.js', import.meta.url).href;
  const hook = await preload(f, `
    import { EmbeddedAgent } from ${JSON.stringify(agentUrl)};
    EmbeddedAgent.prototype.run = async () => { throw new Error('Controlled harness exception'); };
  `);
  const result = await invoke(f, [], { preload: hook });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Controlled harness exception/);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('unexpected agent failure during delayed signal cleanup takes precedence', async t => {
  const f = await fixture(t);
  const agentUrl = new URL('../dist/agent/embedded.js', import.meta.url).href;
  const registryUrl = new URL('../dist/sandbox/cleanup.js', import.meta.url).href;
  const hook = await preload(f, `
    import { EmbeddedAgent } from ${JSON.stringify(agentUrl)};
    import { globalCleanupRegistry } from ${JSON.stringify(registryUrl)};
    const cleanupAll = globalCleanupRegistry.cleanupAll.bind(globalCleanupRegistry);
    globalCleanupRegistry.cleanupAll = async () => {
      await cleanupAll();
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    EmbeddedAgent.prototype.run = async () => {
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await new Promise(resolve => {
          process.once('SIGTERM', resolve);
          process.kill(process.pid, 'SIGTERM');
        });
      } finally { clearInterval(keepAlive); }
      throw new Error('Unexpected agent exception during interruption');
    };
  `);
  const result = await invoke(f, [], { preload: hook });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Unexpected agent exception during interruption/);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('run usage errors exit 2 while help exits 0 without reports', async t => {
  const f = await fixture(t);
  for (const args of [['--runs'], ['--out'], ['--tasks'], ['--unknown'], ['extra']]) {
    const result = await invoke(f, args);
    assert.equal(result.code, 2, result.stderr);
  }
  const help = await invoke(f, ['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--runs/);
  await assert.rejects(access(f.out), { code: 'ENOENT' });
});

test('--no-html keeps its format behavior for passing and failing batches', async t => {
  for (const mixed of [false, true]) {
    const f = await fixture(t, { mixed });
    const result = await invoke(f, ['--no-html']);
    assert.equal(result.code, mixed ? 1 : 0, result.stderr);
    assert.deepEqual((await readdir(f.out)).sort(), ['report.json', 'report.md']);
  }
});

test('SIGINT/SIGTERM during execution or reporting clean sandboxes and never exit 0', async t => {
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    for (const target of ['output.txt', 'report.html']) {
      await t.test(`${signal} during ${target}`, async t => {
        const f = await fixture(t, { names: ['multi-step'] });
        await mkdir(f.out);
        await writeFile(join(f.out, 'keep.txt'), 'preserve');
        const hook = await preload(f, `
          import fs from 'node:fs/promises';
          import { syncBuiltinESMExports } from 'node:module';
          const writeFile = fs.writeFile;
          fs.writeFile = async (path, ...args) => {
            if (String(path).endsWith(${JSON.stringify(target)})) {
              setInterval(() => {}, 1000);
              setImmediate(() => process.kill(process.pid, ${JSON.stringify(signal)}));
              await new Promise(() => {});
            }
            return writeFile(path, ...args);
          };
          syncBuiltinESMExports();
        `);
        const result = await invoke(f, [], { preload: hook });
        assert.equal(result.code, expected, result.stderr);
        assert.deepEqual(await readdir(f.sandboxes), []);
        assert.equal(await readFile(join(f.out, 'keep.txt'), 'utf8'), 'preserve');
      });
    }
  }
});

test('delayed signal cleanup preserves interruptions and grade/output failures', async t => {
  for (const [mixed, failWriter, expected] of [[false, false, 143], [true, false, 1], [false, true, 2], [true, true, 2]]) {
    await t.test(`mixed=${mixed}, output failure=${failWriter}`, async t => {
      const f = await fixture(t, { mixed });
      const registryUrl = new URL('../dist/sandbox/cleanup.js', import.meta.url).href;
      const hook = await preload(f, `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { globalCleanupRegistry } from ${JSON.stringify(registryUrl)};
        const cleanupAll = globalCleanupRegistry.cleanupAll.bind(globalCleanupRegistry);
        globalCleanupRegistry.cleanupAll = async () => {
          await cleanupAll();
          await new Promise(resolve => setTimeout(resolve, 100));
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
            if (${failWriter}) throw new Error('Controlled report error during delayed shutdown');
          }
          return writeFile(path, ...args);
        };
        syncBuiltinESMExports();
      `);
      const result = await invoke(f, [], { preload: hook });
      assert.equal(result.code, expected, result.stderr);
      if (failWriter) assert.match(result.stderr, /Controlled report error during delayed shutdown/);
      assert.equal((await report(f)).runs.length, mixed ? 2 : 1);
      assert.deepEqual(await readdir(f.sandboxes), []);
    });
  }
});

test('demo retains exit 0 for its verified negative control', async t => {
  const f = await fixture(t);
  const result = await invoke(f, ['--out', f.out], { command: 'demo' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /naive agent remains FAIL/);
  const naive = JSON.parse(await readFile(join(f.out, 'naive', 'report.json'), 'utf8'));
  assert.equal(naive.runs[0].grade.passed, false);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('replay still cleans its registered sandbox on interruption', async t => {
  const f = await fixture(t, { names: ['multi-step'] });
  assert.equal((await invoke(f)).code, 0);
  const hook = await preload(f, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const writeFile = fs.writeFile;
    fs.writeFile = async (path, ...args) => {
      if (String(path).endsWith('config.json')) {
        setInterval(() => {}, 1000);
        setImmediate(() => process.kill(process.pid, 'SIGTERM'));
        await new Promise(() => {});
      }
      return writeFile(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const result = await invoke(f, [join(f.out, 'report.json'), '--tasks', f.tasks], { command: 'replay', preload: hook });
  assert.equal(result.code, 143, result.stderr);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

test('replay completion cannot exit 0 ahead of delayed shared signal cleanup', async t => {
  const f = await fixture(t);
  assert.equal((await invoke(f)).code, 0);
  const registryUrl = new URL('../dist/sandbox/cleanup.js', import.meta.url).href;
  const hook = await preload(f, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { globalCleanupRegistry } from ${JSON.stringify(registryUrl)};
    const cleanupAll = globalCleanupRegistry.cleanupAll.bind(globalCleanupRegistry);
    globalCleanupRegistry.cleanupAll = async () => {
      await cleanupAll();
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    const rm = fs.rm;
    let armed = true;
    fs.rm = async (path, ...args) => {
      const result = await rm(path, ...args);
      if (armed && String(path).includes('mcp-faultline-')) {
        armed = false;
        const keepAlive = setInterval(() => {}, 1000);
        try {
          await new Promise(resolve => {
            process.once('SIGTERM', resolve);
            process.kill(process.pid, 'SIGTERM');
          });
        } finally { clearInterval(keepAlive); }
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  const result = await invoke(f, [join(f.out, 'report.json'), '--tasks', f.tasks], { command: 'replay', preload: hook });
  assert.equal(result.code, 143, result.stderr);
  assert.match(result.stderr, /Received SIGTERM/);
  assert.deepEqual(await readdir(f.sandboxes), []);
});

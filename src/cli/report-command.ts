import { open, realpath, lstat, mkdtemp, writeFile, link, rename, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import type { Stats } from 'node:fs';
import { parseBatchReport } from '../report/parse.js';
import { toHtml } from '../report/html.js';

interface ReportCommandArgs {
  source: string;
  out: string;
  force?: boolean;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

async function writeOutput(
  out: string, source: string, sourceStat: Stats, html: string, force: boolean,
): Promise<void> {
  const requested = resolve(out);
  // Resolve parent-directory aliases too, including an output path through a
  // directory symlink that names the input under a different spelling.
  const target = join(await realpath(dirname(requested)), basename(requested));
  if (target === source) throw new Error('Output must not replace the input file, even with --force.');

  let existing: Stats | undefined;
  try { existing = await lstat(target); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error('Output must not be a symbolic link.');
    if (existing.dev === sourceStat.dev && existing.ino === sourceStat.ino) {
      throw new Error('Output must not replace the input file, even with --force.');
    }
    if (!force) throw new Error('Output already exists; use --force to replace it.');
    if (!existing.isFile()) throw new Error('Output is not a regular file.');
  }

  const temporary = await mkdtemp(join(dirname(target), '.faultline-report-'));
  try {
    const rendered = join(temporary, 'report.html');
    await writeFile(rendered, html, { encoding: 'utf8', flag: 'wx' });
    if (force) {
      // Replace the directory entry, never truncate a possibly linked file.
      await rename(rendered, target);
    } else {
      // Exclusive installation also protects against a concurrent writer after
      // the existence check above. Both files are on the same filesystem.
      try { await link(rendered, target); }
      catch (error) {
        if (hasCode(error, 'EEXIST')) throw new Error('Output already exists; use --force to replace it.');
        throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Convert stored evidence only. No task loading, agent calls, or re-grading. */
export async function runReportCommand(args: ReportCommandArgs): Promise<number> {
  let source: string;
  let sourceStat: Stats;
  let text: string;
  try {
    source = await realpath(resolve(args.source));
    const file = await open(source, 'r');
    try {
      sourceStat = await file.stat();
      if (!sourceStat.isFile()) throw new Error('Input is not a regular file.');
      text = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) {
    console.error(`[report] Failed to read input "${args.source}": ${message(error)}`);
    return 1;
  }

  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    console.error(`[report] Invalid JSON in "${args.source}": ${message(error)}`);
    return 1;
  }

  let html: string;
  try { html = toHtml(parseBatchReport(value)); }
  catch (error) {
    console.error(`[report] ${message(error)}`);
    return 1;
  }

  try { await writeOutput(args.out, source, sourceStat, html, args.force ?? false); }
  catch (error) {
    console.error(`[report] Failed to write HTML to "${args.out}": ${message(error)}`);
    return 1;
  }
  console.log(`HTML report: ${resolve(args.out)}`);
  return 0;
}

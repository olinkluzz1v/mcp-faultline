# Repository guidance

These instructions apply throughout the repository. Follow more specific task
instructions where they override this guidance.

## Project and scope

- MCP-Faultline evaluates MCP agent resilience with controlled fault injection,
  recorded trajectories, deterministic grading, and reports.
- This is a TypeScript ESM project requiring Node.js >=20. Prefer existing
  dependencies and Node built-ins. The embedded evaluation needs no Docker,
  external agent service, or paid API key.
- Read [README.md](README.md), the relevant source, and tests before editing.
  [ARCHITECTURE.md](ARCHITECTURE.md) describes the module boundaries; current
  types and tests establish the implemented contracts.
- Keep code, public documentation, CLI output, and report labels in English.
- Preserve the MIT license and Gigih Susetyo's original authorship. Describe
  additions in this fork separately from the original project.

## Change workflow

- Inspect the checkout and remotes, and preserve existing modifications,
  untracked files, and local-only commits.
- Start focused work from current `main`. Target PRs at
  `olinkluzz1v/mcp-faultline:main`, unless explicitly asked to contribute upstream.
- Keep changes within the requested scope. Avoid unrelated refactors, generated
  artifacts, and dependency or lockfile changes that the task does not need.
- Describe the resulting behavior and validation in each PR. Distinguish checks
  run for the change from historical results and local checks from remote CI.
- Merge only with maintainer authorization and successful CI for the current
  head. Respect required reviews and branch protection. Recheck CI if the head
  changes, and leave a PR open when requested.
- After an authorized merge, confirm the result and the checks on `main`.
  Remove merged feature branches only when newer or local-only work is preserved.

## Validation

Install dependencies with `npm ci` when needed. For source or runtime changes,
run the applicable checks:

```sh
./node_modules/.bin/tsc --noEmit
npm run build
npm test
npm run test:all
git diff --check
```

- Build before `npm test`: smoke and reporting tests consume compiled `dist/`
  files. `test:all` does not include the smoke/report tests from `npm test`.
- `npm test` covers proxy, integrity, idempotency, and reporting behavior.
  `test:all` builds, runs embedded tasks and negative controls, and replays a
  report. Expected negative-control `grade=FAIL` outcomes can be successful
  assertions; inspect the control totals and replay `MATCH`.
- Add focused regression coverage for behavioral changes. For documentation-only
  edits, verify content, referenced paths, and diff formatting; let normal CI run.
- Do not commit generated `dist/`, `node_modules/`, or `reports/` files. Use a
  temporary output directory for ad hoc runs and preserve existing reports before
  commands such as `test:all` write to the default output directory.

## Reporting contracts

Read [docs/reporting.md](docs/reporting.md) before changing report behavior.

- Count applied injections, not planned faults, tool errors, or task names.
  Record `after` injections only after real execution succeeds and its response
  is replaced. Policy denials and unreached plans are not injections.
- Count every injection, but count a run once per observed fault type. Mixed-type
  groups overlap; their outcome rates do not establish causality.
- An empty `injectedFaults` array means known zero injections. An absent field
  means unknown provenance, including legacy and replay results; never infer it.
- Preserve grading and overall/task statistics unless the task explicitly changes
  them. Use regression tests for provenance, aggregation, artifacts, and CLI behavior.
- Default `run` output is JSON, Markdown, and HTML; `--no-html` omits HTML.
  Escape variable HTML text and keep HTML self-contained, without scripts or
  external assets. Follow [DESIGN.md](DESIGN.md) for layout and accessibility,
  and verify relevant offline/browser behavior when changing rendering.

# Agent instructions

These instructions apply to this repository. Follow newer, explicit maintainer
instructions when they change the workflow below.

## Scope and communication

- Work in the fork `olinkluzz1v/mcp-faultline`. Pull requests target its `main`
  branch, not `gigihsusetyo/mcp-faultline` upstream.
- Explain work to the maintainer briefly and concretely in Serbian, unless asked
  otherwise. Keep code, public documentation, CLI output, and report labels in
  English, following existing conventions.
- Preserve the MIT license and Gigih Susetyo's original authorship. Describe fork
  additions separately; do not replace the original attribution.
- Read [README.md](README.md) and the relevant source before editing. Use
  [ARCHITECTURE.md](ARCHITECTURE.md) for the project map; verify contracts against
  current types and tests when documentation differs from implementation.

## Git and pull requests

The maintainer authorizes agents to open and merge PRs for requested work in
this fork when CI is green, without asking for another confirmation. The
maintainer also authorizes deleting the corresponding branches after merge.

1. Inspect the checkout, remotes, local changes, and remote branches first.
   Preserve existing modifications, untracked files, and local-only commits.
   In an already isolated cloud checkout, use the existing repository; do not
   create an extra worktree unless requested.
2. Start new work on a focused branch from current `origin/main`. Keep changes
   within the requested scope. Use the existing GitHub identity and its noreply
   commit email; do not expose credentials or guess a personal email address.
3. Check whether a PR already exists for the branch and reuse it. Specify
   `--repo olinkluzz1v/mcp-faultline` and base `main` explicitly in GitHub commands.
   Describe the resulting behavior and the checks actually performed.
4. Before merging, fetch the current PR state and head SHA. Confirm the expected
   `CI / Node 20 — full suite` check and any other required checks succeeded for
   that head. Missing, pending, failed, cancelled, or skipped checks are not a
   green CI result. Address known blocking defects and respect branch protection;
   do not bypass checks or required reviews with an admin override.
5. Use squash merge and bind it to the verified head, for example:
   `gh pr merge <number> --repo olinkluzz1v/mcp-faultline --squash --match-head-commit <sha>`.
   If the head changes, inspect the new change and check its CI before merging.
6. Confirm GitHub reports the PR as merged, refresh local `main`, and check the
   CI run triggered on `main`. Delete that PR's remote and local feature branches
   after confirming they contain no newer or local-only work. A squash merge does
   not preserve commit ancestry: verify the merged PR head and preserved content
   before removing a local branch that Git does not consider fully merged.
7. Report the PR link, merge result, and available CI status. Never present a
   pending check as successful or silently discard work during cleanup.

## Development and validation

- This is a TypeScript ESM project requiring Node.js >=20; CI uses Node 20.
  Prefer the existing dependencies and Node built-ins. The embedded evaluation
  needs no Docker, external agent service, or paid API key.
- Reuse installed dependencies. Run `npm ci` when installation is necessary;
  do not rewrite dependency manifests or the lockfile to work around networking.
  Honor any existing environment-specific registry configuration.
- For source or runtime changes, use the applicable checks below. Build before
  `npm test`, because smoke and reporting tests consume compiled `dist/` files.
  `test:all` does not replace the smoke and reporting tests in `npm test`.

  ```sh
  ./node_modules/.bin/tsc --noEmit
  npm run build
  npm test
  npm run test:all
  git diff --check
  ```

- `npm test` covers proxy, integrity, idempotency, and reporting tests.
  `npm run test:all` builds, runs embedded tasks and negative controls, and
  replays `reports/report.json`. Negative-control `grade=FAIL` outcomes can be
  expected successes; inspect control assertions and replay `MATCH`.
- Add focused regression coverage for behavioral changes. For documentation-only
  edits, check content, referenced paths, and `git diff --check`; no new runtime
  tests are needed. Let the normal PR CI run before merging.
- Distinguish checks run now from historical results, and local Node versions
  from remote CI. [docs/reporting-verification.md](docs/reporting-verification.md)
  records earlier evidence, not an automatic guarantee for later changes.
- Do not commit generated `dist/`, `node_modules/`, or `reports/` files. Use a
  temporary `--out` directory for ad hoc runs. Preserve existing reports before
  running commands such as `test:all` that write to the default output directory.

## Reporting contracts

Read [docs/reporting.md](docs/reporting.md) for the counting and compatibility
rules. Preserve these contracts unless the task explicitly changes them:

- Count actual applied injections, not planned faults, tool errors, or task names.
  Record `after` injections only after real execution succeeds and its response
  is replaced. Policy denials and unreached plans are not injections.
- Count every injection, but count a run only once per observed fault type.
  Mixed-type groups overlap; their outcome rates do not establish causality.
- An empty `injectedFaults` array means known zero injections. An absent field
  means unknown provenance, including legacy or replay results; never infer it.
- Keep existing grading and overall/task statistics intact. Cover changes to
  provenance and aggregation in `tests/report-stats.test.mjs`, and changes to
  artifacts or CLI behavior in `tests/report-output.test.mjs`.
- Default report output is JSON, Markdown, and HTML; `--no-html` omits HTML.
  Escape variable HTML text. Keep the HTML self-contained, with no scripts,
  external assets, fonts, or data requests. Follow [DESIGN.md](DESIGN.md) for
  report layout and accessibility; verify relevant offline/browser behavior
  when changing rendering.

## Environment, access, and review costs

- Inspect current environment readiness and actual service access before assuming
  an earlier network failure still applies. GitHub Git access and GitHub API
  access are separate; PR operations also need `api.github.com` and suitable
  credentials. Try existing tools and authentication before asking for help.
- Do not change network policy, credentials, setup configuration, or publish an
  environment as a side effect of repository work. Those changes need a separate
  request. A saved draft does not establish that a setting is active.
- When blocked, report the exact error, the checks already made, and one concrete
  next step. Avoid repeating setup, Save/Publish, or retry loops without evidence.
- Do not enable paid scans or request extra Codex Security reviews as routine
  housekeeping. Use an additional review when requested or justified by the
  change, and explain why. Existing GitHub review automation is managed in Codex
  settings; this file does not enable or disable it.

# Reporting v1 verification

Verified locally on Linux with Node **24.22.1**, npm **11.9.0**, on 2026-11-12.
The same existing CI workflow targets Node 20; a remote CI run is not claimed.

| Check | Result |
|---|---|
| Baseline before implementation | Build/typecheck passed; smoke 15/15, embedded 7/7, controls 21/21, replay MATCH |
| New tests before implementation | Seven statistics/provenance tests failed on missing data; six output tests failed on missing report behavior |
| `./node_modules/.bin/tsc --noEmit` | Passed |
| `npm run build` | Passed |
| `npm test` | Smoke assertions 15/15; reporting tests 13/13; no skips |
| `npm run test:all` | Embedded 7/7; controls 21/21; replay MATCH |
| CLI with `--runs 2` | 14 runs; timeout 6 injections / 6 runs / 6 passed; 8 unexposed runs |
| CLI output and `--no-html` | Three default artifacts; JSON/Markdown only with opt-out, in separate temporary directories |
| Browser rendering | Chromium, 1280×1000 and 375×812; screenshots inspected |
| Browser behavior | Exact displayed fault counts, keyboard disclosures, horizontal table scrolling, no page overflow, empty/legacy and long hostile text |
| Offline and no-script | Offline browser context made zero network requests and reported zero page errors; native disclosures also worked with JavaScript disabled |
| Repository checks | `git diff --check` passed; LICENSE and package-lock.json unchanged |

Browser tests used Playwright already installed in the cloud environment; no
browser dependency was added to the project. Managed Chromium rejected direct
`file:` navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`. The generated file's
contents were therefore loaded with `page.setContent` in an offline context.
Direct local-file navigation in an unmanaged browser and Firefox/Safari have
not been verified. There are no external assets or scripts in the output.

External agent integrations, remote GitHub CI, publishing and deployment are
outside this verification. Raw proxy reporting and replay provenance remain
unchanged; replay/custom/legacy runs without metadata are explicitly unknown.

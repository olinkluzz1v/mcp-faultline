# Offline evaluation report

This is a static technical document for developers comparing MCP agent runs.
The primary question is the observed pass rate for each injected fault type.
The existing English CLI and Markdown terminology governs labels. Conversation
language does not change report locale; timestamps are explicit ISO UTC.

## Visual and behavior contract

Use a light reading surface, navy text and blue emphasis. Report title uses a
local Georgia/serif stack; body uses system sans; identifiers use monospace.
Exact totals and denominators take priority over charts. PASS/FAIL have text
labels as well as distinct colors. Warnings and overlap caveats stay beside
the results they qualify. Missing observations show N/A, never a fabricated rate.

`src/report/presentation.ts` owns shared text escaping, inline CSS and its `:root`
tokens: paper, surface, ink, muted, line, accent, pass and fail. The embedded layout
remains in `src/report/html.ts`; the Codex ticket batch reuses these primitives
with its own small overview and evidence links. Its separate oracle and JSON
contract are not embedded evaluation statistics. There is no application framework
or component library.

Reading order: header and section links → overall summary → fault comparison →
task comparison and sampling caveats → native run disclosures → provenance.
Demo reports insert a visible scenario/policy and evidence-verification section
before the overall summary. Keep expected outcomes separate from actual grades;
an expected negative control retains its FAIL label even when verified.
All rows remain in the portable document; use browser Find and section links
for navigation. Disclosure content is collapsed initially. Tables have captions,
scoped headers and a keyboard-focusable horizontal scroll region on narrow
screens. Focus is visible. Long identifiers wrap. No hover-only data, motion,
web fonts, remote assets, scripts or custom controls.

Verify desktop/mobile layout, keyboard disclosures, empty and legacy states,
hostile text escaping, and zero network requests when opened offline.

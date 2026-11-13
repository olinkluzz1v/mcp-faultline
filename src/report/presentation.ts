/** Escape text only; report data is never interpreted as markup, CSS or script. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}


/** Shared inline presentation for standalone reports; no assets or scripts. */
export const reportStyles = `
    :root { color-scheme: light; --paper: #f5f7fb; --surface: #fff; --ink: #172a46;
      --muted: #526078; --line: #d4dce8; --accent: #214fb4; --pass: #166044; --fail: #a72b36; }
    * { box-sizing: border-box; }
    html { scrollbar-gutter: stable; scrollbar-color: var(--muted) var(--paper); }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 system-ui, sans-serif; }
    main { max-width: 1100px; margin: auto; padding: 48px 24px; }
    header { border-top: 5px solid var(--accent); padding-top: 22px; }
    .brand { margin: 0; color: var(--accent); font-weight: 750; letter-spacing: .06em; }
    h1 { font: 500 clamp(2.1rem, 5vw, 3.3rem)/1.15 Georgia, serif; margin: 12px 0; }
    h2 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 12px; }
    h3 { font-size: 1rem; margin-bottom: 6px; }
    p { margin: 10px 0; }
    a { color: var(--accent); text-underline-offset: 3px; }
    a:hover { text-decoration-thickness: 2px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 20px 0; }
    nav a { padding-block: 6px; }
    section { margin: 32px 0; scroll-margin-top: 20px; }
    .muted, caption { color: var(--muted); }
    .scroll-hint { display: none; }
    .overview { display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px 40px;
      padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
    .verdict { font-size: 1.4rem; margin: 0; }
    .verdict strong { font-size: 2.3rem; font-variant-numeric: tabular-nums; }
    .overview p { margin: 0; }
    .demo-context { padding: 24px; background: var(--surface); border: 1px solid var(--line);
      border-radius: 8px; overflow-wrap: anywhere; }
    .demo-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 16px 0; }
    .demo-facts dt { color: var(--muted); font-size: .9rem; }
    .demo-facts dd { margin: 0; font-weight: 750; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
    table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    caption { text-align: left; padding: 12px 16px; font-size: .9rem; }
    th, td { text-align: right; padding: 12px 16px; border-top: 1px solid var(--line); }
    th:first-child { text-align: left; overflow-wrap: anywhere; min-width: 150px; }
    thead th { background: var(--paper); font-size: .8rem; letter-spacing: .02em; white-space: nowrap; }
    tbody th { font: 500 .9rem/1.5 ui-monospace, monospace; }
    .rate { font-weight: 750; color: var(--accent); white-space: nowrap; }
    .note { border-left: 3px solid var(--line); padding-left: 16px; color: var(--muted); }
    .note ul { padding-left: 20px; }
    code { font: .9em ui-monospace, monospace; overflow-wrap: anywhere; }
    details { border-bottom: 1px solid var(--line); background: var(--surface); }
    summary { cursor: pointer; padding: 16px; overflow-wrap: anywhere; }
    summary:hover { background: var(--paper); }
    .run-name { margin-inline: 10px; }
    .status { display: inline-block; font-size: .75rem; font-weight: 800; letter-spacing: .04em; }
    .pass { color: var(--pass); }
    .fail { color: var(--fail); }
    .run-body { padding: 0 24px 20px; overflow-wrap: anywhere; }
    :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); font-size: .85rem; overflow-wrap: anywhere; }
    @media (max-width: 600px) {
      main { padding: 24px 16px; } .overview { padding: 16px; gap: 12px; }
      .scroll-hint { display: block; color: var(--muted); font-size: .85rem; }
      th, td { padding: 10px; } .run-name { margin-inline: 4px; }
      .run-body, .demo-context { padding-inline: 16px; }
      .demo-facts > div:nth-child(-n+2) { grid-column: 1 / -1; }
    }
    @media print {
      body { background: white; } main { max-width: none; padding: 0; } nav { display: none; }
      .table-wrap { overflow: visible; } details { break-inside: avoid; }
      details::details-content { content-visibility: visible; display: block; }
    }
`;

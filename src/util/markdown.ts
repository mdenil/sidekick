/**
 * @fileoverview Minimal markdown → HTML converter.
 * Shared by chat transcript rendering and the markdown card.
 * Escapes HTML first, then applies formatting — safe against XSS.
 */

import { escapeHtml } from './dom.ts';

export function miniMarkdown(s) {
  let t = escapeHtml(s);
  // Code blocks
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  // Tables — GFM-style pipe syntax. Must run BEFORE paragraph wrapping
  // and other line-sensitive steps. Matches a header row + separator
  // row (--- / :--- / ---: / :---:) + body rows.
  t = renderTables(t);
  // Inline code
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italics (don't collide with bullet *)
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Headings
  t = t.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  t = t.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  t = t.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // Bullet lists
  t = t.replace(/^(?:[-*]\s+.+\n?)+/gm, m => {
    const items = m.trim().split('\n').map(l => '<li>' + l.replace(/^[-*]\s+/, '') + '</li>').join('');
    return `<ul>${items}</ul>`;
  });
  // Numbered lists. Same shape as bullet but consecutive lines beginning
  // with digits-dot-space → <ol><li>…</li></ol>. Risk of false positives
  // on prose like "10. October" is real but low for chat content.
  t = t.replace(/^(?:\d+\.\s+.+\n?)+/gm, m => {
    const items = m.trim().split('\n').map(l => '<li>' + l.replace(/^\d+\.\s+/, '') + '</li>').join('');
    return `<ol>${items}</ol>`;
  });
  // Markdown links
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Angle-bracketed URLs: <url> → escaped as &lt;url&gt; by escapeHtml
  t = t.replace(/&lt;(https?:\/\/[^\s&]+?)&gt;/g, '<a href="$1">$1</a>');
  // Bare URLs
  t = t.replace(/(^|[^"'>=])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2">$2</a>');
  // Paragraphs. Split on blank lines. For each chunk: if it starts with a
  // block-level element (already rendered by an earlier rule: <pre>, <ul>,
  // <ol>, <h1-6>, <table>, etc.), leave it alone — wrapping it in <p>
  // would be invalid HTML, and any intra-chunk `\n` belongs to the block
  // element's own semantics (e.g. preserved whitespace inside <pre>).
  // Otherwise wrap in <p> and convert single newlines to <br>. The old
  // implementation used a bare `startsWith('<')` test, which incorrectly
  // skipped the `<br>` rewrite for chunks starting with inline elements
  // like <strong> — a single-newline-separated pair of `**bold**` lines
  // collapsed onto one rendered line (Jonathan field report 2026-05-17).
  const BLOCK_OPENER = /^<(?:pre|table|ul|ol|blockquote|h[1-6]|hr|div)\b/i;
  t = t.split(/\n\n+/).map(p =>
    BLOCK_OPENER.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  return t;
}

/** GFM pipe-table renderer. Scans for a header row + separator row + one
 *  or more body rows, all shaped like `| a | b | c |`. The separator row
 *  determines column count AND per-column alignment via `:---`, `---:`,
 *  `:---:` syntax. Leaves non-table content untouched. */
function renderTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isPipeRow(lines[i]) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      // Scan forward collecting body rows.
      const header = parsePipeRow(lines[i]);
      const aligns = parseAligns(lines[i + 1]);
      const body = [];
      let j = i + 2;
      while (j < lines.length && isPipeRow(lines[j])) {
        body.push(parsePipeRow(lines[j]));
        j++;
      }
      out.push(buildTableHtml(header, aligns, body));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

function isPipeRow(line) {
  // A pipe-row starts with | (optionally after leading whitespace) and
  // has at least one more | internally. `|---|` qualifies.
  return /^\s*\|.*\|\s*$/.test(line) && (line.match(/\|/g) || []).length >= 2;
}

function isSeparatorRow(line) {
  // Every cell must match the alignment syntax: optional leading/trailing
  // colon around one or more dashes. Whitespace inside the cell allowed.
  if (!isPipeRow(line)) return false;
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
}

function parsePipeRow(line) {
  // Trim the line, strip leading/trailing pipe, split on pipe, trim cells.
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function parseAligns(sepLine) {
  return sepLine.trim().replace(/^\||\|$/g, '').split('|').map(c => {
    const s = c.trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function buildTableHtml(header, aligns, body) {
  const styleAttr = (i) => aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
  const headerHtml = header.map((h, i) => `<th${styleAttr(i)}>${h}</th>`).join('');
  const bodyHtml = body.map(row =>
    '<tr>' + row.map((c, i) => `<td${styleAttr(i)}>${c}</td>`).join('') + '</tr>'
  ).join('');
  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

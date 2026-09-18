'use strict';
/**
 * A statement export, read as rows.
 *
 * The church's bank or payment provider can already produce the one thing an
 * integration needs: a list of payments that arrived, with dates, amounts,
 * references and payer names. This module turns that export into rows, and
 * nothing else, deliberately. It is not a bank API and does not pretend to be
 * one; it reads what the church downloaded from its own provider's portal.
 *
 * WHY A HAND-WRITTEN PARSER
 * -------------------------
 * Real exports are inconsistent in ways a naive `split(',')` mangles: payers
 * with commas in their names, numbers written "1,000,000.00", amounts in quotes,
 * and descriptions that contain both. So the parser below honours RFC4180
 * quoting (doubled quotes inside quoted fields, commas and newlines inside
 * quotes) and detects the delimiter from the header, because a bank exporting
 * semicolon-separated files is ordinary in Europe and common from Excel on a
 * machine with comma decimal settings.
 *
 * Column names are resolved by ALIAS rather than by position (see
 * providers/statementColumns.js): every bank orders its columns differently, and
 * a column-order change in next month's export must not silently shift every
 * amount one column to the left.
 */

/** Sniff the delimiter from the header line. Comma unless a tab or ; dominates. */
function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/).find((line) => line.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts[ch] !== undefined) counts[ch] += 1;
  }
  let best = ',';
  for (const [delimiter, count] of Object.entries(counts)) {
    if (count > counts[best]) best = delimiter;
  }
  return best;
}

/**
 * Parses delimited text into rows of cells. Handles quoted fields containing the
 * delimiter, doubled quotes and embedded newlines.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, ''); // a BOM would become part of the first header

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // Trailing newline produces one empty row; blank rows anywhere are dropped
  // rather than reported, because an export's blank separator is not a payment
  // the church failed to explain.
  return rows.filter((cells) => cells.some((c) => String(c).trim() !== ''));
}

/** Header -> column index, with the header text normalized ('Txn Date ' -> 'txndate'). */
function headerIndex(cells) {
  const map = new Map();
  cells.forEach((cell, index) => {
    const key = String(cell).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

/**
 * Reads the export into `{ headers, rows }` where each row is an object keyed by
 * the ORIGINAL header text, plus a `_line` number for error messages.
 */
function readStatement(text) {
  const delimiter = detectDelimiter(text);
  const cells = parseDelimited(text, delimiter);
  if (!cells.length) return { headers: [], rows: [] };
  const headers = cells[0].map((h) => String(h).trim());
  const rows = cells.slice(1).map((cells2, i) => {
    const row = { _line: i + 2 };
    headers.forEach((header, index) => { row[header] = String(cells2[index] ?? '').trim(); });
    return row;
  });
  return { headers, rows };
}

module.exports = { detectDelimiter, parseDelimited, readStatement, headerIndex };

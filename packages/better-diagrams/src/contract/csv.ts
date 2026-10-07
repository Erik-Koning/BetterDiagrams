/**
 * csv.ts — one way to write a table as text, for every panel that offers a
 * download: RFC 4180 quoting (a cell with a comma, quote or line break is
 * quoted, quotes doubled) and CRLF line ends, which is what spreadsheets
 * expect. Zero dependencies, like every contract module.
 */

const escapeCsv = (text: string): string => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** A header row and data rows as CSV text, ending in a line break. */
export function csvText(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header.map(escapeCsv).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsv).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

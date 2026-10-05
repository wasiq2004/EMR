/**
 * Reading a CSV a clinic actually has.
 *
 * Written rather than taken from a library because the awkward parts here are
 * not the parsing — they are what arrives from a fifteen-year-old desktop system
 * that somebody exported from Excel on a Windows machine, and a general-purpose
 * parser handles the grammar and leaves those to the caller anyway:
 *
 *   - A UTF-8 BOM, which Excel writes by default. Left in place it becomes part
 *     of the FIRST HEADING, so "Name" arrives as "﻿Name" and matches
 *     nothing. The column mapping then silently has no name column.
 *   - CP1252 text, which is most exports from older Indian clinic software.
 *     Decoded as UTF-8 it does not throw — it produces U+FFFD where the
 *     accented characters were, so a name is quietly corrupted rather than
 *     rejected.
 *   - CRLF line endings, and a trailing newline that would otherwise read as a
 *     final empty patient.
 *   - Quoted fields containing commas, newlines and doubled quotes, which is
 *     how an address with a comma in it survives.
 *
 * Deliberately NOT a streaming parser. The whole file is in memory already —
 * it arrived as one upload — and the import commits in a single transaction, so
 * there is nothing to gain by processing it in pieces.
 */

/** A non-UTF-8 byte sequence decodes to this. Its presence is the signal. */
const REPLACEMENT = '�';

/**
 * Decodes the upload, preferring UTF-8 and falling back to Windows-1252.
 *
 * The fallback is chosen by looking for replacement characters rather than by
 * sniffing bytes: a valid UTF-8 file never produces one, and a CP1252 file
 * almost always does the moment it contains a name with an accent, a curly
 * apostrophe from Word, or a rupee sign. Reporting WHICH decoding was used
 * matters — the clinic is the only one who can confirm a name looks right.
 */
export function decodeUpload(buffer: Buffer): {
  text: string;
  decodedAs: 'utf-8' | 'windows-1252';
} {
  const asUtf8 = buffer.toString('utf8');

  if (!asUtf8.includes(REPLACEMENT)) {
    return { text: stripBom(asUtf8), decodedAs: 'utf-8' };
  }

  /*
   * `latin1` in Node is ISO-8859-1, not CP1252, and they differ in the 0x80–0x9F
   * range — which is exactly where Word's curly quotes and dashes live. Those
   * bytes are mapped explicitly, because left alone they become C1 control
   * characters that render as nothing and make a field look truncated.
   */
  const CP1252_HIGH: Record<number, string> = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
    0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
    0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
    0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
    0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
    0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
  };

  let out = '';
  for (const byte of buffer) {
    out += byte >= 0x80 && byte <= 0x9f
      ? (CP1252_HIGH[byte] ?? '�')
      : String.fromCharCode(byte);
  }

  return { text: stripBom(out), decodedAs: 'windows-1252' };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Splits CSV text into rows of fields.
 *
 * Returns raw rows, headings included, because the caller needs the heading row
 * both to build the mapping and to number the data rows the way a spreadsheet
 * does — a clinic correcting their file is looking at row numbers in Excel, and
 * an off-by-one there sends them to the wrong line.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote. This is
        // how `5'8"` and `"Bunty"` survive the round trip.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF and a lone CR both end the row. Excel on Windows writes CRLF; a
      // file that has been through a Mac at some point can carry bare CRs.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // The last row only exists if the file did not end on a newline. Pushing an
  // empty one would read as a final patient with no name.
  if (field !== '' || row.length > 0) endRow();

  /*
   * Rows that are entirely empty are dropped.
   *
   * A spreadsheet exported with formatting applied below the data produces a
   * run of commas for hundreds of lines. Counting those as rows would tell the
   * clinic their file has 1,400 patients when it has 312, and then report
   * 1,088 problems.
   */
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

/** Quotes one field for the error report handed back to the clinic. */
export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: (string | number | null | undefined)[]): string {
  // CRLF, because this file is opened in Excel on Windows more often than not.
  return values.map(csvField).join(',') + '\r\n';
}

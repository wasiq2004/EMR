import { describe, expect, it } from 'vitest';
import { csvRow, decodeUpload, parseCsv } from './csv';

/**
 * The CSV reader.
 *
 * Tested closely because every failure here is SILENT. A parser that mishandles
 * a quoted comma does not throw — it produces a patient whose name is half an
 * address, imports it successfully, and nobody finds out until somebody rings
 * the wrong number. The cases below are the ones a real clinic export actually
 * contains, not a grammar exercise.
 */

describe('decodeUpload', () => {
  it('reads plain UTF-8', () => {
    const result = decodeUpload(Buffer.from('Name,Mobile\nArjun,+919876543210\n', 'utf8'));
    expect(result.decodedAs).toBe('utf-8');
    expect(result.text).toBe('Name,Mobile\nArjun,+919876543210\n');
  });

  /*
   * Excel writes a BOM by default. Left in place it becomes part of the first
   * heading, so the name column matches nothing in the mapping and the whole
   * import reports every row as missing a name.
   */
  it('strips the byte order mark Excel writes', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Name,Mobile\nArjun,+919876543210\n', 'utf8'),
    ]);
    const result = decodeUpload(withBom);
    expect(result.text.startsWith('Name')).toBe(true);
    expect(parseCsv(result.text)[0]).toEqual(['Name', 'Mobile']);
  });

  /*
   * The case that corrupts data rather than failing. A CP1252 file decoded as
   * UTF-8 does not throw; it substitutes U+FFFD, so the name is quietly wrong.
   */
  it('falls back to Windows-1252 rather than corrupting a name', () => {
    // "Zoë" with the ë as a single CP1252 byte (0xEB), which is not valid UTF-8.
    const cp1252 = Buffer.from([
      ...Buffer.from('Name\nZo', 'ascii'),
      0xeb,
      ...Buffer.from('\n', 'ascii'),
    ]);

    expect(cp1252.toString('utf8')).toContain('�');

    const result = decodeUpload(cp1252);
    expect(result.decodedAs).toBe('windows-1252');
    expect(result.text).toContain('Zoë');
    expect(result.text).not.toContain('�');
  });

  /*
   * Word's curly apostrophe is 0x92, which ISO-8859-1 maps to an invisible
   * control character and CP1252 maps to a quote. Node's `latin1` is the former,
   * which is why the high range is mapped by hand.
   */
  it("keeps Word's curly punctuation legible", () => {
    const cp1252 = Buffer.from([...Buffer.from('Name\nD', 'ascii'), 0x92, 0x73, 0x6f, 0x75, 0x7a, 0x61]);
    const result = decodeUpload(cp1252);
    expect(result.decodedAs).toBe('windows-1252');
    expect(result.text).toContain('D’souza');
  });
});

describe('parseCsv', () => {
  it('reads headings and rows', () => {
    expect(parseCsv('Name,Age\nArjun,34\nPriya,28\n')).toEqual([
      ['Name', 'Age'],
      ['Arjun', '34'],
      ['Priya', '28'],
    ]);
  });

  /** An address with a comma in it. The single most common quoted field. */
  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('Name,Address\nArjun,"12, MG Road"\n')).toEqual([
      ['Name', 'Address'],
      ['Arjun', '12, MG Road'],
    ]);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(parseCsv('Name\n"Arjun ""Bunty"" Mehta"\n')).toEqual([
      ['Name'],
      ['Arjun "Bunty" Mehta'],
    ]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('Name,Address\nArjun,"12 MG Road\nBengaluru"\n')).toEqual([
      ['Name', 'Address'],
      ['Arjun', '12 MG Road\nBengaluru'],
    ]);
  });

  it('handles CRLF, which is what Excel on Windows writes', () => {
    expect(parseCsv('Name,Age\r\nArjun,34\r\n')).toEqual([
      ['Name', 'Age'],
      ['Arjun', '34'],
    ]);
  });

  /*
   * A file not ending in a newline is a real file, and dropping its last row
   * loses a patient with no error anywhere.
   */
  it('keeps the last row when the file does not end in a newline', () => {
    expect(parseCsv('Name,Age\nArjun,34')).toEqual([
      ['Name', 'Age'],
      ['Arjun', '34'],
    ]);
  });

  it('does not invent a row from the trailing newline', () => {
    expect(parseCsv('Name\nArjun\n')).toHaveLength(2);
  });

  /*
   * A spreadsheet saved with formatting applied below the data writes hundreds
   * of comma-only lines. Counted as rows, they tell the clinic their file has
   * four times as many patients as it does, and then report the difference as
   * problems.
   */
  it('drops the empty rows a formatted spreadsheet leaves behind', () => {
    expect(parseCsv('Name,Age\nArjun,34\n,\n,\n,\n')).toEqual([
      ['Name', 'Age'],
      ['Arjun', '34'],
    ]);
  });

  it('keeps empty fields inside a row that has data', () => {
    expect(parseCsv('Name,Mobile,City\nArjun,,Bengaluru\n')).toEqual([
      ['Name', 'Mobile', 'City'],
      ['Arjun', '', 'Bengaluru'],
    ]);
  });
});

describe('csvRow', () => {
  it('quotes only what needs quoting', () => {
    expect(csvRow(['Arjun', 34, null, '12, MG Road'])).toBe('Arjun,34,,"12, MG Road"\r\n');
  });

  /** The error report must survive being opened in Excel and re-saved. */
  it('round-trips through the parser', () => {
    const original = ['Arjun "Bunty" Mehta', '12 MG Road\nBengaluru', 'a,b'];
    expect(parseCsv(csvRow(original))).toEqual([original]);
  });
});

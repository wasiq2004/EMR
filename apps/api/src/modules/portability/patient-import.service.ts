import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  IMPORT_MAX_ROWS,
  IMPORT_TARGET_FIELDS,
  normalisePhone,
  type ImportColumnMapping,
  type ImportJobRow,
  type ImportRowProblem,
} from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { StorageService } from '../../common/storage/storage.service';
import { csvRow, decodeUpload, parseCsv } from './csv';

/**
 * Bringing an existing patient register in from somewhere else.
 *
 * WHAT THIS REPLACED. The import wizard was a mock, end to end: the chosen file
 * was never uploaded, the column list it asked you to confirm was a hardcoded
 * array of seven names, and the result figures — "1,284 rows read", "1,207
 * ready", "54 possible duplicates", "23 problems" — were string literals in the
 * page. The button under them said "Import the 1,207 ready rows" and did
 * nothing. A clinic admin who used that screen would have believed their
 * register was in, discovered otherwise at the front desk, and had no idea
 * which records to trust. There was no `POST /imports` anywhere on the server.
 *
 * TWO RULES, both from the same observation — a half-imported register is worse
 * than no import, because staff cannot tell which records are real:
 *
 *   1. NOTHING COMMITS UNTIL THE WHOLE BATCH VALIDATES. One transaction. A
 *      failure at row 900 leaves the register exactly as it was.
 *   2. NO ROW IS DROPPED SILENTLY. Every rejection produces a row-level reason
 *      in a file the clinic can correct and re-upload, carrying their own
 *      original columns so they edit their data rather than ours.
 *
 * PATIENTS ONLY, and the screen says so. Consultations, prescriptions and
 * documents from an old system need their own mapping decisions per vendor and
 * are quoted as bespoke work. A generic importer for clinical history would be
 * guessing at what a diagnosis field meant, and a wrong guess there is a
 * clinical record that reads as true.
 */
@Injectable()
export class PatientImportService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StorageService,
  ) {}

  /* ---- Step 1: the file ------------------------------------------------- */

  /**
   * Stores the upload and reads its headings.
   *
   * The file is kept rather than parsed-and-discarded because validation and the
   * commit are separate requests — and because re-reading the stored bytes is
   * the only way the numbers shown to the clinic can be guaranteed to describe
   * the data that actually gets inserted.
   */
  async upload(input: { filename: string; body: Buffer }) {
    const ctx = TenantContext.require();
    const { text, decodedAs } = decodeUpload(input.body);
    const rows = parseCsv(text);

    if (rows.length === 0) {
      throw new UnprocessableEntityException({
        title: 'That file is empty',
        message: 'There are no rows in it. Check it opens in a spreadsheet first.',
      });
    }

    const columns = (rows[0] ?? []).map((heading) => heading.trim());
    if (columns.length === 0 || columns.every((heading) => heading === '')) {
      throw new UnprocessableEntityException({
        title: 'No column headings',
        message:
          'The first row has to name the columns — Name, Mobile, and so on — so they can be matched.',
      });
    }

    /*
     * Duplicate headings are refused rather than silently resolved.
     *
     * Two columns called "Mobile" cannot both be mapped, and picking one is a
     * guess about which holds the number the clinic actually rings.
     */
    const seen = new Set<string>();
    const repeated = columns.filter((heading) => {
      const key = heading.toLowerCase();
      if (heading === '') return false;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (repeated.length > 0) {
      throw new UnprocessableEntityException({
        title: 'Two columns have the same heading',
        message: `${[...new Set(repeated)].join(', ')} appears more than once. Rename one of them so it is clear which is which.`,
      });
    }

    const dataRows = rows.length - 1;
    if (dataRows === 0) {
      throw new UnprocessableEntityException({
        title: 'That file has headings and no patients',
        message: 'Only the heading row was found.',
      });
    }
    if (dataRows > IMPORT_MAX_ROWS) {
      throw new UnprocessableEntityException({
        title: 'That file is too large to import in one go',
        message: `It has ${dataRows.toLocaleString('en-IN')} rows and the limit is ${IMPORT_MAX_ROWS.toLocaleString('en-IN')}. Split it and import the parts one after another — each part either lands whole or not at all, so this is safe to do.`,
      });
    }

    const objectKey = this.storage.buildKey({ category: 'imports', extension: 'csv' });
    await this.storage.putImport(objectKey, input.body);

    const job = await this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.importJob)
        .values({
          clinicId: ctx.clinicId,
          entityType: 'PATIENTS',
          sourceObjectKey: objectKey,
          sourceFilename: input.filename,
          status: 'AWAITING_MAPPING',
          totalRows: dataRows,
          requestedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created!;
    });

    return {
      job: serialise(job, columns, null),
      suggestedMapping: suggestMapping(columns),
      // Three rows is enough to see whether a mapping is right and not enough
      // to be a data export of somebody else's register.
      sampleRows: rows.slice(1, 4).map((row) => zip(columns, row)),
      decodedAs,
    };
  }

  /* ---- Step 2: what the columns mean, and what the rows say ------------- */

  /**
   * Validates every row against the real contract and the live register.
   *
   * NOTHING IS WRITTEN TO THE REGISTER HERE. The counts the clinic then sees are
   * computed from their actual file, which is the entire difference between this
   * and what the screen used to show.
   */
  async validate(jobId: string, columnMapping: ImportColumnMapping) {
    const ctx = TenantContext.require();
    const job = await this.requireJob(jobId);

    if (job.status === 'COMPLETED') {
      throw new ConflictException('That import has already been committed.');
    }

    const mapped = new Set(Object.values(columnMapping).filter(Boolean));
    for (const field of IMPORT_TARGET_FIELDS.filter((f) => f.required)) {
      if (!mapped.has(field.field)) {
        throw new UnprocessableEntityException({
          title: `Which column holds the ${field.label.toLowerCase()}?`,
          message: `A patient record cannot be created without it.`,
        });
      }
    }

    const unknown = Object.values(columnMapping).filter(
      (field) => field !== '' && !IMPORT_TARGET_FIELDS.some((f) => f.field === field),
    );
    if (unknown.length > 0) {
      throw new UnprocessableEntityException({
        title: 'Unknown field',
        message: `${unknown.join(', ')} is not a field on a patient record.`,
      });
    }

    /*
     * One target field mapped from two source columns is refused.
     *
     * It is almost always a mis-click, and the alternative — taking whichever
     * comes last — writes one of the two columns into the register and
     * discards the other without saying which.
     */
    const targets = Object.values(columnMapping).filter(Boolean);
    if (new Set(targets).size !== targets.length) {
      throw new UnprocessableEntityException({
        title: 'Two columns point at the same field',
        message: 'Each field can come from one column. Set the other to "do not import".',
      });
    }

    const { rows, columns } = await this.readSource(job);
    const { candidates, problems } = this.examine(rows, columns, columnMapping);

    /*
     * Against the live register, in two bulk queries rather than one per row.
     *
     * Per-row duplicate checks would be fifty thousand round trips inside a
     * request. The checks themselves are EXACT — same mobile, or same name and
     * date of birth — rather than the trigram similarity the front desk uses.
     * That difference is deliberate: at the desk a human is looking at two
     * records and deciding, and a fuzzy match is a useful prompt. Here nobody
     * is looking, so a fuzzy match would silently refuse to import a second
     * Sunita Sharma who is a different person.
     */
    const alreadyRegistered = await this.findExisting(candidates);

    for (const candidate of candidates) {
      const mobileHit = candidate.mobileE164
        ? alreadyRegistered.byMobile.get(candidate.mobileE164)
        : undefined;
      const nameDobHit = candidate.dateOfBirth
        ? alreadyRegistered.byNameAndDob.get(
            nameDobKey(candidate.fullName, candidate.dateOfBirth),
          )
        : undefined;

      if (nameDobHit) {
        candidate.skipped = true;
        problems.push({
          rowNumber: candidate.rowNumber,
          label: candidate.fullName,
          field: 'fullName',
          message: `Already registered as ${nameDobHit} — same name and date of birth.`,
          kind: 'ALREADY_REGISTERED',
        });
        continue;
      }

      /*
       * A SHARED MOBILE IS NOT A DUPLICATE, and this is the rule most likely to
       * be "corrected" by someone who has not worked a clinic desk. A family of
       * five on one handset is routine in this market — refusing four of them
       * would leave a clinic unable to import its own register. The row is
       * imported and flagged in the report so somebody can look.
       */
      if (mobileHit) {
        problems.push({
          rowNumber: candidate.rowNumber,
          label: candidate.fullName,
          field: 'mobileE164',
          message: `${mobileHit} is already registered on this number. Imported anyway — a family sharing one handset is normal. Check it is not the same person.`,
          kind: 'DUPLICATE_IN_FILE',
        });
      }
    }

    const validRows = candidates.filter((c) => !c.skipped).length;
    const errorRows = problems.filter((p) => p.kind === 'INVALID').length;
    const duplicateRows = problems.filter((p) => p.kind !== 'INVALID').length;

    const errorReportObjectKey = problems.length > 0
      ? await this.writeProblemReport(columns, rows, problems)
      : null;

    const updated = await this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .update(schema.importJob)
        .set({
          columnMapping,
          status: 'AWAITING_CONFIRMATION',
          validRows,
          errorRows,
          duplicateRows,
          errorReportObjectKey,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.importJob.id, jobId))
        .returning();
      return row!;
    });

    const DISPLAY_CAP = 100;
    return {
      job: serialise(updated, columns, null),
      problems: problems.slice(0, DISPLAY_CAP),
      problemsTruncated: problems.length > DISPLAY_CAP,
    };
  }

  /* ---- Step 3: the commit ----------------------------------------------- */

  /**
   * Inserts every valid row, in one transaction.
   *
   * RE-READ AND RE-VALIDATED from the stored file rather than from anything the
   * browser sends back. The numbers the clinic confirmed came from the file, and
   * trusting a client-side list of "the valid rows" would let a stale or edited
   * page insert something nobody reviewed.
   *
   * The MRN is minted inside the transaction, in sequence, which also serialises
   * two admins committing at once — the second waits rather than issuing
   * duplicate record numbers.
   */
  async commit(jobId: string) {
    const ctx = TenantContext.require();
    const job = await this.requireJob(jobId);

    if (job.status === 'COMPLETED') {
      throw new ConflictException(
        `That import has already been committed — ${job.importedRows} patients were added.`,
      );
    }
    if (job.status !== 'AWAITING_CONFIRMATION') {
      throw new ConflictException('Match the columns and check the rows before importing.');
    }

    const mapping = (job.columnMapping ?? {}) as ImportColumnMapping;
    const { rows, columns } = await this.readSource(job);
    const { candidates } = this.examine(rows, columns, mapping);

    const existing = await this.findExisting(candidates);
    const toInsert = candidates.filter(
      (candidate) =>
        !candidate.skipped &&
        !(
          candidate.dateOfBirth &&
          existing.byNameAndDob.has(nameDobKey(candidate.fullName, candidate.dateOfBirth))
        ),
    );

    if (toInsert.length === 0) {
      throw new UnprocessableEntityException({
        title: 'There is nothing to import',
        message:
          'Every row either has a problem or is already in the register. Download the report to see which.',
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const imported = await this.tenantDb.run(async (tx) => {
      // One query for the starting number, then counted up in memory. Calling
      // the max() per row would be one query per patient.
      const result = await tx.execute(sql`
        SELECT coalesce(max(nullif(regexp_replace(mrn, '[^0-9]', '', 'g'), '')::bigint), 0) AS used
        FROM patient
      ` as never);
      const rows = (result as unknown as { rows: { used: string | number }[] }).rows;
      let next = Number(rows[0]?.used ?? 0);

      const values = toInsert.map((candidate) => {
        next += 1;
        return {
          clinicId: ctx.clinicId,
          mrn: `MRN-${String(next).padStart(6, '0')}`,
          fullName: candidate.fullName,
          // NOT NULL, and written by a trigger afterwards. Supplying it keeps
          // the insert valid before the trigger normalises it.
          nameNormalized: candidate.fullName.toLowerCase(),
          mobileE164: candidate.mobileE164,
          gender: candidate.gender,
          dateOfBirth: candidate.dateOfBirth,
          ageYears: candidate.ageYears,
          /*
           * A STATED AGE IS ONLY MEANINGFUL WITH THE DATE IT WAS STATED. An old
           * register holding "34" says nothing about today unless the import
           * date is recorded with it — and recording today is the honest answer,
           * because today is when this clinic learned it. Without this, a
           * paediatric dose computed from a rotted age is wrong by years.
           */
          ageRecordedAt: candidate.ageYears !== null ? today : null,
          addressLine1: candidate.addressLine1,
          city: candidate.city,
          state: candidate.state,
          pincode: candidate.pincode,
          abhaNumber: candidate.abhaNumber,
          /*
           * Tagged, permanently and on purpose. An imported record was not seen
           * at this desk and was not verified by anyone here: the spelling, the
           * number and the age are the old system's. Staff need to know that
           * when the number does not ring.
           */
          tags: ['imported'],
          notes: candidate.sourceMrn
            ? `Imported from ${job.sourceFilename}. Record number in the previous system: ${candidate.sourceMrn}.`
            : `Imported from ${job.sourceFilename}.`,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        };
      });

      /*
       * Chunked, because one statement with fifty thousand VALUES rows exceeds
       * what the driver will bind. Still ONE TRANSACTION — a failure in the
       * fourth chunk rolls back the first three, which is the whole guarantee.
       */
      const CHUNK = 500;
      let count = 0;
      for (let i = 0; i < values.length; i += CHUNK) {
        const slice = values.slice(i, i + CHUNK);
        await tx.insert(schema.patient).values(slice);
        count += slice.length;
      }

      await tx
        .update(schema.importJob)
        .set({
          status: 'COMPLETED',
          importedRows: count,
          startedAt: job.startedAt ?? new Date(),
          completedAt: new Date(),
          updatedBy: ctx.userId,
        })
        .where(eq(schema.importJob.id, jobId));

      return count;
    });

    /*
     * Counted against the FILE, not against the candidate list. `candidates`
     * has already had the invalid rows removed, so subtracting from it would
     * report "0 skipped" on a file where twenty-three rows were rejected — the
     * exact reassuring half-truth the old mocked screen gave.
     */
    return { importedRows: imported, skippedRows: job.totalRows - imported };
  }

  /* ---- Reading --------------------------------------------------------- */

  async job(jobId: string) {
    const job = await this.requireJob(jobId);
    const { columns } = await this.readSource(job);
    return serialise(job, columns, null);
  }

  async jobs(): Promise<ImportJobRow[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ job: schema.importJob, requestedByName: schema.appUser.fullName })
        .from(schema.importJob)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.importJob.requestedBy))
        .orderBy(desc(schema.importJob.createdAt))
        .limit(50),
    );

    // The headings are not re-read here: fifty jobs would be fifty file reads
    // for a list that does not show them.
    return rows.map(({ job, requestedByName }) => serialise(job, [], requestedByName));
  }

  /** The row-level report, as a file the clinic corrects and re-uploads. */
  async problemReport(jobId: string): Promise<{ body: Buffer; filename: string }> {
    const job = await this.requireJob(jobId);
    if (!job.errorReportObjectKey) {
      throw new NotFoundException('There is no problem report for that import.');
    }
    return {
      body: await this.storage.get(job.errorReportObjectKey),
      filename: `problems-${job.sourceFilename.replace(/\.[^.]+$/, '')}.csv`,
    };
  }

  /* ---- Internals -------------------------------------------------------- */

  private async requireJob(jobId: string) {
    const job = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.importJob)
        .where(eq(schema.importJob.id, jobId))
        .limit(1);
      return found;
    });
    if (!job) throw new NotFoundException('That import could not be found.');
    return job;
  }

  private async readSource(job: typeof schema.importJob.$inferSelect) {
    const { text } = decodeUpload(await this.storage.get(job.sourceObjectKey));
    const rows = parseCsv(text);
    return { rows, columns: (rows[0] ?? []).map((heading) => heading.trim()) };
  }

  /**
   * Turns rows into candidate patients, collecting every reason one cannot be.
   *
   * Pure, and shared by `validate` and `commit` — the numbers shown to the
   * clinic and the rows inserted come from the same function, which is what
   * stops the preview from describing something other than what happens.
   */
  private examine(
    rows: string[][],
    columns: string[],
    mapping: ImportColumnMapping,
  ): { candidates: Candidate[]; problems: ImportRowProblem[] } {
    const problems: ImportRowProblem[] = [];
    const candidates: Candidate[] = [];

    /** Target field -> index in the row. */
    const index = new Map<string, number>();
    columns.forEach((heading, position) => {
      const target = mapping[heading];
      if (target) index.set(target, position);
    });

    const value = (row: string[], field: string): string => {
      const position = index.get(field);
      return position === undefined ? '' : (row[position] ?? '').trim();
    };

    /** Within the file. Two rows for one person is the commonest mess. */
    const seenMobile = new Map<string, number>();
    const seenNameDob = new Map<string, number>();

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i]!;
      // Row 1 is the heading, so a data row's number matches the spreadsheet.
      const rowNumber = i + 1;

      const fullName = value(row, 'fullName');
      const label = fullName || `Row ${rowNumber}`;
      const rowProblems: ImportRowProblem[] = [];

      if (fullName.length < 2) {
        rowProblems.push({
          rowNumber,
          label,
          field: 'fullName',
          message: 'No name. A patient record cannot be created without one.',
          kind: 'INVALID',
        });
      }

      /*
       * The number is normalised the same way the front desk normalises it —
       * `normalisePhone` — so an import and a walk-in produce the same stored
       * value. Without that, a patient imported as 9876543210 and later
       * registered as +919876543210 is two records that no duplicate check
       * connects.
       */
      let mobileE164: string | null = null;
      const rawMobile = value(row, 'mobileE164');
      if (rawMobile) {
        mobileE164 = normalisePhone(rawMobile);
        if (!mobileE164) {
          rowProblems.push({
            rowNumber,
            label,
            field: 'mobileE164',
            message: `"${rawMobile}" is not a usable mobile number.`,
            kind: 'INVALID',
          });
        }
      }

      const genderResult = parseGender(value(row, 'gender'));
      if (genderResult === null) {
        rowProblems.push({
          rowNumber,
          label,
          field: 'gender',
          message: `"${value(row, 'gender')}" is not a recognised entry. Use M, F, Male, Female or leave it blank.`,
          kind: 'INVALID',
        });
      }

      const rawDob = value(row, 'dateOfBirth');
      let dateOfBirth: string | null = null;
      if (rawDob) {
        dateOfBirth = parseDate(rawDob);
        if (!dateOfBirth) {
          rowProblems.push({
            rowNumber,
            label,
            field: 'dateOfBirth',
            message: `"${rawDob}" could not be read as a date. DD/MM/YYYY and YYYY-MM-DD both work.`,
            kind: 'INVALID',
          });
        }
      }

      const rawAge = value(row, 'ageYears');
      let ageYears: number | null = null;
      if (rawAge) {
        const parsed = Number(rawAge.replace(/[^\d.]/g, ''));
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 130) {
          rowProblems.push({
            rowNumber,
            label,
            field: 'ageYears',
            message: `"${rawAge}" is not an age.`,
            kind: 'INVALID',
          });
        } else {
          ageYears = Math.floor(parsed);
        }
      }

      /*
       * One of the two is required, which is the same rule the registration
       * form enforces. Refusing a patient whose exact birthday nobody recorded
       * is not an option in this market, and neither is a record with no way to
       * compute a dose.
       */
      if (!dateOfBirth && ageYears === null && !rawDob && !rawAge) {
        rowProblems.push({
          rowNumber,
          label,
          field: 'ageYears',
          message:
            'Neither a date of birth nor an age. One of the two is needed — a dose cannot be worked out without it.',
          kind: 'INVALID',
        });
      }

      const rawPincode = value(row, 'pincode');
      let pincode: string | null = null;
      if (rawPincode) {
        const digits = rawPincode.replace(/\D/g, '');
        if (digits.length === 6) {
          pincode = digits;
        } else {
          rowProblems.push({
            rowNumber,
            label,
            field: 'pincode',
            message: `"${rawPincode}" is not a 6-digit pincode.`,
            kind: 'INVALID',
          });
        }
      }

      if (rowProblems.length > 0) {
        problems.push(...rowProblems);
        continue;
      }

      /* ---- duplicates within the file ---- */

      if (dateOfBirth) {
        const key = nameDobKey(fullName, dateOfBirth);
        const earlier = seenNameDob.get(key);
        if (earlier !== undefined) {
          problems.push({
            rowNumber,
            label,
            field: 'fullName',
            message: `The same name and date of birth as row ${earlier}. Only the first is imported.`,
            kind: 'DUPLICATE_IN_FILE',
          });
          continue;
        }
        seenNameDob.set(key, rowNumber);
      }

      /*
       * A repeated number within the file is REPORTED AND IMPORTED, for the same
       * reason as against the live register: a household shares a handset. Only
       * an identical name on the same number is treated as one person.
       */
      if (mobileE164) {
        const earlier = seenMobile.get(`${mobileE164}|${fullName.toLowerCase()}`);
        if (earlier !== undefined) {
          problems.push({
            rowNumber,
            label,
            field: 'mobileE164',
            message: `The same name and number as row ${earlier}. Only the first is imported.`,
            kind: 'DUPLICATE_IN_FILE',
          });
          continue;
        }
        seenMobile.set(`${mobileE164}|${fullName.toLowerCase()}`, rowNumber);
      }

      candidates.push({
        rowNumber,
        fullName,
        mobileE164,
        gender: genderResult ?? 'UNKNOWN',
        dateOfBirth,
        ageYears,
        addressLine1: value(row, 'addressLine1') || null,
        city: value(row, 'city') || null,
        state: value(row, 'state') || null,
        pincode,
        abhaNumber: value(row, 'abhaNumber') || null,
        sourceMrn: value(row, 'mrn') || null,
        skipped: false,
      });
    }

    return { candidates, problems };
  }

  /** Two bulk lookups against the live register, never one per row. */
  private async findExisting(candidates: Candidate[]) {
    const mobiles = [...new Set(candidates.map((c) => c.mobileE164).filter((m): m is string => !!m))];
    const names = [...new Set(candidates.filter((c) => c.dateOfBirth).map((c) => c.fullName.toLowerCase()))];

    return this.tenantDb.runReadOnly(async (tx) => {
      const byMobile = new Map<string, string>();
      const byNameAndDob = new Map<string, string>();

      if (mobiles.length > 0) {
        const rows = await tx
          .select({
            mobileE164: schema.patient.mobileE164,
            fullName: schema.patient.fullName,
            mrn: schema.patient.mrn,
          })
          .from(schema.patient)
          .where(inArray(schema.patient.mobileE164, mobiles));
        for (const row of rows) {
          if (row.mobileE164 && !byMobile.has(row.mobileE164)) {
            byMobile.set(row.mobileE164, `${row.fullName} (${row.mrn})`);
          }
        }
      }

      if (names.length > 0) {
        const rows = await tx
          .select({
            fullName: schema.patient.fullName,
            dateOfBirth: schema.patient.dateOfBirth,
            mrn: schema.patient.mrn,
          })
          .from(schema.patient)
          .where(inArray(sql`lower(${schema.patient.fullName})`, names));
        for (const row of rows) {
          if (!row.dateOfBirth) continue;
          byNameAndDob.set(
            nameDobKey(row.fullName, row.dateOfBirth),
            `${row.fullName} (${row.mrn})`,
          );
        }
      }

      return { byMobile, byNameAndDob };
    });
  }

  /**
   * Writes the report the clinic corrects and re-uploads.
   *
   * IT CARRIES THEIR ORIGINAL COLUMNS, unchanged, beside the reason. That is the
   * point: they open it in the same spreadsheet they exported, fix the twenty-
   * three rows in their own format, and upload that file. A report listing only
   * row numbers and messages would make them go back to the source file and
   * find each line by hand.
   */
  private async writeProblemReport(
    columns: string[],
    rows: string[][],
    problems: ImportRowProblem[],
  ): Promise<string> {
    const byRow = new Map<number, ImportRowProblem[]>();
    for (const problem of problems) {
      const list = byRow.get(problem.rowNumber) ?? [];
      list.push(problem);
      byRow.set(problem.rowNumber, list);
    }

    let csv = csvRow(['Row in your file', 'What to fix', 'Imported?', ...columns]);

    for (const [rowNumber, rowProblems] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const original = rows[rowNumber - 1] ?? [];
      const blocking = rowProblems.some(
        (p) => p.kind === 'INVALID' || p.kind === 'ALREADY_REGISTERED',
      );
      csv += csvRow([
        rowNumber,
        rowProblems.map((p) => p.message).join(' '),
        blocking ? 'No' : 'Yes — check it',
        ...columns.map((_, position) => original[position] ?? ''),
      ]);
    }

    const objectKey = this.storage.buildKey({ category: 'imports', extension: 'csv' });
    await this.storage.putImport(objectKey, Buffer.from(csv, 'utf8'));
    return objectKey;
  }
}

/* --------------------------------------------------------------------------- */

interface Candidate {
  rowNumber: number;
  fullName: string;
  mobileE164: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
  dateOfBirth: string | null;
  ageYears: number | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  abhaNumber: string | null;
  /** Their old record number, kept in the notes rather than as our MRN. */
  sourceMrn: string | null;
  skipped: boolean;
}

function serialise(
  job: typeof schema.importJob.$inferSelect,
  columns: string[],
  requestedByName: string | null,
): ImportJobRow {
  return {
    id: job.id,
    entityType: job.entityType,
    sourceFilename: job.sourceFilename,
    status: job.status as ImportJobRow['status'],
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    duplicateRows: job.duplicateRows,
    importedRows: job.importedRows,
    columnMapping: (job.columnMapping ?? {}) as ImportColumnMapping,
    columns,
    requestedByName,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * Guesses what each column is, from its heading.
 *
 * A GUESS, always shown for confirmation, never applied silently. "Reg No" is
 * the old system's record number in most exports and the registration number of
 * a referring doctor in some, and getting that wrong writes somebody's licence
 * number into a patient's MRN field.
 */
export function suggestMapping(columns: string[]): ImportColumnMapping {
  const mapping: ImportColumnMapping = {};
  const taken = new Set<string>();

  for (const heading of columns) {
    if (!heading) continue;
    const normalised = heading.toLowerCase().trim().replace(/\s+/g, '_');

    const match = IMPORT_TARGET_FIELDS.find(
      (field) =>
        field.field.toLowerCase() === normalised ||
        field.label.toLowerCase().replace(/\s+/g, '_') === normalised ||
        (field.aliases as readonly string[]).includes(normalised),
    );

    // First column to claim a field keeps it, and the rest are left unmapped
    // rather than overwriting — a confirmed blank is better than a wrong guess.
    if (match && !taken.has(match.field)) {
      mapping[heading] = match.field;
      taken.add(match.field);
    } else {
      mapping[heading] = '';
    }
  }

  return mapping;
}

/**
 * What a clinic's old register writes in a sex column.
 *
 * Not a zod enum parse. Real exports hold "M", "F", "Male", "FEMALE", "1"/"2"
 * from a dropdown's index, and occasionally the local-language word. The ones
 * recognised here are the ones that are unambiguous; anything else is reported
 * rather than guessed, because UNKNOWN silently replacing a real value is a
 * record that reads as complete and is not.
 */
export function parseGender(raw: string): Candidate['gender'] | null | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined; // Blank is allowed; it becomes UNKNOWN.
  if (['m', 'male', 'man', 'boy', '1'].includes(value)) return 'MALE';
  if (['f', 'female', 'woman', 'girl', '2'].includes(value)) return 'FEMALE';
  if (['o', 'other', 'transgender', 'tg', '3'].includes(value)) return 'OTHER';
  if (['u', 'unknown', 'not known', 'na', 'n/a', '-'].includes(value)) return 'UNKNOWN';
  return null; // Something was written and it is not recognised. Report it.
}

/**
 * Reads the date formats an Indian clinic's export actually contains.
 *
 * DD/MM/YYYY IS ASSUMED OVER MM/DD/YYYY, and that choice is doing real work:
 * 03/04/1990 is 3 April here and 4 March in an American export, and getting it
 * backwards shifts a birthday by weeks — enough to matter for a paediatric dose
 * and enough to break a date-of-birth duplicate match. Day-first is right for
 * this market and for the systems these clinics are leaving.
 *
 * A day above 12 in the first position is unambiguous, so 25/12/1990 reads
 * correctly either way; the ambiguous ones follow the local convention.
 */
export function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso) return check(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) {
      /*
       * A two-digit year is read as the past. A patient register holds no
       * birthdays in the future, so "58" is 1958 — reading it as 2058 produces
       * a negative age, and reading "05" as 1905 rather than 2005 would make a
       * twenty-year-old a centenarian.
       */
      const currentTwoDigit = new Date().getUTCFullYear() % 100;
      year = year <= currentTwoDigit ? 2000 + year : 1900 + year;
    }
    return check(year, Number(dmy[2]), Number(dmy[1]));
  }

  return null;

  function check(year: number, month: number, day: number): string | null {
    if (year < 1900 || year > new Date().getUTCFullYear()) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Round-tripped through Date, so 31 February is rejected rather than
    // silently rolling into March.
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString().slice(0, 10);
  }
}

function nameDobKey(fullName: string, dateOfBirth: string): string {
  return `${fullName.trim().toLowerCase()}|${dateOfBirth}`;
}

function zip(columns: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  columns.forEach((heading, position) => {
    if (heading) out[heading] = row[position] ?? '';
  });
  return out;
}

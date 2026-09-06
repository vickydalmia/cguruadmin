import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { migrationProfile, migrationRoot } from "./profile-state.js";

export const TAXONOMY_TYPES = ["Store", "Brand", "Category", "Bank"] as const;
export type TaxonomyType = (typeof TAXONOMY_TYPES)[number];

const TAXONOMY_TYPE_BY_KEY = new Map(
  TAXONOMY_TYPES.map((type) => [type.toLowerCase(), type]),
);
const USA_CLASSIFICATION_WORKBOOK =
  "usa/CouponzGuru_USA_Taxonomy_Classification (1).xlsx";
const UAE_CLASSIFICATION_WORKBOOK =
  "uae/CouponzGuru_UAE_Taxonomy_Classification.xlsx";
// Singapore has no ACF `choose_type` either; the operator builds this workbook
// from `sg/sg-stores.csv`. Defaulting the path makes a missing file fail
// loudly instead of silently classifying every term as Store.
const SG_CLASSIFICATION_WORKBOOK =
  "sg/CouponzGuru_SG_Taxonomy_Classification.xlsx";

export interface TaxonomyClassificationRow {
  name: string;
  slug: string;
  classification: TaxonomyType;
  sourceRow: number;
}

export interface TaxonomyClassificationWorkbook {
  file: string;
  rows: TaxonomyClassificationRow[];
  bySlug: Map<string, TaxonomyClassificationRow>;
}

export interface ClassifiableTaxonomyTerm {
  name: string;
  slug: string;
  choose_type: string | null;
}

export interface TaxonomyClassificationReport {
  file: string | null;
  workbookRows: number;
  matchedSourceTerms: number;
  fallbackSourceTerms: number;
  unusedWorkbookRows: number;
  counts: Record<TaxonomyType, number>;
  fallbackTerms: Array<{ name: string; slug: string }>;
  unusedWorkbookTerms: Array<{ name: string; slug: string }>;
}

export interface ClassifiedTaxonomyTerms<T extends ClassifiableTaxonomyTerm> {
  terms: Array<T & { choose_type: TaxonomyType }>;
  report: TaxonomyClassificationReport;
}

export function normalizeTaxonomySlug(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalTaxonomyType(value: string): TaxonomyType | null {
  return TAXONOMY_TYPE_BY_KEY.get(value.trim().toLowerCase()) ?? null;
}

export function taxonomyClassificationFile(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = environment.MIGRATION_CLASSIFICATION_FILE?.trim();
  if (configured) return path.resolve(migrationRoot(), configured);
  const profile = migrationProfile(environment);
  if (profile === "usa") {
    return path.resolve(migrationRoot(), USA_CLASSIFICATION_WORKBOOK);
  }
  if (profile === "ae") {
    return path.resolve(migrationRoot(), UAE_CLASSIFICATION_WORKBOOK);
  }
  if (profile === "sg") {
    return path.resolve(migrationRoot(), SG_CLASSIFICATION_WORKBOOK);
  }
  return null;
}

/**
 * Validate the workbook table as plain rows. Kept pure so malformed headers,
 * classifications and duplicates are covered without requiring file I/O.
 */
export function parseTaxonomyClassificationRows(
  rows: readonly (readonly string[])[],
  file = "taxonomy-classification.xlsx",
): TaxonomyClassificationWorkbook {
  const header = rows[0]?.map((value) => value.trim().toLowerCase()) ?? [];
  const nameIndex = header.indexOf("name");
  const slugIndex = header.indexOf("slug");
  const classificationIndex = header.indexOf("classification");
  const missingHeaders = [
    nameIndex < 0 ? "Name" : null,
    slugIndex < 0 ? "Slug" : null,
    classificationIndex < 0 ? "Classification" : null,
  ].filter(Boolean);
  if (missingHeaders.length > 0) {
    throw new Error(
      `Classification workbook is missing required header(s): ${missingHeaders.join(", ")}`,
    );
  }

  const parsed: TaxonomyClassificationRow[] = [];
  const bySlug = new Map<string, TaxonomyClassificationRow>();
  for (const [index, row] of rows.slice(1).entries()) {
    const sourceRow = index + 2;
    const name = String(row[nameIndex] ?? "").trim();
    const slug = normalizeTaxonomySlug(String(row[slugIndex] ?? ""));
    const rawClassification = String(row[classificationIndex] ?? "").trim();
    if (!name && !slug && !rawClassification) continue;
    if (!name || !slug || !rawClassification) {
      throw new Error(
        `Classification workbook row ${sourceRow} requires Name, Slug and Classification`,
      );
    }
    const classification = canonicalTaxonomyType(rawClassification);
    if (!classification) {
      throw new Error(
        `Classification workbook row ${sourceRow} has unsupported Classification '${rawClassification}'`,
      );
    }
    const existing = bySlug.get(slug);
    if (existing) {
      throw new Error(
        `Classification workbook has duplicate slug '${slug}' on rows ` +
          `${existing.sourceRow} and ${sourceRow}`,
      );
    }
    const parsedRow = { name, slug, classification, sourceRow };
    parsed.push(parsedRow);
    bySlug.set(slug, parsedRow);
  }
  if (parsed.length === 0) {
    throw new Error("Classification workbook contains no taxonomy rows");
  }
  return { file, rows: parsed, bySlug };
}

const workbookCache = new Map<
  string,
  Promise<TaxonomyClassificationWorkbook>
>();

async function readClassificationRowsWithStreamingExcelJs(
  file: string,
): Promise<string[][] | null> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });
  for await (const sheet of workbook) {
    // ExcelJS exposes the streaming worksheet name at runtime but omits it
    // from WorksheetReader's public TypeScript declaration.
    const sheetName = (sheet as typeof sheet & { name: string }).name;
    if (sheetName !== "Classification") continue;
    const rows: string[][] = [];
    for await (const row of sheet) {
      const values: string[] = [];
      for (let column = 1; column <= Math.max(8, row.cellCount); column++) {
        values.push(row.getCell(column).text);
      }
      rows.push(values);
    }
    return rows;
  }
  return null;
}

/**
 * Some workbook generators emit the SpreadsheetML namespace through an `x:`
 * prefix. That is valid OOXML, but ExcelJS 4's readers silently expose those
 * sheets as empty `Sheet1`/`Sheet2` placeholders. Normalize only that prefix
 * in memory and discard table metadata (classification consumes cell values,
 * not the presentation table) before giving the archive back to ExcelJS.
 */
async function readClassificationRowsFromPrefixedOoxml(
  file: string,
): Promise<string[][] | null> {
  const zip = await JSZip.loadAsync(await fsPromises.readFile(file));
  let normalized = false;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.endsWith(".xml")) continue;
    let xml = await entry.async("string");
    if (xml.includes("<x:")) {
      xml = xml
        .replace(
          /xmlns:x="([^"]+)"/u,
          (_match, namespace: string) => `xmlns="${namespace}"`,
        )
        .replaceAll("<x:", "<")
        .replaceAll("</x:", "</");
      normalized = true;
    }
    if (name.startsWith("xl/worksheets/")) {
      xml = xml.replace(/<tableParts[\s\S]*?<\/tableParts>/gu, "");
    }
    zip.file(name, xml);
  }
  if (!normalized) return null;
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("xl/tables/")) zip.remove(name);
  }

  const workbook = new ExcelJS.Workbook();
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  await workbook.xlsx.load(archive as any);
  const sheet = workbook.getWorksheet("Classification");
  if (!sheet) return null;
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= Math.max(8, row.cellCount); column++) {
      values.push(row.getCell(column).text);
    }
    rows.push(values);
  });
  return rows;
}

export function loadTaxonomyClassificationWorkbook(
  file: string,
): Promise<TaxonomyClassificationWorkbook> {
  const resolved = path.resolve(file);
  const cached = workbookCache.get(resolved);
  if (cached) return cached;
  const pending = (async () => {
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Taxonomy classification workbook not found: ${resolved}. ` +
          "Copy the approved Excel file or set MIGRATION_CLASSIFICATION_FILE.",
      );
    }
    const rows =
      (await readClassificationRowsWithStreamingExcelJs(resolved)) ??
      (await readClassificationRowsFromPrefixedOoxml(resolved));
    if (!rows) {
      throw new Error(
        `Taxonomy classification workbook has no 'Classification' sheet: ${resolved}`,
      );
    }
    return parseTaxonomyClassificationRows(rows, resolved);
  })();
  workbookCache.set(resolved, pending);
  return pending;
}

function emptyCounts(): Record<TaxonomyType, number> {
  return { Store: 0, Brand: 0, Category: 0, Bank: 0 };
}

/**
 * Excel is authoritative whenever configured. A source slug absent from the
 * workbook falls back to Store; without Excel (India), legacy choose_type is
 * used with the same Store fallback.
 */
export function applyTaxonomyClassification<T extends ClassifiableTaxonomyTerm>(
  terms: readonly T[],
  workbook: TaxonomyClassificationWorkbook | null,
): ClassifiedTaxonomyTerms<T> {
  const counts = emptyCounts();
  const matchedWorkbookSlugs = new Set<string>();
  const fallbackTerms: Array<{ name: string; slug: string }> = [];
  let matchedSourceTerms = 0;
  const classifiedTerms = terms.map((term) => {
    const slug = normalizeTaxonomySlug(term.slug);
    const workbookRow = workbook?.bySlug.get(slug);
    const legacyType = canonicalTaxonomyType(term.choose_type ?? "");
    const chooseType = workbook
      ? workbookRow?.classification ?? "Store"
      : legacyType ?? "Store";
    if (workbookRow) {
      matchedSourceTerms++;
      matchedWorkbookSlugs.add(slug);
    } else if (workbook) {
      fallbackTerms.push({ name: term.name, slug: term.slug });
    }
    counts[chooseType]++;
    return { ...term, choose_type: chooseType };
  });
  const unusedWorkbookTerms = (workbook?.rows ?? [])
    .filter((row) => !matchedWorkbookSlugs.has(row.slug))
    .map((row) => ({ name: row.name, slug: row.slug }));

  return {
    terms: classifiedTerms,
    report: {
      file: workbook?.file ?? null,
      workbookRows: workbook?.rows.length ?? 0,
      matchedSourceTerms,
      fallbackSourceTerms: fallbackTerms.length,
      unusedWorkbookRows: unusedWorkbookTerms.length,
      counts,
      fallbackTerms,
      unusedWorkbookTerms,
    },
  };
}

export async function classifyTaxonomyTerms<
  T extends ClassifiableTaxonomyTerm,
>(
  terms: readonly T[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClassifiedTaxonomyTerms<T>> {
  const file = taxonomyClassificationFile(environment);
  const workbook = file
    ? await loadTaxonomyClassificationWorkbook(file)
    : null;
  return applyTaxonomyClassification(terms, workbook);
}

export function formatTaxonomyClassificationReport(
  report: TaxonomyClassificationReport,
): string {
  if (!report.file) return "WordPress choose_type (missing/unknown → Store)";
  return (
    `Excel classification: ${report.matchedSourceTerms}/${report.workbookRows} ` +
    `workbook row(s) matched; ${report.fallbackSourceTerms} source term(s) ` +
    `defaulted to Store; ${report.unusedWorkbookRows} workbook row(s) absent ` +
    `from this SQL; Store=${report.counts.Store}, Brand=${report.counts.Brand}, ` +
    `Category=${report.counts.Category}, Bank=${report.counts.Bank}`
  );
}

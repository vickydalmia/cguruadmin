import { cleanHtml } from "./sanitize.js";
import { generateDocumentId } from "./strapi-insert.js";

export const TAXONOMY_DESCRIPTION_TARGETS = {
  Store: { table: "stores", type: "api::store.store" },
  Brand: { table: "brands", type: "api::brand.brand" },
  Category: { table: "categories", type: "api::category.category" },
  Bank: { table: "banks", type: "api::bank.bank" },
} as const;

export type TaxonomyDescriptionTable =
  (typeof TAXONOMY_DESCRIPTION_TARGETS)[keyof typeof TAXONOMY_DESCRIPTION_TARGETS]["table"];

export interface WpTaxonomyDescriptionRow {
  term_id: number;
  name: string;
  slug: string;
  parent: number;
  description: string | null;
  choose_type: string | null;
}

export interface StrapiTaxonomyDescriptionRow {
  id: number;
  document_id: string;
  name: string;
  description: string | null;
  table: TaxonomyDescriptionTable;
}

export interface TaxonomyDescriptionGap {
  termId: number;
  name: string;
  table: TaxonomyDescriptionTable;
  type: string;
  documentId: string;
  entityId: number | null;
  sanitizedDescription: string;
  reason: "missing-entity" | "blank-description";
}

export interface TaxonomyDescriptionCoverage {
  expected: number;
  present: number;
  gaps: TaxonomyDescriptionGap[];
}

export interface TaxonomyDescriptionBackfillOptions {
  apply: boolean;
}

export function parseTaxonomyDescriptionBackfillOptions(
  args: readonly string[],
  targetHost: string,
): TaxonomyDescriptionBackfillOptions {
  const apply = args.includes("--apply");
  if (apply && args.includes("--dry-run")) {
    throw new Error("--apply and --dry-run cannot be used together");
  }

  const confirmation = `--yes-i-mean-${targetHost}`;
  const known = new Set(["--", "--apply", "--dry-run", confirmation]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (apply && !args.includes(confirmation)) {
    throw new Error(
      `Refusing to write to ${targetHost}; pass --apply ${confirmation} to confirm.`,
    );
  }

  return { apply };
}

export function taxonomyDescriptionTarget(chooseType: unknown): {
  table: TaxonomyDescriptionTable;
  type: string;
} {
  if (
    typeof chooseType === "string" &&
    chooseType in TAXONOMY_DESCRIPTION_TARGETS
  ) {
    return TAXONOMY_DESCRIPTION_TARGETS[
      chooseType as keyof typeof TAXONOMY_DESCRIPTION_TARGETS
    ];
  }
  // Phase 03 treats a missing or unknown choose_type as Store.
  return TAXONOMY_DESCRIPTION_TARGETS.Store;
}

export function isBlankTaxonomyDescription(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Compare non-empty, sanitized WordPress term descriptions with their
 * deterministic Strapi entity. Existing Strapi copy is editor-owned and is
 * considered present regardless of whether it differs from WordPress.
 */
export function auditTaxonomyDescriptionCoverage(
  sourceRows: readonly WpTaxonomyDescriptionRow[],
  targetRows: readonly StrapiTaxonomyDescriptionRow[],
  excludedTermIds: ReadonlySet<number> = new Set(),
): TaxonomyDescriptionCoverage {
  const targetByKey = new Map(
    targetRows.map((row) => [`${row.table}:${row.document_id}`, row]),
  );
  const gaps: TaxonomyDescriptionGap[] = [];
  let expected = 0;
  let present = 0;

  for (const source of sourceRows) {
    if (excludedTermIds.has(source.term_id)) continue;
    const sanitizedDescription = cleanHtml(source.description);
    if (!sanitizedDescription) continue;

    expected++;
    const preferredTarget = taxonomyDescriptionTarget(source.choose_type);
    // WordPress choose_type can change after the one-time migration. Resolve
    // the entity that was actually imported by trying the current type first,
    // then the other deterministic Phase-03 document IDs. This backfill must
    // repair content, not silently move a taxonomy between collections.
    const possibleTargets = [
      preferredTarget,
      ...Object.values(TAXONOMY_DESCRIPTION_TARGETS).filter(
        ({ table }) => table !== preferredTarget.table,
      ),
    ];
    let resolvedTarget = preferredTarget;
    let documentId = generateDocumentId(
      `term:${preferredTarget.table}:${source.term_id}`,
    );
    let entity = targetByKey.get(`${preferredTarget.table}:${documentId}`);
    if (!entity) {
      for (const candidate of possibleTargets.slice(1)) {
        const candidateDocumentId = generateDocumentId(
          `term:${candidate.table}:${source.term_id}`,
        );
        const candidateEntity = targetByKey.get(
          `${candidate.table}:${candidateDocumentId}`,
        );
        if (!candidateEntity) continue;
        resolvedTarget = candidate;
        documentId = candidateDocumentId;
        entity = candidateEntity;
        break;
      }
    }

    if (!entity) {
      gaps.push({
        termId: source.term_id,
        name: source.name,
        table: preferredTarget.table,
        type: preferredTarget.type,
        documentId,
        entityId: null,
        sanitizedDescription,
        reason: "missing-entity",
      });
      continue;
    }
    if (isBlankTaxonomyDescription(entity.description)) {
      gaps.push({
        termId: source.term_id,
        name: source.name,
        table: resolvedTarget.table,
        type: resolvedTarget.type,
        documentId,
        entityId: entity.id,
        sanitizedDescription,
        reason: "blank-description",
      });
      continue;
    }
    present++;
  }

  return { expected, present, gaps };
}

import type { Core } from '@strapi/strapi';

import {
  normalizeRelationShorthand,
  type OfferStoreUid,
} from '../utils/content-manager-offer-store-validation';
import {
  relationEntriesWhere,
  resultingRelations,
  type RelationEntry,
} from '../utils/deal-of-the-day-validation';
import { toValidationError, type Problem } from '../utils/write-validation/problems';
import type { DocumentWriteContext } from './content-write-types';

type CloneRelationField = Readonly<{
  field: string;
  target: string;
}>;

type CloneRelationOverride = CloneRelationField & {
  incoming: unknown;
  /** normalizeRelationShorthand(incoming), computed once at filter time. */
  normalized: unknown;
};

export type PreparedCloneRelationOverrides = Readonly<{
  restore: () => void;
  /**
   * Re-read the clone's overridden relation fields inside the transaction and
   * compare against the resolved id sets. The padding encoding below depends
   * on undocumented Strapi clone internals (index-wise fp.merge + relation
   * dedupe); if an upgrade changes them, this converts silently-wrong
   * relations into a thrown error that rolls the clone back.
   */
  verify: (result: unknown) => Promise<void>;
}>;

/**
 * Relations exposed by the custom offer taxonomy editor, plus the inverse
 * Store/Brand fields judged by affiliate validation.
 *
 * Strapi 5 clone deep-populates the source and lodash-merges `params.data`
 * into it. Arrays therefore retain source tail entries, while relation command
 * objects (`connect` / `disconnect` / `set`) are merged as properties on the
 * populated array and ignored by the entity writer. These fields need exact
 * relation semantics because the validators calculate their final state using
 * those same commands.
 *
 * assertCloneRelationFieldCoverage below pins this table against the live
 * schemas at startup, so a NEW relation field cannot silently fall back to
 * the broken merge.
 */
const CLONE_RELATION_FIELDS: Readonly<
  Partial<
    Record<
      OfferStoreUid | 'api::store.store' | 'api::brand.brand',
      readonly CloneRelationField[]
    >
  >
> = {
  'api::coupon.coupon': [
    { field: 'stores', target: 'api::store.store' },
    { field: 'brands', target: 'api::brand.brand' },
    { field: 'categories', target: 'api::category.category' },
    { field: 'banks', target: 'api::bank.bank' },
  ],
  'api::deal.deal': [
    { field: 'stores', target: 'api::store.store' },
    { field: 'brands', target: 'api::brand.brand' },
    { field: 'categories', target: 'api::category.category' },
    { field: 'banks', target: 'api::bank.bank' },
  ],
  'api::store.store': [
    { field: 'coupons', target: 'api::coupon.coupon' },
    { field: 'deals', target: 'api::deal.deal' },
  ],
  'api::brand.brand': [
    { field: 'coupons', target: 'api::coupon.coupon' },
    { field: 'deals', target: 'api::deal.deal' },
  ],
};

/**
 * Editable many-to-many relations that are DELIBERATELY not overridden:
 * they are never present in a Content Manager clone payload — both are
 * written exclusively through the /entity-coupon-layout admin routes, so
 * the broken clone merge cannot be reached for them.
 */
const CLONE_RELATION_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  'api::store.store': ['topPickCoupons', 'orderedCoupons'],
  'api::brand.brand': ['topPickCoupons', 'orderedCoupons'],
};

/**
 * Boot-time guard for CLONE_RELATION_FIELDS: every manyToMany relation
 * between the managed entity types must be either overridden or explicitly
 * excluded above. A schema gaining a relation field without a decision here
 * fails startup loudly instead of silently handing that field back to
 * Strapi's broken clone merge.
 */
export function assertCloneRelationFieldCoverage(strapi: Core.Strapi): void {
  const problems: string[] = [];
  for (const [uid, configured] of Object.entries(CLONE_RELATION_FIELDS)) {
    const attributes: Record<string, any> | undefined = (
      strapi.contentTypes as any
    )?.[uid]?.attributes;
    if (!attributes) {
      problems.push(`${uid}: content type not found`);
      continue;
    }
    const covered = new Set([
      ...(configured ?? []).map(({ field }) => field),
      ...(CLONE_RELATION_EXCLUSIONS[uid] ?? []),
    ]);
    const managedTargets = new Set(Object.keys(CLONE_RELATION_FIELDS));
    for (const [field, attribute] of Object.entries(attributes)) {
      if (attribute?.type !== 'relation') continue;
      if (attribute?.relation !== 'manyToMany') continue;
      if (!managedTargets.has(attribute?.target)) continue;
      if (!covered.has(field)) {
        problems.push(
          `${uid}.${field} (→ ${attribute.target}) is not listed in ` +
            `CLONE_RELATION_FIELDS or CLONE_RELATION_EXCLUSIONS`,
        );
      }
    }
  }
  if (problems.length) {
    throw new Error(
      `[clone-relation-overrides] schema drift — decide whether these ` +
        `relation fields need clone override coverage:\n  ` +
        problems.join('\n  '),
    );
  }
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const relationMissingError = (field: string) =>
  toValidationError([
    {
      path: [field],
      message:
        'One or more selected relations no longer exist. Reload the entry and try again.',
    },
  ]);

type RelationRowIndex = Readonly<{
  byDocumentId: Map<string, any>;
  byId: Map<string, any>;
}>;

function indexRelationRows(rows: readonly any[]): RelationRowIndex {
  const byDocumentId = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const row of rows) {
    if (typeof row?.documentId === 'string') byDocumentId.set(row.documentId, row);
    if (row?.id !== undefined && row?.id !== null) byId.set(String(row.id), row);
  }
  return { byDocumentId, byId };
}

/**
 * Resolve one payload entry to its row. documentId takes STRICT precedence
 * over a raw id, mirroring Strapi core (data-ids.js discards the id whenever
 * documentId is present) — matching by "any shared key" would let a stale
 * numeric id silently win over a valid documentId and link the wrong row.
 * A bare numeric string is this repo's documentId convention first, core's
 * entity-id convention second.
 */
function rowForEntry(index: RelationRowIndex, entry: RelationEntry): any {
  if (typeof entry === 'number') return index.byId.get(String(entry));
  if (typeof entry === 'string') {
    return (
      index.byDocumentId.get(entry) ??
      (/^\d+$/.test(entry) ? index.byId.get(entry) : undefined)
    );
  }
  if (!entry || typeof entry !== 'object') return undefined;
  if (typeof entry.documentId === 'string') {
    return index.byDocumentId.get(entry.documentId);
  }
  if (entry.id !== undefined && entry.id !== null) {
    return index.byId.get(String(entry.id));
  }
  return undefined;
}

async function resolveRelationIds(
  strapi: Core.Strapi,
  target: string,
  field: string,
  entries: readonly RelationEntry[],
): Promise<Array<string | number>> {
  if (entries.length === 0) return [];
  const where = relationEntriesWhere(entries);
  if (!where) {
    throw toValidationError([
      { path: [field], message: 'One or more selected relations are invalid.' },
    ]);
  }

  const rows: any[] = await strapi.db.query(target as any).findMany({
    where,
    select: ['id', 'documentId'],
  });
  const index = indexRelationRows(rows);
  const resolved: Array<string | number> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const row = rowForEntry(index, entry);
    if (row?.id === undefined || row?.id === null) {
      throw relationMissingError(field);
    }
    const key = String(row.id);
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(row.id);
    }
  }
  return resolved;
}

/**
 * Entries the payload NAMES outright (a plain array, or `set`/`connect`
 * members). Disconnect targets and inherited baseline entries are not named —
 * their absence cannot make the final state reference a missing row.
 */
function namedRelationEntries(normalized: unknown): RelationEntry[] {
  if (Array.isArray(normalized)) return normalized;
  if (!normalized || typeof normalized !== 'object') return [];
  const patch = normalized as {
    set?: RelationEntry[] | null;
    connect?: RelationEntry[];
  };
  return [
    ...(Array.isArray(patch.set) ? patch.set : []),
    ...(Array.isArray(patch.connect) ? patch.connect : []),
  ];
}

/**
 * ADVISORY existence check for the collected validation pass, so a vanished
 * relation aggregates with every other problem of the save instead of
 * surfacing alone on the NEXT save (the pipeline's one-save-reports-every-
 * problem contract). The in-transaction resolver in
 * prepareCloneRelationOverrides stays the race-proof authority — this pass
 * runs before the locks and can miss a concurrent delete.
 */
export async function collectCloneRelationProblems(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
): Promise<Problem[]> {
  if (action !== 'clone' || !data || typeof data !== 'object') return [];
  const configured =
    CLONE_RELATION_FIELDS[uid as keyof typeof CLONE_RELATION_FIELDS];
  if (!configured?.length) return [];

  const problems: Problem[] = [];
  for (const { field, target } of configured) {
    if (!hasOwn(data, field)) continue;
    const normalized = normalizeRelationShorthand(
      (data as Record<string, unknown>)[field],
    );
    if (resultingRelations(normalized, []) === null) continue;
    const named = namedRelationEntries(normalized);
    if (named.length === 0) continue;
    const where = relationEntriesWhere(named);
    if (!where) continue;
    const rows: any[] = await strapi.db.query(target as any).findMany({
      where,
      select: ['id', 'documentId'],
    });
    const index = indexRelationRows(rows);
    if (named.some((entry) => !rowForEntry(index, entry))) {
      problems.push({
        path: [field],
        message:
          'One or more selected relations no longer exist. Reload the entry and try again.',
      });
    }
  }
  return problems;
}

/**
 * Replace supported relation operations with an exact numeric-id array that
 * survives Strapi's clone merge. A non-empty array is padded with a duplicate
 * of its first id to the copied source length: lodash overwrites every source
 * index, then Strapi deduplicates relation ids. An empty final set uses null,
 * which replaces the whole source array and means "attach nothing".
 *
 * The source row is locked before its relations are read. That makes this
 * baseline the same one core clone will read later in this transaction, even
 * when a category/bank-only update (which has no affiliate advisory lock)
 * races the clone. `restore()` must run in finally so ISR scope calculation
 * still sees the caller's original payload; `verify()` must run on the write
 * result BEFORE commit (see PreparedCloneRelationOverrides).
 */
export async function prepareCloneRelationOverrides(
  strapi: Core.Strapi,
  context: DocumentWriteContext,
  trx: any,
): Promise<PreparedCloneRelationOverrides> {
  const noop: PreparedCloneRelationOverrides = {
    restore: () => {},
    verify: async () => {},
  };
  const data = context.params?.data;
  const configured =
    CLONE_RELATION_FIELDS[
      context.uid as keyof typeof CLONE_RELATION_FIELDS
    ];
  if (context.action !== 'clone' || !data || !configured?.length) {
    return noop;
  }

  const fields: CloneRelationOverride[] = [];
  for (const config of configured) {
    if (!hasOwn(data, config.field)) continue;
    const incoming = data[config.field];
    const normalized = normalizeRelationShorthand(incoming);
    // Only intercept shapes whose final state is well-defined by the same
    // resolver the validators use. Unknown shapes remain Strapi's concern.
    if (resultingRelations(normalized, []) === null) continue;
    fields.push({ ...config, incoming, normalized });
  }
  if (fields.length === 0) return noop;

  const documentId = context.params?.documentId;
  if (typeof documentId === 'string' && documentId) {
    const metadata = (strapi.db as any)?.metadata?.get?.(context.uid);
    const tableName = metadata?.tableName;
    const idColumn = metadata?.attributes?.id?.columnName;
    const documentIdColumn = metadata?.attributes?.documentId?.columnName;
    if (
      typeof trx !== 'function' ||
      typeof tableName !== 'string' ||
      typeof idColumn !== 'string' ||
      typeof documentIdColumn !== 'string'
    ) {
      throw new Error('Cannot lock the source row for clone relation overrides');
    }
    await trx(tableName)
      .select(idColumn)
      .where(documentIdColumn, documentId)
      .forUpdate();
  }

  const current: any =
    typeof documentId === 'string' && documentId
      ? await strapi.db.query(context.uid as any).findOne({
          where: { documentId },
          select: ['id', 'documentId'],
          populate: Object.fromEntries(
            fields.map(({ field }) => [
              field,
              { select: ['id', 'documentId'] },
            ]),
          ),
        })
      : null;

  const replacements: Array<{
    field: string;
    value: Array<string | number> | null;
  }> = [];
  for (const { field, target, normalized } of fields) {
    const baseline: RelationEntry[] = Array.isArray(current?.[field])
      ? current[field]
      : [];
    // Never null: resultingRelations' null-ness depends only on the payload
    // SHAPE (array / set / connect+disconnect), which the filter above
    // already accepted against an empty baseline. The fallback merely
    // satisfies the type-checker.
    const desired = resultingRelations(normalized, baseline) ?? [];
    const ids = await resolveRelationIds(strapi, target, field, desired);
    replacements.push(
      ids.length === 0
        ? { field, value: null }
        : {
            field,
            value: [
              ...ids,
              ...Array(Math.max(0, baseline.length - ids.length)).fill(ids[0]),
            ],
          },
    );
  }

  for (const { field, value } of replacements) data[field] = value;

  return {
    restore: () => {
      for (const { field, incoming } of fields) data[field] = incoming;
    },
    verify: async (result: unknown) => {
      const cloneDocumentId = (result as any)?.documentId;
      if (typeof cloneDocumentId !== 'string' || !cloneDocumentId) {
        // No document to check against — nothing was written.
        return;
      }
      // db.query joins the ambient transaction, so this reads the
      // uncommitted clone.
      const row: any = await strapi.db.query(context.uid as any).findOne({
        where: { documentId: cloneDocumentId },
        select: ['id'],
        populate: Object.fromEntries(
          replacements.map(({ field }) => [field, { select: ['id'] }]),
        ),
      });
      for (const { field, value } of replacements) {
        // Padding duplicates collapse: the expectation is the unique id set.
        const expected = new Set((value ?? []).map(String));
        const attached: any[] = Array.isArray(row?.[field]) ? row[field] : [];
        const actual = new Set(attached.map((entry) => String(entry?.id)));
        const matches =
          expected.size === actual.size &&
          [...expected].every((key) => actual.has(key));
        if (!matches) {
          throw new Error(
            `[clone-relation-overrides] ${context.uid}.${field}: the clone ` +
              `holds ${actual.size} relation(s) where ${expected.size} were ` +
              `resolved — Strapi's clone merge internals no longer honour ` +
              `the override encoding. Rolling the clone back.`,
          );
        }
      }
    },
  };
}

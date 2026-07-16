import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  DOTD_SECTION_CAPS,
  DOTD_UID,
} from '../constants/deal-of-the-day-sections';

const LIMITED_SECTIONS = [
  ['topPicks', DOTD_SECTION_CAPS.topPicks, 'Top Picks'],
  ['smartSavingStack', DOTD_SECTION_CAPS.smartSavingStack, 'Smart Saving Stack'],
  ['genZDrops', DOTD_SECTION_CAPS.genZDrops, 'Gen-Z Drops'],
] as const;

export type RelationEntry = string | number | Record<string, unknown>;
type Problem = { path: string[]; message: string };

export function relationKeys(entry: unknown): string[] {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return [String(entry)];
  }
  if (!entry || typeof entry !== 'object') return [];

  const value = entry as Record<string, unknown>;
  return [value.documentId, value.id]
    .filter((key): key is string | number =>
      typeof key === 'string' || typeof key === 'number'
    )
    .map(String);
}

function sameRelation(left: unknown, right: unknown): boolean {
  const rightKeys = new Set(relationKeys(right));
  return relationKeys(left).some((key) => rightKeys.has(key));
}

function uniqueRelations(entries: readonly RelationEntry[]): RelationEntry[] {
  const unique: RelationEntry[] = [];
  for (const entry of entries) {
    if (!relationKeys(entry).length) continue;
    if (!unique.some((candidate) => sameRelation(candidate, entry))) {
      unique.push(entry);
    }
  }
  return unique;
}

export function resultingRelations(
  incoming: unknown,
  current: readonly RelationEntry[] = []
): RelationEntry[] | null {
  if (Array.isArray(incoming)) return uniqueRelations(incoming);
  if (!incoming || typeof incoming !== 'object') return null;

  const patch = incoming as {
    set?: RelationEntry[] | null;
    connect?: RelationEntry[];
    disconnect?: RelationEntry[];
  };
  if ('set' in patch) return uniqueRelations(patch.set ?? []);
  if (!Array.isArray(patch.connect) && !Array.isArray(patch.disconnect)) {
    return null;
  }

  let result = uniqueRelations(current);
  for (const entry of patch.disconnect ?? []) {
    result = result.filter((candidate) => !sameRelation(candidate, entry));
  }
  return uniqueRelations([...result, ...(patch.connect ?? [])]);
}

// Content Manager sends relation patches as { connect, disconnect }, while
// REST/document callers may use { set } or a direct array. Resolve the final
// cardinality against the stored relation so every write path is covered.
export function resultingRelationCount(
  incoming: unknown,
  current: readonly RelationEntry[] = []
): number | null {
  return resultingRelations(incoming, current)?.length ?? null;
}

export async function validateDealOfTheDaySectionLimits(
  strapi: Core.Strapi,
  data: any
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const touched = LIMITED_SECTIONS.filter(([section]) =>
    Object.prototype.hasOwnProperty.call(data, section)
  );
  if (!touched.length) return;

  const current = await strapi.db.query(DOTD_UID).findOne({
    populate: Object.fromEntries(
      touched.map(([section]) => [section, { populate: ['deals'] }])
    ) as any,
  });
  const problems: Problem[] = [];

  for (const [section, max, label] of touched) {
    const incomingDeals = data[section]?.deals;
    if (incomingDeals === undefined) continue;
    const count = resultingRelationCount(
      incomingDeals,
      current?.[section]?.deals ?? []
    );
    if (count != null && count > max) {
      problems.push({
        path: [section, 'deals'],
        message:
          `${label} accepts at most ${max} Deals (${max / 2} shown + ` +
          `${max / 2} buffered for expiry). Remove ${count - max} Deal` +
          `${count - max === 1 ? '' : 's'}.`,
      });
    }
  }

  if (!problems.length) return;
  throw new errors.ValidationError(
    `Deal of the Day limits exceeded:\n• ${problems
      .map((problem) => `${problem.path.join('.')}: ${problem.message}`)
      .join('\n• ')}`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(
        (problem) => `${problem.path.join('.')}: ${problem.message}`
      ),
    }
  );
}

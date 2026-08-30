import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import {
  DOTD_SECTION_CAPS,
  DOTD_SMART_STACK_MINIMUM,
  DOTD_UID,
} from '../constants/deal-of-the-day-sections';

const LIMITED_SECTIONS = [
  [
    'topPicks',
    DOTD_SECTION_CAPS.topPicks,
    'Top Picks',
    `${DOTD_SECTION_CAPS.topPicks / 2} shown + ${DOTD_SECTION_CAPS.topPicks / 2} buffered for expiry`,
  ],
  [
    'genZDrops',
    DOTD_SECTION_CAPS.genZDrops,
    'Gen-Z Drops',
    `${DOTD_SECTION_CAPS.genZDrops / 2} shown + ${DOTD_SECTION_CAPS.genZDrops / 2} buffered for expiry`,
  ],
  [
    'allDeals',
    DOTD_SECTION_CAPS.allDeals,
    'All Deals',
    '9 shown first, the rest behind load-more',
  ],
] as const;

export type RelationEntry = string | number | Record<string, unknown>;
type Problem = { path: string[]; message: string };
const DEAL_UID = 'api::deal.deal';

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

function dealRelationWhere(relations: readonly RelationEntry[]) {
  const ids = new Set<string | number>();
  const documentIds = new Set<string>();

  for (const relation of relations) {
    if (typeof relation === 'number') {
      ids.add(relation);
      continue;
    }
    if (typeof relation === 'string') {
      documentIds.add(relation);
      continue;
    }
    if (!relation || typeof relation !== 'object') continue;
    const id = relation.id;
    const documentId = relation.documentId;
    if (typeof id === 'string' || typeof id === 'number') ids.add(id);
    if (typeof documentId === 'string') documentIds.add(documentId);
  }

  const clauses: Record<string, unknown>[] = [];
  if (ids.size) clauses.push({ id: { $in: [...ids] } });
  if (documentIds.size) {
    clauses.push({ documentId: { $in: [...documentIds] } });
  }
  return clauses.length ? { $or: clauses } : null;
}

async function qualifyingSmartStackDealCount(
  strapi: Core.Strapi,
  relations: readonly RelationEntry[],
  locale?: string
): Promise<number> {
  const where = dealRelationWhere(relations);
  if (!where) return 0;

  // documentId matches every locale row of a deal; without the locale pin
  // each selected deal would count once per locale.
  const deals = await strapi.db.query(DEAL_UID).findMany({
    where: { $and: [{ locale: locale ?? DEFAULT_CONTENT_LOCALE }, where] },
    select: ['id', 'documentId', 'cashbackText', 'bankOfferText'],
  });
  return deals.filter(
    (deal: any) =>
      typeof deal?.cashbackText === 'string' &&
      deal.cashbackText.trim().length > 0 &&
      typeof deal?.bankOfferText === 'string' &&
      deal.bankOfferText.trim().length > 0
  ).length;
}

const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/iu;

/**
 * Telegram items wrap a Deal with a per-section unlock destination. The
 * override is optional — an empty value deliberately falls back to the Deal's
 * affiliate link — but a value that IS entered must be a complete http(s) URL,
 * because the frontend drops anything unsafe and would silently fall back,
 * hiding the editor's mistake. The item cap is enforced here too: the schema
 * `max` guards the admin form, and this guards every other write path.
 */
function collectTelegramItemProblems(data: any, problems: Problem[]): void {
  const items = data?.telegramDeals?.items;
  if (!Array.isArray(items)) return;

  if (items.length > DOTD_SECTION_CAPS.telegramDeals) {
    problems.push({
      path: ['telegramDeals', 'items'],
      message:
        `Telegram Exclusive accepts at most ${DOTD_SECTION_CAPS.telegramDeals} Deals ` +
        `(the site shows 3, the rest are buffered for expiry). ` +
        `Remove ${items.length - DOTD_SECTION_CAPS.telegramDeals}.`,
    });
  }

  items.forEach((item: any, index: number) => {
    const override = item?.linkOverride;
    if (typeof override !== 'string' || override.trim() === '') return;
    if (HTTP_URL_PATTERN.test(override.trim())) return;
    problems.push({
      path: ['telegramDeals', 'items', String(index), 'linkOverride'],
      message:
        'Telegram link must be a complete http(s) URL without spaces. ' +
        'Leave it empty to use the deal’s affiliate link.',
    });
  });
}

export async function validateDealOfTheDaySectionLimits(
  strapi: Core.Strapi,
  data: any,
  locale?: string
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const touchedLimited = LIMITED_SECTIONS.filter(([section]) =>
    Object.prototype.hasOwnProperty.call(data, section)
  );
  const smartStackTouched = Object.prototype.hasOwnProperty.call(
    data,
    'smartSavingStack'
  );
  const telegramTouched = Object.prototype.hasOwnProperty.call(
    data,
    'telegramDeals'
  );
  if (!touchedLimited.length && !smartStackTouched && !telegramTouched) return;

  const touchedSections = [
    ...touchedLimited.map(([section]) => section),
    ...(smartStackTouched ? ['smartSavingStack'] : []),
  ];

  // Only relation-backed sections need the stored row to resolve a partial
  // relation command. Telegram items arrive as a complete component list, so
  // a telegram-only write skips the query entirely. The read is pinned to
  // the locale being written — the single type holds one row per locale.
  const current = touchedSections.length
    ? await strapi.db.query(DOTD_UID).findOne({
        where: { locale: locale ?? DEFAULT_CONTENT_LOCALE },
        populate: Object.fromEntries(
          touchedSections.map((section) => [section, { populate: ['deals'] }])
        ) as any,
      })
    : null;
  const problems: Problem[] = [];

  for (const [section, max, label, detail] of touchedLimited) {
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
          `${label} accepts at most ${max} Deals (${detail}). ` +
          `Remove ${count - max} Deal${count - max === 1 ? '' : 's'}.`,
      });
    }
  }

  if (smartStackTouched) {
    const incomingSection = data.smartSavingStack;
    const enabled =
      incomingSection?.enabled ??
      current?.smartSavingStack?.enabled ??
      true;
    if (enabled !== false) {
      const relations =
        incomingSection?.deals === undefined
          ? (current?.smartSavingStack?.deals ?? [])
          : resultingRelations(
              incomingSection.deals,
              current?.smartSavingStack?.deals ?? []
            );
      const count =
        relations == null
          ? null
          : await qualifyingSmartStackDealCount(strapi, relations, locale);
      if (count != null && count < DOTD_SMART_STACK_MINIMUM) {
        problems.push({
          path: ['smartSavingStack', 'deals'],
          message:
            `Smart Saving Stack requires at least ${DOTD_SMART_STACK_MINIMUM} eligible Deals ` +
            `with Cashback Text and Bank Offer Text when enabled. ` +
            `Add ${DOTD_SMART_STACK_MINIMUM - count} more ` +
            `eligible Deal${DOTD_SMART_STACK_MINIMUM - count === 1 ? '' : 's'}.`,
        });
      }
    }
  }

  collectTelegramItemProblems(data, problems);

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

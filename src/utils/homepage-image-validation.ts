import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  HOMEPAGE_IMAGE_RULES,
  type HomepageImageRule,
} from '../constants/homepage-images';

// Media values arrive as file objects ({ id, ... }) from the admin content
// manager, bare numeric ids from programmatic calls, or { set: [...] }
// connectors. Payload width/height can be stale, so dimensions are always
// re-read from plugin::upload.file.
const fileIdOf = (value: unknown): number | null => {
  if (value == null) return null;
  if (Array.isArray(value)) return fileIdOf(value[0]);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return fileIdOf(obj.set ?? obj.id);
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

type Occurrence = {
  rule: HomepageImageRule;
  fileId: number | null;
  /** Whether the media key exists on the row (absent on partial payloads). */
  hasField: boolean;
  /** Admin-facing location, e.g. "hero › banners #2 › desktopImage". */
  where: string;
};

// Resolve 'section.rows[].field' rule paths against a homepage-shaped object
// (either the incoming payload or the stored entry). Sections and rows absent
// from a partial payload are skipped — the stored data is untouched, so there
// is nothing to validate for them.
function collectOccurrences(root: any, rules: HomepageImageRule[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const rule of rules) {
    const [sectionKey, listKey] = rule.path.split('.');
    const listField = listKey.replace('[]', '');
    const rows = root?.[sectionKey]?.[listField];
    if (!Array.isArray(rows)) continue;

    rows.forEach((row: any, index: number) => {
      if (row == null || typeof row !== 'object') return;
      const hasField = rule.field in row;
      out.push({
        rule,
        hasField,
        fileId: hasField ? fileIdOf(row[rule.field]) : null,
        where: `${sectionKey} › ${listField} #${index + 1} › ${rule.field}`,
      });
    });
  }
  return out;
}

// Narrow db-layer populate of just the rule'd media on the stored homepage —
// used to grandfather already-assigned files so legacy images never block
// unrelated edits. strapi.db.query (not strapi.documents) so the documents
// middleware is never re-entered.
const CURRENT_MEDIA_POPULATE = {
  hero: {
    populate: {
      banners: { populate: ['desktopImage', 'mobileImage'] },
      products: { populate: ['imageOverride'] },
    },
  },
  topOffers: { populate: { items: { populate: ['banner'] } } },
  cgExclusive: { populate: { items: { populate: ['bannerOverride'] } } },
  newlyAdded: { populate: { items: { populate: ['cardImage'] } } },
};

/**
 * Validates homepage section images against HOMEPAGE_IMAGE_RULES.
 *
 * - Required rules fail when a row is saved with the media field empty.
 * - Newly assigned files must match the rule's exact width × height.
 * - Files already attached anywhere in the rule'd fields of the stored entry
 *   are grandfathered (id-based, order-insensitive), so pre-existing images
 *   never block unrelated homepage edits.
 *
 * Throws errors.ValidationError (400 in the admin) listing every problem.
 */
export async function validateHomepageImages(
  strapi: Core.Strapi,
  data: any
): Promise<void> {
  if (!data || typeof data !== 'object') return;

  const occurrences = collectOccurrences(data, HOMEPAGE_IMAGE_RULES);
  if (!occurrences.length) return;

  const problems: string[] = [];

  for (const o of occurrences) {
    if (o.rule.required && o.hasField && o.fileId == null) {
      problems.push(
        `${o.where}: ${o.rule.label} is required ` +
          `(${o.rule.width}×${o.rule.height} px).`
      );
    }
  }

  const assigned = occurrences.filter((o) => o.fileId != null);
  if (assigned.length) {
    const current = await strapi.db
      .query('api::homepage.homepage')
      .findOne({ populate: CURRENT_MEDIA_POPULATE as any });
    const grandfathered = new Set(
      collectOccurrences(current ?? {}, HOMEPAGE_IMAGE_RULES)
        .map((o) => o.fileId)
        .filter((id): id is number => id != null)
    );

    const toCheck = assigned.filter((o) => !grandfathered.has(o.fileId!));
    if (toCheck.length) {
      const ids = [...new Set(toCheck.map((o) => o.fileId!))];
      const files = await strapi.db.query('plugin::upload.file').findMany({
        where: { id: { $in: ids } },
        select: ['id', 'name', 'width', 'height'],
      });
      const byId = new Map<number, any>(files.map((f: any) => [f.id, f]));

      for (const o of toCheck) {
        const file = byId.get(o.fileId!);
        // Deleted mid-flight — core relation validation reports it.
        if (!file) continue;
        if (file.width !== o.rule.width || file.height !== o.rule.height) {
          problems.push(
            `${o.where}: must be exactly ${o.rule.width}×${o.rule.height} px ` +
              `(2x of ${o.rule.display[0]}×${o.rule.display[1]}), ` +
              `got ${file.width ?? '?'}×${file.height ?? '?'} ("${file.name}").`
          );
        }
      }
    }
  }

  if (problems.length) {
    throw new errors.ValidationError(
      `Homepage image check failed:\n• ${problems.join('\n• ')}`,
      { problems }
    );
  }
}

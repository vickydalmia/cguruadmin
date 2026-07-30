import { readFileSync } from "fs";

const META_KEYS = ["_kksr_avg", "_kksr_casts", "_kksr_ratings"] as const;
type MetaKey = (typeof META_KEYS)[number];

export interface KksrRating {
  taxonomyId: number;
  taxonomyName: string;
  taxonomySlug: string;
  average: number;
  casts: number;
  score: number;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === '"') {
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  fields.push(field);
  return fields;
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer, got "${value}"`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
}

function sameMetaValue(key: MetaKey, left: string, right: string): boolean {
  return key === "_kksr_avg"
    ? Number(left) === Number(right)
    : left === right;
}

export function parseKksrCsv(content: string): KksrRating[] {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("KKSR CSV is empty");

  const headers = parseCsvLine(lines[0]);
  const required = [
    "meta_id",
    "taxonomy_id",
    "taxonomy_name",
    "taxonomy_slug",
    "meta_key",
    "meta_value",
  ];
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const missing = required.filter((header) => !indexes.has(header));
  if (missing.length > 0) throw new Error(`KKSR CSV is missing column(s): ${missing.join(", ")}`);

  type RawTaxonomy = {
    name: string;
    slug: string;
    values: Partial<Record<MetaKey, { metaId: number; value: string }>>;
  };
  const taxonomies = new Map<number, RawTaxonomy>();
  const at = (fields: string[], name: string) => fields[indexes.get(name)!] ?? "";

  for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
    const fields = parseCsvLine(lines[lineNumber - 1]);
    const taxonomyId = parseNonNegativeInteger(
      at(fields, "taxonomy_id"),
      `line ${lineNumber} taxonomy_id`,
    );
    const metaId = parseNonNegativeInteger(at(fields, "meta_id"), `line ${lineNumber} meta_id`);
    const metaKey = at(fields, "meta_key") as MetaKey;
    if (!META_KEYS.includes(metaKey)) {
      throw new Error(`line ${lineNumber} has unsupported meta_key "${metaKey}"`);
    }
    const value = at(fields, "meta_value").trim();
    const name = at(fields, "taxonomy_name");
    const slug = at(fields, "taxonomy_slug");
    const taxonomy = taxonomies.get(taxonomyId) ?? { name, slug, values: {} };
    if (taxonomy.name !== name || taxonomy.slug !== slug) {
      throw new Error(`taxonomy ${taxonomyId} has conflicting names or slugs`);
    }

    const previous = taxonomy.values[metaKey];
    if (previous && !sameMetaValue(metaKey, previous.value, value)) {
      throw new Error(
        `taxonomy ${taxonomyId} has conflicting ${metaKey} values ` +
          `("${previous.value}" and "${value}")`,
      );
    }
    // Identical duplicate rows are harmless. Keep the newest WordPress meta row.
    if (!previous || metaId > previous.metaId) taxonomy.values[metaKey] = { metaId, value };
    taxonomies.set(taxonomyId, taxonomy);
  }

  const ratings: KksrRating[] = [];
  for (const [taxonomyId, taxonomy] of taxonomies) {
    const missingKeys = META_KEYS.filter((key) => !taxonomy.values[key]);
    if (missingKeys.length > 0) {
      throw new Error(`taxonomy ${taxonomyId} is missing ${missingKeys.join(", ")}`);
    }
    const average = Number(taxonomy.values._kksr_avg!.value);
    const casts = parseNonNegativeInteger(
      taxonomy.values._kksr_casts!.value,
      `taxonomy ${taxonomyId} _kksr_casts`,
    );
    const score = parseNonNegativeInteger(
      taxonomy.values._kksr_ratings!.value,
      `taxonomy ${taxonomyId} _kksr_ratings`,
    );
    if (!Number.isFinite(average) || average < 0 || average > 5) {
      throw new Error(`taxonomy ${taxonomyId} has invalid _kksr_avg "${average}"`);
    }
    const calculated = casts === 0 ? 0 : Math.round((score / casts) * 100) / 100;
    if (Math.abs(average - calculated) > 0.001) {
      throw new Error(
        `taxonomy ${taxonomyId} average ${average} does not match score/casts (${calculated})`,
      );
    }
    ratings.push({
      taxonomyId,
      taxonomyName: taxonomy.name,
      taxonomySlug: taxonomy.slug,
      average,
      casts,
      score,
    });
  }
  return ratings.sort((left, right) => left.taxonomyId - right.taxonomyId);
}

export function readKksrCsv(filePath: string): KksrRating[] {
  return parseKksrCsv(readFileSync(filePath, "utf8"));
}

export function combineKksrWithNewVotes(
  legacy: Pick<KksrRating, "casts" | "score">,
  newVoteCount: number,
  newVoteScore: number,
): { ratingAverage: number; ratingCount: number } {
  const ratingCount = legacy.casts + newVoteCount;
  const ratingAverage =
    ratingCount === 0
      ? 0
      : Math.round(((legacy.score + newVoteScore) / ratingCount) * 100) / 100;
  return { ratingAverage, ratingCount };
}

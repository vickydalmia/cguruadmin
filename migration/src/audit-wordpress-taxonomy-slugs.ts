import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeWp, wpQuery } from "./db/wp-client.js";

type Mapping = {
  sourceLine: number;
  displayName: string;
  expectedType: string;
  oldCompleteSlug: string;
  oldLeafSlug: string;
  oldParentSlug: string | null;
  newSlug: string;
};

type LiveTerm = {
  term_id: number;
  term_taxonomy_id: number;
  name: string;
  slug: string;
  parent: number;
  actual_type: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  path.resolve(
    scriptDir,
    "../sql/2026-07-30-update-wordpress-taxonomy-slugs.sql",
  ),
  "utf8",
);

const valuesStart = migrationSql.indexOf(
  "INSERT INTO _cguru_taxonomy_slug_changes",
);
const valuesEnd = migrationSql.indexOf("\n\nSTART TRANSACTION;", valuesStart);

if (valuesStart === -1 || valuesEnd === -1) {
  throw new Error("Could not locate the embedded taxonomy mapping in the SQL");
}

const mappingBlock = migrationSql.slice(valuesStart, valuesEnd);
const tuplePattern =
  /^\s*\((\d+), '((?:[^']|'')*)', '([^']+)', '([^']+)', '([^']+)', (NULL|'([^']+)'), '([^']+)'\)[,;]$/gm;
const mappings: Mapping[] = [];

for (const match of mappingBlock.matchAll(tuplePattern)) {
  mappings.push({
    sourceLine: Number(match[1]),
    displayName: match[2].replaceAll("''", "'"),
    expectedType: match[3],
    oldCompleteSlug: match[4],
    oldLeafSlug: match[5],
    oldParentSlug: match[6] === "NULL" ? null : match[7],
    newSlug: match[8],
  });
}

if (mappings.length !== 189) {
  throw new Error(`Expected 189 SQL mappings; parsed ${mappings.length}`);
}

const slugs = [
  ...new Set(
    mappings.flatMap(({ oldLeafSlug, newSlug }) => [oldLeafSlug, newSlug]),
  ),
];
const placeholders = slugs.map(() => "?").join(", ");
const issues: string[] = [];

try {
  const liveTerms = await wpQuery<LiveTerm>(
    `
      SELECT
        terms.term_id,
        taxonomy.term_taxonomy_id,
        terms.name,
        terms.slug,
        taxonomy.parent,
        COALESCE(
          NULLIF(MAX(CASE
            WHEN termmeta.meta_key = 'choose_type' THEN termmeta.meta_value
          END), ''),
          'Store'
        ) AS actual_type
      FROM wp_terms AS terms
      JOIN wp_term_taxonomy AS taxonomy
        ON taxonomy.term_id = terms.term_id
       AND taxonomy.taxonomy = 'category'
      LEFT JOIN wp_termmeta AS termmeta
        ON termmeta.term_id = terms.term_id
       AND termmeta.meta_key = 'choose_type'
      WHERE terms.slug IN (${placeholders})
      GROUP BY
        terms.term_id,
        taxonomy.term_taxonomy_id,
        terms.name,
        terms.slug,
        taxonomy.parent
      ORDER BY terms.slug, terms.term_id
    `,
    slugs,
  );

  const termsBySlug = new Map<string, LiveTerm[]>();
  for (const term of liveTerms) {
    const matches = termsBySlug.get(term.slug) ?? [];
    matches.push(term);
    termsBySlug.set(term.slug, matches);
  }

  let exactNewMatches = 0;
  let rootMatches = 0;
  let oldSlugMatches = 0;

  for (const mapping of mappings) {
    if (mapping.oldLeafSlug !== mapping.newSlug) {
      const oldMatches = termsBySlug.get(mapping.oldLeafSlug) ?? [];
      oldSlugMatches += oldMatches.length;
      if (oldMatches.length !== 0) {
        issues.push(
          `CSV line ${mapping.sourceLine}: old category slug ` +
            `${mapping.oldLeafSlug} still exists (${oldMatches.length} match(es))`,
        );
      }
    }

    const newMatches = termsBySlug.get(mapping.newSlug) ?? [];
    if (newMatches.length !== 1) {
      issues.push(
        `CSV line ${mapping.sourceLine}: expected one category at new slug ` +
          `${mapping.newSlug}; found ${newMatches.length}`,
      );
      continue;
    }

    exactNewMatches += 1;
    const [term] = newMatches;

    if (term.name !== mapping.displayName) {
      issues.push(
        `CSV line ${mapping.sourceLine}: ${mapping.newSlug} has name ` +
          `${JSON.stringify(term.name)}; expected ${JSON.stringify(mapping.displayName)}`,
      );
    }
    if (term.actual_type !== mapping.expectedType) {
      issues.push(
        `CSV line ${mapping.sourceLine}: ${mapping.newSlug} has type ` +
          `${term.actual_type}; expected ${mapping.expectedType}`,
      );
    }
    if (term.parent !== 0) {
      issues.push(
        `CSV line ${mapping.sourceLine}: ${mapping.newSlug} still has parent ` +
          `${term.parent}`,
      );
    } else {
      rootMatches += 1;
    }
  }

  const summary = {
    expectedMappings: mappings.length,
    queriedCategoryRows: liveTerms.length,
    exactNewSlugMatches: exactNewMatches,
    rootCategories: rootMatches,
    originallyParentedMappings: mappings.filter(
      ({ oldParentSlug }) => oldParentSlug !== null,
    ).length,
    oldSlugsRemaining: oldSlugMatches,
    issues: issues.length,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (issues.length > 0) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  }
} finally {
  await closeWp();
}

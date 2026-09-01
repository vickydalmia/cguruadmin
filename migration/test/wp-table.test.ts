import assert from "node:assert/strict";
import test from "node:test";

import {
  rewriteWpTableNames,
  validateWpTablePrefix,
  wpTableName,
} from "../src/utils/wp-table.js";

test("rewrites every default WordPress identifier with the selected prefix", () => {
  const prefix = "wp_dda10ab629_";
  assert.equal(wpTableName(prefix, "posts"), "wp_dda10ab629_posts");
  assert.equal(
    rewriteWpTableNames(
      "SELECT * FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id=p.ID WHERE 'wp_uc_codes'='wp_uc_codes'",
      prefix,
    ),
    "SELECT * FROM wp_dda10ab629_posts p JOIN wp_dda10ab629_postmeta pm ON pm.post_id=p.ID WHERE 'wp_dda10ab629_uc_codes'='wp_dda10ab629_uc_codes'",
  );
});

test("unsafe prefixes and suffixes fail before query execution", () => {
  for (const prefix of ["", "wp-", "wp_;DROP TABLE posts;", "../wp_"]) {
    assert.throws(() => validateWpTablePrefix(prefix));
  }
  assert.throws(() => wpTableName("wp_", "posts;DELETE"));
});

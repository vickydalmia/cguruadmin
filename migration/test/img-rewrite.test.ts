import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSrcset,
  getAttr,
  rebuildImgTag,
  replaceImgTags,
} from "../src/utils/img-rewrite.js";

// fix-content-srcsets once carried a private getSrc/rewriteImgTags copy of
// this pipeline; these tests pin the now-shared helpers so the migration
// rewrite and the repair script keep byte-identical tag output.

const record = {
  id: 7,
  url: "https://media.example.com/uploads/img.webp",
  width: 960,
  height: 720,
  formats: {
    thumbnail: {
      url: "https://media.example.com/uploads/thumbnail_img.webp",
      width: 245,
    },
    // Declared out of width order on purpose — buildSrcset sorts.
    small: {
      url: "https://media.example.com/uploads/small_img.webp",
      width: 500,
    },
    xsmall: {
      url: "https://media.example.com/uploads/xsmall_img.webp",
      width: 320,
    },
  },
};

test("getAttr reads double/single-quoted values case-insensitively", () => {
  const tag = `<img SRC="a.jpg" alt='alt text' title="">`;
  assert.equal(getAttr(tag, "src"), "a.jpg");
  assert.equal(getAttr(tag, "alt"), "alt text");
  assert.equal(getAttr(tag, "title"), "");
  assert.equal(getAttr(tag, "class"), undefined);
  // Unquoted values are not matched — same as the original implementation.
  assert.equal(getAttr(`<img src=bare.jpg>`, "src"), undefined);
  // \b quirk pin: without a plain src, a data-src attribute matches too
  // (word boundary after the hyphen) — parity with the removed getSrc.
  assert.equal(getAttr(`<img data-src="lazy.jpg">`, "src"), "lazy.jpg");
});

test("rebuildImgTag rebuilds src/srcset/sizes/dims and carries old attributes", () => {
  const tag =
    `<img loading="eager" class="wp-image" srcset="stale.jpg 1w" ` +
    `sizes="(max-width: 10px) 100vw" title="Old Title" alt="Old alt" ` +
    `src="https://old.example.com/wp-content/uploads/img.jpg" id="pic">`;
  assert.equal(
    rebuildImgTag(tag, record),
    `<img src="https://media.example.com/uploads/img.webp" ` +
      `srcset="https://media.example.com/uploads/thumbnail_img.webp 245w, ` +
      `https://media.example.com/uploads/xsmall_img.webp 320w, ` +
      `https://media.example.com/uploads/small_img.webp 500w, ` +
      `https://media.example.com/uploads/img.webp 960w" ` +
      `sizes="(max-width: 960px) 100vw, 960px" ` +
      `alt="Old alt" title="Old Title" class="wp-image" id="pic" ` +
      `width="960" height="720" loading="eager" />`
  );
});

test("rebuildImgTag drops stale srcset/sizes for a formats-less record", () => {
  const bare = { id: 8, url: "https://media.example.com/uploads/logo.webp", formats: null, width: 600, height: 400 };
  const tag = `<img src="old.jpg" srcset="stale.jpg 500w" sizes="(max-width: 100px) 100vw" alt="Logo">`;
  assert.equal(
    rebuildImgTag(tag, bare),
    `<img src="https://media.example.com/uploads/logo.webp" alt="Logo" ` +
      `width="600" height="400" loading="lazy" />`
  );
  // A single rung is no ladder: srcset needs at least two entries.
  assert.equal(buildSrcset(bare), null);
});

test("replaceImgTags rebuilds duplicate tags once and applies every occurrence", async () => {
  const tag = `<img src="a.jpg" alt="A">`;
  const html = `<p>${tag}</p><p>${tag}</p>`;
  let invocations = 0;
  const { html: out, replacements } = await replaceImgTags(html, async () => {
    invocations++;
    return `<img src="b.jpg" alt="A" loading="lazy" />`;
  });
  assert.equal(invocations, 1);
  assert.equal(replacements.size, 1);
  assert.equal(
    out,
    `<p><img src="b.jpg" alt="A" loading="lazy" /></p>` +
      `<p><img src="b.jpg" alt="A" loading="lazy" /></p>`
  );
});

test("replaceImgTags leaves null-rebuild tags untouched and replaces the rest", async () => {
  const html = `<img src="keep.jpg"><figure><img src="swap.jpg"></figure>`;
  const { html: out, replacements } = await replaceImgTags(html, async (tag) =>
    getAttr(tag, "src") === "swap.jpg" ? `<img src="new.jpg" />` : null
  );
  assert.equal(replacements.size, 1);
  assert.equal(out, `<img src="keep.jpg"><figure><img src="new.jpg" /></figure>`);
});

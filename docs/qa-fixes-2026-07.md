# QA fixes — 13–15 July 2026 backend batch

Fixes for the backend-labeled items from the QA tracker (Vikash / Rohit / Vinayak).
Most take effect automatically on deploy (schema + bootstrap). Two need a manual
step; a few reported items are expected behavior and are explained for QA.

## Takes effect automatically on deploy

| Reported issue | Fix |
| --- | --- |
| Brand savable without short description / logo | `shortDescription` + `logo` are now `required` on the brand schema (native red-asterisk validation). |
| Brand savable without SEO title/description | Validated server-side (brand only) via `src/utils/entity-field-validation.ts` → inline field error. |
| FAQ toggled on with no FAQs, no error | `faqEnabled` on with an empty `faqs` list now shows an inline error (store/brand/category/bank). |
| Rating count overflow → 500, field not highlighted | Rating count/average range checked (0–2,000,000,000 / 0–5) → friendly inline error instead of a 500 (all four taxonomies). |
| Homepage banner save error unclear | Size-mismatch error now names the field, the required size, and the uploaded size; the required size is also shown as the field's help text. Exact-size rule kept (crisp @2x images). |
| Boolean toggle needs a confirmation | Every True/False toggle now opens a confirm dialog before it flips. |
| Editor hyperlink not shown on the word | Applying a link with the cursor inside a word now links the whole word and keeps it visibly marked. |
| Slug pre-filled with "store" | Slug field starts empty and auto-fills from the name as you type (empty name → empty slug, never "store"). |
| Enter creates the store while typing the name | Enter no longer submits single-line text fields in the content-manager edit view. |
| Bank/Category/Store/Brand search returns wrong records | Search is scoped to name + slug (`searchable: false` on description / short description / logo alt / website URL). |
| Expired coupons mixed into the admin list | The coupon/deal list now has a **Content status** column — filter to `expired` to segregate them. (Public API already hides expired offers.) |
| Amazon Banner + Link still in Global Settings | Already removed from the schema — see the one manual DB step below. |
| Coupon schedule needs 5-minute steps | Already implemented — the datetime picker steps by 5 minutes. |

## Manual steps

1. **Restrict Footer + Global Settings to Super Admin.** Enforced as config-as-code:
   every boot strips the content-manager permissions for `api::footer.footer` and
   `api::global.global` from all non-super-admin roles, so no action is required for
   the lock itself. If you also want editors to not *see* stale grants in the UI:
   Settings → Administration Panel → Roles → Editor/Author → uncheck Footer and
   Global Settings. (Super Admin always keeps access — it bypasses permission checks.)

2. **Drop the legacy Amazon columns** from the deployed DB (Strapi never drops
   removed columns). After deploying and booting Strapi once:
   ```bash
   cd migration
   yarn cleanup:legacy-fields                                   # dry-run
   yarn cleanup:legacy-fields --apply --yes-i-mean-<db-host>    # apply
   ```

## Expected behavior (not bugs — explain to QA)

- **H2/H3 and bullet/numbered lists apply to the whole line, not part of a word.**
  Headings and list items are block elements in HTML — by definition they wrap a
  whole paragraph/line, so they cannot be applied to only some selected words within
  a line. This is standard rich-text behavior, not a defect.
- **Bullets not rendering as bullets on the store page** is a frontend (Astro) CSS
  concern — the admin already stores valid `<ul>/<li>` markup. Fix lives in the
  frontend repo, not here.
- **"Retrieve a deleted coupon"** (soft-delete/undelete) was deferred — it is a
  sizable feature. Recover via DB backup for now.

## Deploy order

1. Deploy code + boot Strapi once (adds any columns, applies the CM list column,
   field descriptions, and the Super-Admin permission lock).
2. Run the `cleanup:legacy-fields` script (manual step 2) for the Amazon columns.

# Admin CSV export

Super Admins can download every entry of the six main collection types —
Coupons, Product Deals, Stores, Brands, Categories, Banks — as a CSV from the
Content Manager list view. The **Export CSV** button sits in the list toolbar
next to the view-settings gear (the `listView.actions` injection zone, the only
list-view seam Strapi 5 exposes). It is hidden for every other role, and the
endpoint behind it is enforced server-side by `global::super-admin-only`.

## What the file contains

Every attribute of every entry, derived from the schema so the header is the
same on every page of one export:

| Attribute kind | Columns |
|---|---|
| scalars (string, text, rich text, numbers, booleans, dates, enums) | one column, dates in ISO-8601 |
| relations | `<field>` — the related entries' names (stores/brands/categories/banks/pools) or titles (coupons/deals), `\|`-joined; `orderedCoupons` keeps its order. No id columns |
| media | `<field>.url`, `<field>.name`, `<field>.alternativeText` |
| single component (`seo`, `entityDealPageSeo`) | `seo.metaTitle`, `seo.ogImage.url`, … |
| repeatable component (`faqs`) | one JSON column |
| `json` | one JSON column |
| `checkoutMerchant` | the merchant's name with its kind, e.g. `Amazon (store)`; the raw reference only if the merchant no longer exists |
| audit trail | `createdAt`, `updatedAt`, `publishedAt`, `createdBy`, `updatedBy` as `First Last <email>` |

Passwords are never exported. The file is UTF-8 with a BOM (Excel-safe), CRLF
line endings, RFC 4180 quoting, and values that a spreadsheet would evaluate as
a formula (`=`, `+`, `-`, `@`, tab) are prefixed with an apostrophe unless they
are plain numbers.

## How it runs

The admin walks `GET /csv-export/:uid?page=N&pageSize=S` one page at a time
(250 rows for offers, 100 for entities). Page 1 carries `total` and
`pageCount`, so the modal shows an exact row percentage from the first tick;
Cancel (or closing the modal) aborts the loop. When the last page lands the
browser downloads `<type>-<yyyy-mm-dd>.csv`.

Rows are read in `id` order, so an entry created mid-export lands at the end
and a deletion shifts one row — the export is a snapshot taken while editors
may still be working, and the modal says so.

## Code map

| Path | Role |
|---|---|
| `src/constants/csv-export.ts` | targets, page sizes, route prefix, page shape (shared by server + admin) |
| `src/api/csv-export/services/csv-export.ts` | columns / populate / flatten / CSV encoding / `exportPage` |
| `src/api/csv-export/controllers/csv-export.ts` | param validation, `page` handler |
| `src/register/admin-routes.ts` → `registerCsvExportRoutes` | admin-router route + policies |
| `src/admin/features/csv-export/api.ts` | the page loop, progress maths, file assembly (React-free, tested) |
| `src/admin/features/csv-export/use-csv-export.ts` | state + AbortController |
| `src/admin/features/csv-export/components/csv-export-button.tsx` | button + progress modal |
| `src/admin/utils/download-blob.ts` | shared browser download helper |

## Manual check

```
curl -H "Authorization: Bearer <admin jwt>" \
  "http://localhost:1337/csv-export/api::bank.bank?page=1&pageSize=100"
```

returns `{ total, pageCount, header, lines, rowCount }`; an unknown uid is a
404, `pageSize` above 500 is a 400, a non-Super-Admin session is a 403.

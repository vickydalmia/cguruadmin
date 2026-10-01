# Agent handoff: titles for repeatable entries backed by relations

## Implemented for Festival offer slides

The collapsed slide label previously used `titleOverride` only. When an editor selected a Coupon and left that optional override blank, Strapi displayed an empty accordion title even after saving.

The label now resolves in this order:
1. Nonempty `titleOverride`.
2. The current unsaved Coupon selection's `title` or `label` in `coupon.connect`.
3. The saved Coupon title loaded through Strapi's existing relation query.
4. `Select a Coupon` when nothing is selected.

Entries listed in `coupon.disconnect` are excluded. This is a read-only presentation fallback: it does not populate the override, change the selected relation, dirty the form, or freeze a copy of the Coupon title in CMS data. The storefront continues to use live Coupon data unless an override was deliberately authored.

## Files and integration

- `src/admin/features/festival/slide-title.ts`: pure label resolver.
- `src/admin/features/festival/slide-title.test.ts`: selection, saved/reopened relation, override clearing, and removal cases.
- `src/admin/features/festival/use-slide-title.ts`: subscribes to the exact form row with `useForm`; queries saved relations by component UID + numeric component ID + `coupon` field, using the document's locale/status parameters.
- `patches/@strapi+content-manager+5.50.0.patch`: small adapter in both `Repeatable.mjs` and `Repeatable.js`. Passes the raw main-field value and Strapi's `useGetRelationsQuery` into the feature hook. Hooks run consistently; the relation query is skipped for all other components and for unsaved rows without an ID.
- `src/admin/vite.config.ts`: `@cguru/festival-slide-title` alias resolves to the feature hook. Existing patch hashing invalidates Vite's dependency cache when the patch changes.
- `src/bootstrap/content-manager-entry-titles.ts`: still pins the entry title to the scalar override field. **Do not change mainField to the relation**: relation form state is an object (`connect`/`disconnect`), which Strapi cannot render directly as a React label.

Reusing the relation query means the label shares Strapi's permissions, cache, locale/status, and post-save invalidation with the native relation picker. Already saved entries require no migration or resave. Verified in the running admin: previously blank CyberGhost, Tailor Brands, and UlluShop rows show selected Coupon titles.

## Follow-up requested by the user (not implemented in this task)

Audit other relation-backed repeatable entries configured with optional text overrides in `content-manager-entry-titles.ts`, especially:
- `home.hero-product`, `home.exclusive-item`, `home.coupon-card-item`
- `home.top-offer-item`, `home.bank-offer-item`
- `home.explore-tab`, `home.explore-offer-tab`
- `deal-day.store-tab`, `deal-day.telegram-deal-item`
- `festival.coupon-category-tab`, `festival.coupon-store-tab`

Verify each actual component schema before extending this behavior. Some relate to Stores/Categories, some to Coupons, some to Product Deals; do not infer the entity from a CTA label. Establish the appropriate name/title/offer-text fallback per component. If multiple features adopt it, promote the reusable hook/resolver into a shared admin utility with explicit per-component configuration, preserving feature-specific rules.

## Validation for future changes

Cover newly selected, replaced, disconnected, saved/reopened, reordered, and localized rows; an explicit override must win, and clearing it must restore the related title. Test query failure/no permission without crashing the editor. Confirm selection never changes the override or marks an otherwise unchanged document dirty. Check both collapsed and expanded rows. Run admin typecheck, targeted tests, and the production admin build. Recheck the dependency adapter on every Strapi upgrade and keep the CJS/ESM patches aligned.

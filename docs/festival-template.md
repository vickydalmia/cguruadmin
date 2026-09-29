# Festival Template — setup milestone

Festival Template uses the existing entity-owned campaign system. Choose
`Festival Template` (`festivalTemplate` in the API) in the Page Template field
when creating or editing a Store, Brand, Category or Bank. Only one entity may
own it across all four types. Clear the previous assignment before moving it;
cloning the owner cannot create a second owner.

After assignment, Content Manager exposes the **Festival Template** single
type. Its localized settings currently contain only an admin title and shared
SEO. No entity slug is hardcoded, and assignment does not create another URL.

This milestone intentionally keeps `features.festival.ready` and `live` false:
an admin title or SEO is not page content. The storefront continues to render
the owner's default entity view and metadata. Saving, deleting, or translating
Festival settings emits the existing transactional ISR event for the owner
path, with route/settings and sitemap refresh. Entity assignment, clearing and
renaming retain the existing entity-write invalidation behavior. Website
Refresh resolves this singleton to the same owner path.

No template is assigned automatically, no settings are seeded, and no existing
entity or campaign is migrated. Strapi schema synchronization adds the new
singleton and enum option; the admin build supplies the friendly option label.

The next milestone adds the first user-selected content block. It must add the
aggregate read API, block validation/eligibility, and matching frontend renderer
before replacing the setup-only readiness gate in `feature-readiness.ts`.
At that point also add Festival to the campaign metadata mapping in
`api/homepage/controllers/custom.ts`, map its frontend campaign feature, update
localized inventory admission, and connect the new block's data dependencies
to offer/merchant invalidation as needed. Preserve default-view fallback for
missing or unconfigured content, and propagate temporary upstream errors.

Design references:

- [Mobile, 375px](https://www.figma.com/design/5LPugIVhN7c19SF0rGJvCp/Developer-mode?node-id=2190-2362)
- [Desktop, 1440px](https://www.figma.com/design/5LPugIVhN7c19SF0rGJvCp/Developer-mode?node-id=2214-537)
- Additional desktop interaction states: `2216:2533` (filters), `2216:4507`
  (sort menu). No separate tablet frame was found on the Festival page.

Build visual sections one at a time, reusing existing cards, actions, image
primitives and controllers. Verify intermediate widths as each block ships.

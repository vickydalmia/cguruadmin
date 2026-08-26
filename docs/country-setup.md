# Country Setup and Multi-Country Sites

This guide explains, in plain language, how one CouponzGuru codebase can run
different country websites without turning the India website into a special
fork. It is the owner/operator guide for the **Settings → Country Setup** page,
the feature switches behind it, country-specific WordPress migrations, and the
checks that protect the existing India site.

The short version is:

- every country has its own Strapi deployment and database;
- every deployment chooses one country, locale, timezone, and currency;
- the same application code is used everywhere;
- editors choose which source-backed pages are live;
- campaign designs are selected on an entity, not tied to a hardcoded URL;
- India-compatible defaults keep the current site working during rollout,
  rollback, an older-CMS overlap, or a temporary settings failure.

This guide does not change or replace the production server topology. Server
installation, container sizing, DNS, and infrastructure cutover remain in the
existing deployment runbooks.

## 1. The deployment model

Think of the code as a reusable shop design and each deployment as a separate
shop:

```text
Shared CouponzGuru code
  ├─ India Strapi + India database + India media/settings
  └─ USA Strapi   + USA database   + USA media/settings
```

The India and USA sites do **not** select a country per visitor. A deployment
has one configured country and one configured currency. Coupons and Product
Deals therefore do not need a currency field of their own.

This separation is important:

- a USA feature switch cannot remove a page from India;
- USA migration checkpoints cannot resume an India migration;
- USA exclusions cannot silently reuse the India retired-store list;
- a USA content or legal-page decision is stored in the USA database only.

## 2. What Country Setup stores

Only a Strapi Super Admin can open **Settings → Country Setup** or call its
write endpoint. The underlying Site Configuration single type is hidden from
the ordinary Content Manager so editors cannot accidentally create a second
configuration row.

### Identity and localization

| Field | Meaning | India | USA starter profile |
| --- | --- | --- | --- |
| Site name | Public brand name | CouponzGuru | CouponzGuru |
| Country name | Human-readable country | India | United States |
| Country code | Two-letter uppercase ISO code | IN | US |
| Locale | Number, date, and Open Graph locale | en-IN | en-US |
| Timezone | Offer/date interpretation | Asia/Kolkata | America/New_York |
| Currency code | Three-letter ISO currency | INR | USD |
| Onboarding complete | Operator checklist status | true after setup | true after setup |

The form previews values derived with the JavaScript internationalization
standard. For example, `USD` produces `$` for display while structured data
continues to use `USD`. Future deployments can use any currency supported by
the runtime, including AED, SGD, MYR, and PHP, without adding a symbol to the
application code.

`onboardingComplete` records an operator decision. It does not turn the site
off and does not gate the India site when no configuration row exists.

### What stays outside Strapi

Security and infrastructure values remain deployment configuration, including:

- the public site URL;
- whether search engines may index the deployment;
- private Strapi/Redis/service URLs;
- browser-origin allowlists and secrets.

There are no runtime `PUBLIC_CANONICAL_HOST`, `PUBLIC_INTERNAL_HOSTS`,
`PUBLIC_COOKIE_DOMAIN`, or Strapi `INTERNAL_HOSTS` switches. See
[Domain and cookie behavior](#8-domain-and-cookie-behavior) for the derivation
rules. The similarly named migration variables are source-cleanup inputs only;
they do not configure the running site.

## 3. Enabled, ready, and live

Every configurable feature reports three values:

| Value | Plain-language meaning |
| --- | --- |
| `enabled` | A Super Admin wants the feature on. |
| `ready` | The required CMS content or catalog records exist. |
| `live` | Both are true: `enabled && ready`. |

Country Setup refuses a save that enables an unready feature. The error names
the missing content, such as an absent singleton, an empty required section,
no catalog records, no campaign-template owner, or no eligible Product Deals.

This prevents a switch from publishing a blank page. It also means operators
should create and review content first, then enable the feature.

### Feature registry

| Group | Feature | Readiness source | Public destinations controlled |
| --- | --- | --- | --- |
| Catalog | Stores | At least one Store | `/stores/` and Store entity pages |
| Catalog | Coupons | At least one published Coupon | Coupon detail/cards/search sources |
| Catalog | Brands | At least one Brand | `/brands/` and Brand entity pages |
| Catalog | Categories | At least one Category | `/categories/` and Category entity pages |
| Catalog | Banks | At least one Bank | `/banks/` and Bank entity pages |
| Catalog | Product Deals | At least one published Deal | Deal detail/cards/search sources |
| Editorial | About | About singleton with its hero | `/about-us/` |
| Editorial | Careers | Careers hero and jobs section | `/careers/` and active job routes |
| Editorial | Contact | Contact hero and form | `/contact-us/` |
| Editorial | FAQs | Heading and FAQ categories | `/faqs/` |
| Editorial | Testimonials | Testimonials hero | `/testimonials/` |
| Editorial | Partner With Us | Hero and CTA | `/partner-with-us/` |
| Editorial | Culture | Culture hero | `/culture/` |
| Legal | Privacy Policy | Heading and real sections | `/privacy-policy/` |
| Legal | Terms and Conditions | Heading and real sections | `/terms-and-conditions/` |
| Legal | Affiliate Disclosure | Heading and real sections | `/affiliate-disclosure/` |
| Campaigns | Deal of the Day | Singleton, owner, and live Deals | Selected `dealTemplate` owner path |
| Campaigns | Independence Day Sale | Singleton and owner | Selected `independenceDayTemplate` owner path |

Homepage, Search, robots, sitemaps, error documents, and other system plumbing
remain available. Search remains reachable but shows only enabled result types.

India has one compatibility exception: if an old editorial/legal singleton
row does not exist, the committed India fallback may satisfy readiness. Other
countries must supply real CMS content. Campaigns never use that exception.

## 4. What happens when a feature is disabled

The switch is applied consistently instead of merely hiding one menu link.

After the settings change is invalidated and the next route inventory is
installed:

- Menu and Footer omit links owned by the feature.
- Homepage sections or internal “View all” links that need the feature are
  omitted.
- Search omits the result group and its records.
- Entity pages omit Coupon or Product Deal content whose source is disabled.
- Entity interlinks omit disabled Store, Brand, Category, or Bank types.
- Route inventory and Redis route membership omit disabled pages.
- Sitemap output omits the same pages.
- A direct request returns the normal 404 page; it is not redirected to the
  homepage, avoiding a soft-404 SEO signal.

The content filters are independent. For example, when Stores and Product
Deals are live but Coupons are disabled, a Store page can still show Product
Deals and Related Stores. Its hero count is based on the unique offer cards
actually rendered, so it does not claim zero while Deal cards are visible.

For thin entity pages, sitemap membership and the page's robots decision count
only the offer sources that are enabled and actually renderable. A
Coupons-disabled deployment therefore does not submit a sitemap URL that the
same deployment deliberately marks `noindex` because its Coupons were hidden.

## 5. Campaign templates are designs, not paths

Store, Brand, Category, and Bank entries now have a **Page template** field:

- `default` renders the normal entity page;
- `dealTemplate` renders the Deal of the Day design;
- `independenceDayTemplate` renders the Independence Day Sale design.

The selected entity keeps its own slug. If an editor assigns `dealTemplate` to
an entity whose slug is `today-best-offers`, the campaign route is
`/today-best-offers/`. The router, navigation, homepage Deal CTAs, canonical
URL, structured data, sitemap, and ISR invalidation all use that owner path.
They do not assume `/deal-of-the-day/`.

Only one entity may own each campaign template because the campaign singleton
contains one page's content. Assigning the same template to a second entity,
including by cloning an owner, is rejected. This avoids publishing the same
campaign at two self-canonical URLs.

Changing or disabling a campaign does not delete the underlying entity:

- when the campaign is live and complete, the authoritative owner gets the
  campaign design;
- when the campaign is disabled or its singleton cannot render, the entity
  uses its normal design if its Store/Brand/Category/Bank feature is live;
- duplicate legacy owners, if direct database writes somehow created them,
  do not receive duplicate campaign content; only the authoritative path can
  render it.

The database migration adds the field with `default` to all four entity types.
It performs a one-time compatibility backfill for the existing India slugs:

```text
deal-of-the-day                    → dealTemplate
independence-day-sale-coupons     → independenceDayTemplate
```

The optional legacy `categories/` prefix is also recognized during this one
backfill. Runtime rendering does not keep checking those strings.

## 6. Country-aware public output

Site Configuration now supplies the public name, country, locale, timezone,
and currency to shared rendering code. That affects:

- the document `lang` and Open Graph locale;
- page and directory descriptions;
- organization/website and offer structured data;
- currency codes and visible price labels;
- country badges and About/Footer country treatment;
- offer expiry formatting where the product format is locale-aware;
- homepage and campaign canonical URLs.

India deliberately keeps the public price style `Rs. 1,234`. Other countries
default to the currency symbol derived from their ISO code, such as `$ 1,234`
for USD. Structured data always receives the ISO code (`INR`, `USD`, and so
on), never the visible label.

The existing card label “Valid till Aug 26, 2026” remains that established
display style across countries. Other date output that is intended to be
localized uses the configured locale and timezone.

The header control previously documented as a language picker is now a
read-only country badge derived from the configured two-letter country code.
It does not let a visitor switch this deployment to another country.

The footer country switcher is different: it links between deployments. The
migration reads one shared `migration/profiles/footer-countries.json` registry
and removes the current `SOURCE_COUNTRY_CODE`. With the six currently registered
sites, India displays the other five and USA displays India plus the other four.
Adding a future country once to that registry exposes it on every other site;
the current deployment can never link to itself. Country flag masters live in
`migration/assets/footer/`. Site-only footer content, such as India's Google
Preferred Source card, stays in
`migration/profiles/<profile>/footer-settings.json`.

## 7. Settings delivery and mixed-version safety

The public UI reads:

```http
GET /api/site-settings
```

The endpoint returns only safe identity, localization previews, and feature
states. It is anonymous, rate-limited, and cached for 60 seconds.

The Astro server also caches the response for 60 seconds. If Strapi is briefly
unavailable or an older CMS does not yet provide the endpoint, the UI uses the
last successfully validated response. Before the first successful response it
uses built-in India-compatible settings, so an independent UI deployment does
not turn every page into a 500 error.

A new UI also asks route APIs for `pageTemplate`. An older CMS rejects an
unknown projected field with HTTP 400, so the UI retries without that field
and treats the entries as `default`. It periodically re-probes and begins using
the field after the CMS upgrade without requiring an SSR restart.

These fallbacks are rollout protection, not a replacement for monitoring. A
settings-fetch error is logged and should be investigated.

## 8. Domain and cookie behavior

`PUBLIC_SITE_URL` is the one public domain input. The application derives the
registrable domain with the ICANN Public Suffix List. For example:

```text
https://www.couponzguru.com → couponzguru.com
https://www.couponzguru.sg  → couponzguru.sg
```

The suffix data is used on the server/build side. Browser bundles receive only
the already-derived domain, avoiding roughly 28 KB of unnecessary compressed
client JavaScript.

The derived domain controls three behaviors:

1. **Indexing safety.** An indexable production deployment must use
   `www.<registrable-domain>`. `beta-noindex` is rejected on the apex or `www`
   final hosts so a stale beta setting cannot noindex the real site.
2. **First-party links.** The apex and its subdomains are internal. Existing
   India links between `couponzguru.com`, `www`, `beta`, and CMS subdomains do
   not become external/nofollow merely because one configured URL uses `www`.
3. **Meta attribution cookies.** On the apex or `www`, attribution may use
   `Domain=.<registrable-domain>` so the two final hosts agree. Beta, preview,
   localhost, IPs, and unrelated hosts stay host-only. Privacy opt-out also
   expires legacy parent-domain `_fbp` and `_fbc` cookies.

This intentionally does not support a separate first-party domain override or
an apex-as-canonical production mode. A deployment needing either behavior
requires a reviewed code/configuration change rather than another unchecked
host-list environment variable.

`SOURCE_INTERNAL_HOSTS` and `TARGET_INTERNAL_HOSTS` still exist in the
WordPress migration. They tell the importer which URLs in old authored content
belong to the source and target sites. They are not runtime Strapi or UI flags.

## 9. Why the current India site remains compatible

The design has several independent safety layers:

| Risk | Protection for India |
| --- | --- |
| No Site Configuration row yet | Both CMS and UI normalize to India, `en-IN`, `Asia/Kolkata`, `INR`, `Rs.`, and all 18 features enabled. |
| CMS temporarily fails | UI serves the last good settings or built-in India defaults instead of failing every document. |
| UI is released before the CMS schema | Settings endpoint failure is tolerated; route reads retry without `pageTemplate`. |
| New database columns | Changes are additive and default existing entities to the normal design. |
| Existing campaign URLs | The migration backfills the two known India campaign owners, then runtime follows those entities rather than hardcoding paths. |
| Missing campaign content | The real entity can fall back to its generic design instead of being deleted. |
| Existing India editorial copy | Committed fallback content remains valid only for country code `IN`. |
| Existing price/date appearance | `Rs.` and the established visible “Valid till” format are preserved. |
| Existing offer behavior | Coupon versus Product Deal classification, lifecycle rules, API schemas, activation, and affiliate behavior are unchanged. |
| Existing India links/cookies | The `.couponzguru.com` registrable-domain behavior preserves apex/www classification and cleans legacy Meta cookies. |
| India and new-country image parity | `PUBLIC_SITE_URL` is runtime-only and the authenticated admin config endpoint supplies it to Coupon/Deal link actions, so one country-neutral image serves every deployment while rich-text classification still uses the correct domain. |
| Footer country links | A shared registry preserves the existing sibling sites and automatically excludes India itself. |
| Existing migration progress | The India profile safely keeps using the old `.checkpoints` directory without moving it during configuration import; operators can rename it explicitly while migration commands are stopped. |
| Cross-country migration mistakes | Profile, state, target-country, table-prefix, configuration-file, Store-count, and Deal-count checks fail before target mutation. Attachment drift warns and is reconciled through the Phase 01 missing-file report. |

The compatibility defaults are deliberately permissive for India. Feature
switches only change India output after a Super Admin saves a configuration
that disables something.

### India release checklist

Before releasing this change to India:

1. Deploy/test the CMS schema and migration against a production database copy.
2. Confirm the legacy Deal of the Day and Independence Day entities received
   the expected templates.
3. Request `GET /api/site-settings` and confirm all intended India features
   report `enabled: true`, `ready: true`, and `live: true`.
4. Confirm the two campaign states contain the expected owner paths.
5. Verify representative Store, Brand, Category, Bank, Coupon, Deal, careers,
   legal, campaign, search, sitemap, robots, and error routes.
6. Confirm an India amount still renders with `Rs.` and structured data uses
   `INR`.
7. Confirm production indexing uses
   `PUBLIC_SITE_URL=https://www.couponzguru.com`,
   `PUBLIC_ALLOW_INDEXING=true`, and
   `PUBLIC_INDEXING_MODE=production-indexable`.
8. Refresh route inventory and compare Redis membership/sitemap counts before
   opening traffic. A large unexpected removal is a stop condition.

Rollback may use the previous application images. The additive configuration
table and `page_template` columns are ignored by older code and do not need to
be dropped.

## 10. USA starter configuration

The checked-in USA migration profile starts with:

- United States (`US`), `en-US`, `America/New_York`, and `USD`/`$`;
- Stores and Coupons enabled;
- Brands, Categories, Banks, and Product Deals disabled;
- Deal of the Day and Independence Day Sale disabled;
- editorial and legal pages disabled until country-specific CMS content is
  supplied and reviewed.

The WordPress “Store List” page is not imported as a static page because the
application already has `/stores/`. The empty legacy “Redeem” page is not
imported because offer activation is provided by the current redeem system.

The expected USA source checks are:

| Inventory | Expected result |
| --- | ---: |
| Stores | 7,162 |
| Attachments | 10,360 |
| Product Deals | 0 |
| Homepage hero banners | 5 |
| Featured Stores | 8 |

The profile imports Coupons only. Product Deal phases, including the Phase 12
taxonomy reconciliation, safely no-op when the source contains none. Phase 12
continues with its Coupon recommendation backfill; an empty Deal target is only
treated as stale migration state when importable source Deals actually exist.

## 11. Migration profiles and safety

The migration package loads `.env.migration`. A country run must set or inherit
these profile values:

```dotenv
MIGRATION_PROFILE=usa
MIGRATION_STATE_DIR=.state/usa
MIGRATION_SITE_CONFIGURATION_FILE=profiles/usa/site-configuration.json
MIGRATION_EXCLUSIONS_FILE=profiles/usa/excluded-stores.csv
WP_TABLE_PREFIX=wp_dda10ab629_
SOURCE_COUNTRY_CODE=US
SOURCE_LOCALE=en-US
SOURCE_CURRENCY_CODE=USD
SOURCE_TIMEZONE=America/New_York
```

The profile name is validated. WordPress prefixes must contain only letters,
numbers, and underscores and must end in `_`. Table identifiers are rewritten
through the validated helper before MySQL receives the query.

Each profile isolates:

- checkpoints;
- WordPress→Strapi ID maps;
- media manifests and remote-media cache;
- logs and reports;
- import exclusions;
- temporary media decisions.

Phase 00 validates the profile JSON, ISO country/currency/locale/timezone,
required source tables, hard Store/Deal counts, exclusions, target database,
and target country before any destination mutation. Attachment-count drift is
reported as a warning so a live source adding media after its files snapshot
does not block the run; Phase 01 separately reports missing local originals. A
configured target whose Site Configuration belongs to another country is
refused unless an explicit, reviewed country-switch override is supplied.

Optional unique-code and Yoast tables are detected. Their phases skip safely
when the source does not contain them.

### Offer quality and accounting

Existing publication, scheduling, and expiry rules remain unchanged. The
extractor additionally understands country-appropriate phrases such as Free
Shipping, Buy One Get One, Starting At, Under, dollar-value discounts, and
case-insensitive dollar cashback such as `USD 15 Cashback`, `$15 cashback`, or
`Cashback: $15`.

- `SPECIAL OFFER` is the reported final text fallback, not the first choice.
- Offers without a valid affiliate destination are quarantined.
- URL/image values found in Coupon code fields are treated as corrupted
  no-code values and reported.
- Review reports account for every imported, normalized, excluded, or
  quarantined WordPress ID.
- WordPress header/footer tracking scripts remain excluded unless
  `IMPORT_WP_TRACKING_SCRIPTS=true` is deliberately approved.

Never run a USA overlay by merely appending it to an India environment without
checking the final `PG_CONNECTION_STRING`, S3 destination, WordPress host,
uploads directory, profile, and state path. Preflight is a safety net, not a
substitute for reading the effective environment.

## 12. Operator workflow

For a new country deployment:

1. Create the country database and boot the matching Strapi version so its
   schema exists.
2. Prepare a country profile JSON and migration environment.
3. Run migration preflight and review every printed source/target value.
4. Run a dry migration against a disposable target and reconcile the report.
5. Run it twice to prove idempotency.
6. Open **Settings → Country Setup**.
7. Confirm identity/localization previews.
8. Leave any page without reviewed content disabled.
9. Assign campaign templates only after their singleton content is ready.
10. Save, then verify `/api/site-settings`, search, navigation, direct 404s,
    route inventory, sitemap, and structured data.

For an existing country, create or review the required CMS content before
turning on a new feature. If Country Setup says a feature is not ready, correct
the named source rather than bypassing the validation in the database.

## 13. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Country Setup will not enable a page | Required singleton fields or catalog records are missing | Read the readiness reason, complete the source, then save again. |
| Campaign uses the generic design | Campaign is disabled/unready, the entity is not the authoritative owner, or singleton data could not render | Check the feature state, template owner, and campaign aggregate endpoint. |
| Second entity cannot use a campaign template | One-owner validation is working | Clear the template on the current owner first, then assign it to the new owner. |
| Disabled URL still appears briefly | Old route inventory/HTML is still cached | Confirm the Site Configuration outbox event delivered and install the refreshed inventory. |
| Page disappeared but menu link remains | CMS/UI versions or site-chrome cache are stale | Verify both release versions and refresh the chrome/routes scopes. |
| Search returns a disabled type | Old Strapi process or cached search response | Verify the CMS release and allow the bounded search cache to expire/restart. |
| UI logs a site-settings fetch failure | CMS unavailable, old, or returned an invalid contract | The site is serving last-good/default settings; restore the endpoint and verify its response. |
| Migration resumes the wrong run | Profile and state path disagree | Stop, reconcile the directories, and use `.state/<profile>`; never merge ID maps casually. |
| Migration refuses a target-country mismatch | Destination points to another country's database | Correct `PG_CONNECTION_STRING`; do not use the override for an ordinary import. |

## 14. API contract reference

### Public settings

`GET /api/site-settings` returns:

```json
{
  "data": {
    "siteName": "CouponzGuru",
    "countryName": "United States",
    "countryCode": "US",
    "locale": "en-US",
    "timezone": "America/New_York",
    "currencyCode": "USD",
    "onboardingComplete": true,
    "localization": {
      "currencyCode": "USD",
      "currencySymbol": "$",
      "priceLabel": "$",
      "numberExample": "$1,234.56",
      "dateExample": "Aug 26, 2026"
    },
    "features": {
      "stores": { "enabled": true, "ready": true, "live": true },
      "dealOfTheDay": {
        "enabled": false,
        "ready": false,
        "live": false,
        "reason": "CMS singleton is missing."
      }
    }
  }
}
```

Campaign feature states add `path` when a live authoritative owner exists.

### Admin settings

These endpoints use the Strapi admin router and require an authenticated Super
Admin session:

```http
GET /country-setup/
PUT /country-setup/
```

The PUT body contains the editable identity fields and boolean feature flags.
`features` and `localization` are calculated response fields and are not written
back by the admin form.

## Related documentation

- [Public API](./public-api.md)
- [CMS deployment](./deployment.md)
- [WordPress migration internals](./wordpress-migration.md)
- [Migration operator runbook](../migration/FRESH-MIGRATION.md)
- [Migration phase reference](../migration/README.md)
- [UI Strapi integration](https://github.com/vickydalmia/cguru-ui/blob/main/docs/strapi-integration.md)
- [UI environment variables](https://github.com/vickydalmia/cguru-ui/blob/main/docs/environment.md)
- [ISR route inventory and warming](https://github.com/vickydalmia/cguru-ui/blob/main/docs/isr-deployment/warming-policy.md)

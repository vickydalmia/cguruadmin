# Festival Template

Assign Festival Template to one Store, Brand, Category or Bank. The owner's
existing URL is used; there is no fixed Festival route. Assignment alone does
not activate Festival.

In Content Manager → Festival Template, **Enable template** defaults to off.
This shared switch controls activation independently of content completeness.
Off: the owner renders its normal entity page. On: the owner renders Festival,
even with no sections configured. Saving the switch invalidates the owner route.

There is no bundled artwork, promotional copy, or sample data fallback. Add
content section by section:

- Page title supplies the heading and breadcrumb label; SEO supplies metadata.
- Banner uses one uploaded desktop image at the full viewport width on every screen. Height scales with the image’s natural proportions;
  smaller screens show the full image without cropping. Include any badge
  inside the image. An absent image or disabled banner omits only that section.
- Countdown is optional. Configure valid start/end dates, labels and safe action
  URLs for both phases. Disabled, incomplete or expired clocks do not render.

The API `/api/festival-full` includes `enabled`, countdown, banner, `offerSlider.items.coupon` and SEO.
Only literal `enabled: true` activates the template. Missing CMS records or a
missing flag keep it off. Temporary upstream failures remain retryable.
Localized route metadata also checks the flag, never section completeness.

Browser coverage: `E2E_FESTIVAL_PATH` targets an enabled configured page;
`E2E_FESTIVAL_EMPTY_PATH` targets an enabled page with no section content.
Tests use synthetic artwork only; no test assets are shipped as page defaults.

Validation errors target individual inputs (including each countdown date and
CTA URL). Failed saves preserve the editor's text, selected image and section
state, including before the singleton's first successful save. Success still
refreshes the saved document. See the Content Manager patch notes in AGENTS.md.

## Coupon slider

Section 3 is an optional, enabled-by-default slider with repeatable Coupon
selections in editorial order. It supports code, unique-code and no-code
Coupons only; Product Deals and an entity-type selector are not supported.
Each slide can override its title, two-line description and badge text.
Blank overrides use the selected Coupon's live title, plain-text content and
`offerText`. The identity logo comes from the Coupon's Store/Brand, following
the existing affiliate-brand and fallback rules. Its logo container uses the
media’s stored background colour, with white only when no valid colour exists.
Missing badge text stays empty.
Overrides are never copied into source records or autofilled on save.

Gradients cycle through 23 bright festive swatches in Figma node `2259:3712`, starting coral/orange and pink/peach, then the remaining bright palette colours.
Original swatches 1, 4, 6, 10, 23, 26 and 29 are excluded as dark or muted. The sequence is the same on all viewports and requires
no CMS field. The shared horizontal card scroller provides touch scrolling,
pagination and desktop arrows; shared OfferAction preserves redemption behavior.
No autoplay, cloned cards or breakpoint-specific duplicate markup is introduced.

Unpublished, expired, missing and unsafe-destination Coupons are excluded.
An empty or disabled slider is omitted. All remaining editorial selections are
rendered without a display cap. Coupon updates/deletions and merchant identity
edits invalidate the actual Festival owner route. Validation errors address the
specific slide's Coupon picker, including partial relation updates and reordering.

## Product Deal section

`productSection` is the optional fifth section. Its repeatable `items` select
only `api::deal.deal`, with an optional placement title override. Shared Deal
projections and live/safe-link filters preserve current prices, media, codes,
merchant identity and stable public IDs. No cap is applied to the selections.
The frontend virtualizes cards using one template and compact data.

Repeatable category tiles select Categories, with optional label, uploaded image
and URL overrides. The default link is the existing generated name-based Deal
page (`/mobile-phones-deals/`). Overrides accept root-relative or HTTP(S) URLs.
Missing Deal/Category selections report errors at the individual row field.
Product/category row titles reuse the read-only relation fallback. Changes to
selected Deals invalidate the Festival owner through curatedSourcePaths.

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

The API `/api/festival-full` includes `enabled`, countdown, banner and SEO.
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

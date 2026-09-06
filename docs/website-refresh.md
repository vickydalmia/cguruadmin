# Manual website refresh

Saved Content Manager entries have a **Website cache** panel. Select a language
(or **All languages**) and click **Refresh website page**. The target is derived
from the published English record: homepage, editorial pages, entities, jobs,
offer detail pages, template owners, and error pages. Shared components without
a standalone page point administrators to **Settings → Website refresh**.

Settings also accepts an English website path, such as `/amazon/` or `/`, for
routes without their own CMS editor. Choose the language separately; do not paste
a domain, a language prefix, a query string, or a fragment. The **Refresh entire
website** action requires confirmation and applies to the selected language or
all languages on this deployment, not to other country deployments.

Save/publish content before refreshing. This action regenerates HTML from
published content and existing translations. It does not trigger translation,
publish drafts, or remove the last good cached page while rendering is pending.
Use the Translation panel when translated content itself needs updating.

## Access and status

Super Admins have access. Other trusted roles need the Administration Panel
permission **Refresh website cache** (`admin::website-refresh.manage`). All
three endpoints require both an admin session and that permission. Gateway
credentials stay on the server.

The panel tracks the request while it is open:

- **Queued:** stored durably in the CMS outbox, awaiting delivery or retry.
- **Regenerating:** the gateway accepted the page and it has not finished.
- **Page refreshed successfully:** the gateway reports a cached render at least
  as new as this request's version.
- **Failed:** regeneration failed; a previous cached version remains available
  where present. Retry after the underlying issue is resolved.
- **Unavailable:** no matching live page was refreshed, for example a missing
  translation. Mixed-language requests explain when only available pages rendered.
- Whole-site requests remain **Regenerating** while the durable scan runs, then
  report **accepted for background processing**. They do
  not claim that all renders completed. Unvisited on-demand pages stay lazy
  during a whole-site refresh; an explicit individual refresh renders them.

This panel is a request monitor, not a persistent website-wide cache dashboard.
Closing it stops polling. Delivery history remains in `isr_outbox` under reasons
starting with `manual-refresh:admin:` and follows its normal retention policy.

## Delivery and rollout

The existing ISR outbox dispatcher and gateway credentials deliver commands.
A separate durable `isr-manual-warm` Redis queue is consumed by the existing
worker process, isolating new commands from older workers during rollout.
The scan enqueues at most ten paths per second and pauses above 100 queued renders;
render worker limits and cache-retention behaviour still apply. Repeated pending requests
for the same path/language selection coalesce. Large manual page commands fail
rather than silently becoming a whole-site refresh.

Deploy the compatible CMS first, then the updated storefront/gateway/worker.
Use manual refresh only after the gateway upgrade has completed. Manual commands use
`POST /internal/isr/manual-refresh`; an older gateway rejects the unsupported
endpoint. Unsupported/unauthorized commands fail visibly rather than retrying
forever; other manual delivery failures stop after 12 attempts. Manual commands
do not contribute to the ordinary content-delivery backlog health gate.
English uses explicit locale-tree exclusions because English URLs have no
prefix. Other languages use the existing locale-prefix invalidation protocol.
A language-scoped sweep does not advance the global HTML cache version.

The authenticated CMS routes are:

- `GET /website-refresh/options?uid=...&documentId=...`
- `POST /website-refresh/refresh` with `{ locale, all, path?, confirm? }`
- `GET /website-refresh/status/:id`

For individual requests the CMS checks the gateway's existing
`/internal/isr/render-status` endpoint using the versions stored in the delivery
receipt. The admin result includes the cached page's actual generation timestamp,
cache age at the last check, cached HTTP status, target/cached versions,
render-job identifier, retry counts, and retained failure reason. An old cached
page timestamp is explicitly labeled when the requested refresh has not
succeeded. Delivery errors and status-check errors are shown separately.
**Diagnostic response** provides a copyable JSON result for debugging. Secrets,
upstream URLs, stack traces and raw response bodies are not forwarded.

Render failure details come from BullMQ's retained job record. If it has been
pruned, the result says the detail is unavailable and provides version/request
identifiers for server logs. Global refreshes report scan progress and acceptance, not an
invented whole-site render-completion timestamp. Retained job history can expire;
then the panel reports unavailable and allows a new request.

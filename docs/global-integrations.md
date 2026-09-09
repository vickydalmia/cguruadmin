# Global Settings: channels and newsletter

Open **Content Manager → Single Types → Global Settings** as a Super Admin.

| Setting | Purpose |
| --- | --- |
| Telegram URL | Shared banner and footer destination. Telegram banner text and its enabled switch remain in Telegram banner. |
| WhatsApp URL | Shared banner and footer destination. |
| Sendy URL | HTTPS installation base URL; a subdirectory is supported. |
| Sendy List ID | Newsletter list for this country deployment. |

These four settings are shared across languages. Telegram and newsletter copy
remain translated. Channel URLs may be empty, which makes the join link inactive.
Clear both Sendy fields to disable subscriptions. Footer channel entries are
derived from these settings after the other social platforms. Per-deal Telegram
link overrides are unchanged.

Only `SENDY_API_KEY` remains on the **gateway server**. Do not put the API key in
any Global Settings field. Sendy URL/list ID are private schema attributes and
are excluded from public Global and site-chrome responses.

The gateway reads `GET /api/global/newsletter-config` on the admin origin before
each valid subscription. It uses the existing `ISR_ADMIN_SECRET` bearer policy;
responses are `no-store`. The response is
`{ data: { sendyUrl, sendyListId } }`. There is no gateway browser proxy for this
endpoint. Missing configuration, missing API key, or a failed CMS read yields a
503 from `/api/newsletter` without a Sendy request. The browser contract remains
`{ email, name? }` → `{ ok: true }` or `{ ok: false, error }`.

## Upgrade an existing deployment

1. Before starting the updated Strapi image for the first time, temporarily stage
   the **four non-secret old environment values** on its migration process:
   `PUBLIC_TELEGRAM_URL`, `PUBLIC_WHATSAPP_URL` from SSR, and `SENDY_URL`,
   `SENDY_LIST_ID` from the gateway. Never copy `SENDY_API_KEY` to Strapi.
2. Start Strapi. Migration `2026.09.13T00.00.00.global-integrations.js` runs before
   schema sync removes the old Telegram component URL. It preserves populated
   new fields; otherwise Telegram uses the English CTA, then environment, then
   English footer. WhatsApp uses English footer, then environment. Sendy uses
   the staged environment values. Shared values are copied to existing language
   rows. Retired Telegram/WhatsApp footer attachments are removed after copying.
3. Verify the four values in Global Settings. If the old environment values
   were not staged, fill the missing values here **before deploying the gateway
   and storefront**. Migration inputs are never read at runtime or on later
   starts, so clearing a saved value stays cleared.
4. Deploy the gateway and storefront. The old storefront remains compatible
   during this order: site-chrome derives `telegramCta.ctaUrl` from `telegramUrl`
   and returns the generated footer channel links. Only `telegramUrl` is editable.
5. Check banners/footer and a subscription using an approved test address.
   A Global Settings save triggers the existing full chrome refresh, including
   translated pages. A Sendy change takes effect on the next subscription.
6. Remove the four old variables from SSR/gateway and the temporary Strapi
   migration environment. Keep `SENDY_API_KEY` and existing internal auth secrets.

Fresh installations start empty; enter settings after creating Global Settings.
Each country deployment must use its own channel URLs and Sendy list.

## Rollback

Keep a database backup and the previous deployment configuration through the
upgrade. A frontend-only rollback works with the derived compatibility URL and
footer links. A gateway rollback requires restoring its old Sendy URL/list
environment values. Rolling Strapi back requires restoring the pre-upgrade
database backup because schema sync removes the retired component URL column.

# Optional offer currency

Coupons and Product Deals expose a searchable **Offer currency** selector in
**Offer benefits / Deal discount & benefits**. It uses one fixed ISO currency catalogue shared by the picker and server. The field is optional and shared across language versions.

Blank preserves the existing site's price formatting and existing benefit text.
A selection formats automatic prices and monetary benefits using the explicit
code, e.g. `SAR 100`; percentages and manually written copy are unchanged.
Amounts are never converted. A bare `$` amount is accepted only with a dollar
currency selected; non-dollar selections report a conflict without stripping `$`. Monetary benefit inputs accept a number when a
currency is selected. An explicit conflicting currency must be corrected by the
editor. Numeric inputs stay numeric in storage. Changing the selector changes
their displayed currency; clearing it makes them follow the site default.
An internal `usesCurrencyAmounts` flag distinguishes these editor-authored amounts
from untouched legacy text. It is shared across languages, hidden from the editor,
and removed from public responses after formatting. No existing rows are backfilled.

No records are backfilled. No Telegram behavior changes. Site currency settings
remain unchanged. Currency-only edits use the normal shared-field ISR invalidation.

Imports keep their original extraction, normalization, and upsert logic. They do
not infer, insert, or update an offer currency. New imports therefore leave the
optional currency blank; existing selections are not overwritten by imports.
Editors select an override manually on the Coupon or Product Deal. No migration
profiles or source-country configuration are changed by this feature.

Deploy the admin schema/API and rebuilt admin panel before the frontend. Refresh
cached pages as part of the normal deployment. There is no data backfill command.

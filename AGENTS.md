# AGENTS.md

Notes for anyone — human or agent — working in this repo.

## ⚠️ Do not turn a review into an edit

**A review request is a request for an answer, not for a patch. Report the
findings and stop. Do not touch a file until you are asked to.**

This applies to every form the request takes, including:

- "check X, is it correct?" / "list why"
- pasted review comments, findings, or lint output — **even when they are
  clearly valid, and even when the user says they are correct**
- "why does X happen?" / "how does X work?"
- anything already qualified with "don't change anything"

Confirming a finding is real is not the same as asking for it to be fixed.
Those are two separate decisions and the second one belongs to the user. When
you finish a review, say what you found and ask whether to fix it — a one-line
question, not a diff.

Why this matters here: unrequested edits arrive mixed into the working tree
with the changes the user is actually reviewing, so the thing under review
moves while they are reading it. It also spends their time and tokens on work
they had not decided to do, and it hides the review's conclusion under a wall
of implementation.

**When you may edit without a fresh ask:** the user asked for an
implementation in the first place and you are still delivering it. That is it.

## ⚠️ Patched dependencies — RE-CHECK ON EVERY STRAPI UPGRADE

This repo carries `patch-package` patches against `node_modules`. They are applied
by the `postinstall` script and live in `patches/`.

**`yarn upgrade` / `yarn upgrade:dry` / `npx @strapi/upgrade latest` will bump the
Strapi version and the patch will stop applying.** `patch-package` fails loudly
when a patch no longer matches, so a broken upgrade is visible — but a *silently
still-applying* patch on a version where upstream already fixed the bug is worse,
because it means we are carrying a diff for no reason. Check both cases.

### `patches/@strapi+content-manager+5.50.0.patch`

**What it does:** removes the optimistic `onQueryStarted` from the
`updateDocument` RTK Query mutation in
`dist/admin/services/documents.{js,mjs}`.

**Why:** without this patch, **the editor's typed values are wiped whenever a
save is rejected with a 400.** The chain:

1. `onQueryStarted` optimistically writes the submitted data into the
   `getDocument` cache (`Object.assign(draft.data, data)`), then calls
   `patchResult.undo()` in its `catch`.
2. `<Form>`'s `initialValues` are derived from that cache
   (`@strapi/content-manager/dist/admin/hooks/useDocument.mjs`).
3. `@strapi/admin/dist/admin/admin/src/components/Form.mjs` (~line 85) treats any
   `initialValues` change as a reinitialise, and its `SET_INITIAL_VALUES` reducer
   (~line 368) does `draft.values = action.payload` — a wholesale replace.

So the optimistic write drags `initialValues.current` up to the typed values, the
`undo` drags it back to the stored document, `Form` sees a change, and everything
typed is discarded. `errors` is untouched by that action, which is why the inline
red messages survive on top of reverted values.

Removing the optimistic patch fixes it: the refetch that `invalidatesTags`
triggers then returns data deep-equal to `initialValues.current`, Form's
`isEqual` check short-circuits, and nothing is clobbered. The only cost is losing
an optimistic repaint on the success path, which is invisible.

**How to re-verify after an upgrade** (2 minutes, no test covers this — it is
upstream React state):

1. Open any existing Store in the admin.
2. Set `shortDescription` to something under 160 characters and clear `logoAlt`.
3. Save once. Expect: two inline errors **and both fields still showing what you
   typed**. If the fields snap back to their stored values, the patch is not
   applying.
4. `createDocument` never had an `onQueryStarted`, so the create flow is a
   control: it should behave the same before and after the patch.

**If upstream fixes it:** delete the patch file, drop this section, and confirm
step 3 still passes. Worth checking the Strapi changelog for `onQueryStarted`,
`optimistic`, or `SET_INITIAL_VALUES` before doing manual work.

**Dockerfile dependency:** `patches/` is copied *alongside* `package.json` and
`yarn.lock`, before `yarn install`, because `postinstall` runs during that
install. If someone reorders those `COPY` lines the patch silently stops reaching
production — `yarn build` would compile the admin from unpatched sources. Do not
move it below `COPY . .`.

## Write validation

All content validation runs from a single document-service middleware
(`src/index.ts`), which delegates to `src/utils/write-validation/`:

- `problems.ts` — the shared `Problem` shape, `toValidationError`, and
  `ProblemCollector`.
- `steps.ts` — the ordered step registry. **The order is load-bearing**: several
  steps mutate `context.params.data` for the ones after them
  (`normaliseCouponTypeFields` clears `code` before `validateChangedFields`
  length-checks it; `validateOfferLifecycle` derives `contentStatus`).
  `run.test.ts` pins the exact sequence, so a "tidy up" fails loudly.
- `run.ts` — runs mutators, then collects **every** pure validator and throws
  once with the union, so a single Save reports all problems instead of one per
  round trip. Steps that cost money (the deal-image background-removal provider)
  or take a Postgres advisory lock run only after that passes.

To add a validator: write it as a normal `Problem[]`-accumulating function that
throws via `toValidationError`, then register it in `COLLECTED_STEPS` and add its
name to the order assertion in `run.test.ts`.

### The two-layer reality

Strapi validates schema constraints (`required`, `regex`, `maxLength` in
`schema.json`) **client-side**, before the request is sent. Those never reach the
server pipeline — they surface as normal inline field errors on submit. Only
custom rules run through the middleware above.

## ⚠️ Writing to the database during a content write

**Never use raw `strapi.db.connection` for a write that can run inside a content
transaction. Use the transaction, or use `strapi.db.query` / `strapi.documents`.**

This caused a production-shaped outage locally: saves hung indefinitely, the
connection pool drained, and the identity advisory lock was held for ten hours.

### The rule

`strapi.db.query()` and `strapi.documents()` join the ambient transaction
automatically through AsyncLocalStorage —
`@strapi/database/dist/query/query-builder.js` (~line 515):

```js
const transaction = transactionContext.transactionCtx.get();
if (transaction) qb.transacting(transaction);
```

Raw `strapi.db.connection` is the **only** database handle that bypasses this. It
takes a fresh pool connection every time.

### Why that deadlocks

`runContentTransaction` (`src/isr-outbox/transaction.ts`) calls `createEvent`
*before* the commit, while `executeWrite()` still holds row locks on everything
it touched. A raw-connection write to one of those rows waits for a lock that
cannot be released until `createEvent` returns — and `createEvent` cannot return
until the write completes. There is no timeout. The request hangs forever,
permanently burning three connections out of `pool.max: 10` and holding the
identity advisory lock, so every later taxonomy save logs
`[write-lock] … proceeding unserialized`. About three such saves wedge the
instance until it is restarted.

It needs no concurrency: one instance, one editor, one save deadlocks with
itself.

### The near-miss that shows how narrow this is

Two writes sit side by side in that same callback:

- `touchEntityPageUpdatedAt` — raw connection → **deadlocked** (now takes `trx`
  as a required argument, and throws if it is missing).
- `fillHomepageOverrides` (`src/index.ts`) — `strapi.db.query(...).update(...)` →
  joins the transaction → fine.

Nothing in the code makes that difference visible, which is exactly why `trx` is
a required positional parameter rather than an option.

### Diagnosing it

The symptom is a hang, so no test or error log catches it. Go straight to the
database:

```sql
SELECT pid, state, round(extract(epoch FROM now()-query_start)::numeric,1) AS secs,
       left(query,90) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle'
  AND query_start < now() - interval '1 second'
ORDER BY secs DESC;
```

Long-lived `idle in transaction` alongside a write blocked on
`Lock: transactionid` is this bug. Clear it with `pg_terminate_backend(pid)`.

Do NOT read a `[write-lock] … proceeding unserialized` warning as the cause — it
is two steps downstream, and chasing it costs hours.

### On upgrade

Re-confirm `qb.transacting(transactionCtx.get())` is still in
`@strapi/database`'s query builder. If a Strapi release ever stops auto-joining
the ambient transaction, `fillHomepageOverrides` and every other in-callback
`db.query` write silently becomes this same deadlock.

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

import {
  CHECKOUT_MERCHANT_FIELD,
  CHECKOUT_MERCHANT_MAX_LENGTH,
  CHECKOUT_MERCHANT_OFFER_UIDS,
  checkoutMerchantSource,
  formatCheckoutMerchant,
  isBlankCheckoutMerchant,
  isCheckoutMerchantOfferUid,
  parseCheckoutMerchant,
  type CheckoutMerchantKind,
} from '../constants/checkout-merchant';
import { resolveWritePayload } from './write-validation/payload';
import { toValidationError, type Problem } from './write-validation/problems';

/**
 * Referential integrity for `checkoutMerchant`, which is a custom STRING field
 * rather than a relation (src/constants/checkout-merchant.ts explains why) and
 * therefore has no foreign key to do this for us.
 *
 * Two halves, and both are needed — either alone leaves a hole:
 *
 *   1. validateCheckoutMerchant — a write may not introduce a reference to a
 *      Store or Brand that does not exist. Covers the admin picker (which can
 *      only offer real rows, but is not the only writer), the REST API, and
 *      every import script.
 *   2. clearDeletedCheckoutMerchant — deleting a Store or Brand nulls every
 *      offer pointing at it, inside the same transaction as the delete. This
 *      is the half a foreign key would have given us as ON DELETE SET NULL.
 *
 * The validator is grandfathering-aware in the same way as the rest of
 * src/utils: it only judges a payload that actually TOUCHES the field, so an
 * editor fixing a typo on a legacy offer whose merchant was deleted years ago
 * is never blocked by it. `strict` re-arms the check on the effective record.
 */

/** Editor-facing name per kind, for messages. */
const KIND_LABEL: Record<CheckoutMerchantKind, string> = {
  store: 'Store',
  brand: 'Brand',
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export function touchesCheckoutMerchant(data: unknown): boolean {
  return Boolean(
    data &&
      typeof data === 'object' &&
      hasOwn(data, CHECKOUT_MERCHANT_FIELD),
  );
}

export function isCheckoutMerchantUid(uid: string): boolean {
  return isCheckoutMerchantOfferUid(uid);
}

/** Thrown on a read failure when the caller cannot afford to fail open. */
function unverifiableMerchantError(): Error {
  return new errors.ApplicationError(
    'Could not verify the checkout merchant — nothing was saved. Try again.',
  );
}

/**
 * Resolve a reference to its display name, or null when the target is gone.
 * Reads through the document service so it sees the ambient transaction.
 */
async function findMerchantName(
  strapi: Core.Strapi,
  kind: CheckoutMerchantKind,
  documentId: string,
  failClosed: boolean,
): Promise<string | null> {
  const { target } = checkoutMerchantSource(kind);
  try {
    const found: any = await strapi.documents(target as any).findOne({
      documentId,
      fields: ['name'] as any,
    });
    return found ? (found.name ?? '') : null;
  } catch {
    // A lookup failure is not proof of absence. In the aggregated collected
    // pass, returning the id keeps the save unblocked rather than rejecting
    // a valid reference because the database hiccuped mid-validation. The
    // LOCKED revalidation pass cannot afford that: passing on a failed read
    // would commit the exact dangling reference the fail-closed lock exists
    // to prevent — there, the save is rejected as retryable.
    if (failClosed) throw unverifiableMerchantError();
    return documentId;
  }
}

/**
 * Validate the `checkoutMerchant` value on an offer payload. No-op for any
 * other content type, and for any payload that does not carry the field.
 *
 * Throws errors.ValidationError with `details.errors[].path` pointing at the
 * field, so the admin renders the problem inline on the dropdown and the
 * Validation problems panel lists it.
 */
export async function validateCheckoutMerchantForWrite(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: any,
  documentId?: string,
  strict: boolean = false,
  failClosed: boolean = false,
): Promise<void> {
  if (!isCheckoutMerchantOfferUid(uid)) return;
  if (!['create', 'update', 'clone'].includes(action)) return;

  // A clone may carry no `data` at all while Strapi still copies the source
  // document's checkoutMerchant value — the shared helper normalizes that to
  // an empty payload so the inherited reference is validated, not skipped.
  const payload = resolveWritePayload(action, data);
  if (!payload) return;

  const touched = hasOwn(payload, CHECKOUT_MERCHANT_FIELD);

  // Untouched and not strict: nothing to judge. Reading the stored value to
  // re-validate it would block unrelated edits on legacy rows, which is
  // exactly the whack-a-mole the rest of this pipeline avoids.
  if (!touched && !strict && action !== 'clone') return;

  let value: unknown = touched
    ? Reflect.get(payload, CHECKOUT_MERCHANT_FIELD)
    : undefined;

  // strict (and clone, whose payload may omit the field while Strapi copies
  // the stored one) judges the EFFECTIVE record, so fall back to what is
  // already stored when this write does not carry the field.
  if (!touched && documentId) {
    try {
      const stored: any = await strapi.documents(uid as any).findOne({
        documentId,
        fields: [CHECKOUT_MERCHANT_FIELD] as any,
      });
      value = stored?.[CHECKOUT_MERCHANT_FIELD];
    } catch {
      // Same open/closed split as findMerchantName: the collected pass may
      // shrug a hiccup off (the locked revalidation will re-read), the
      // locked pass may not.
      if (failClosed) throw unverifiableMerchantError();
      return;
    }
  }

  // A clone with an inherited value writes through the payload below (both
  // canonicalization branches), which requires the payload to be the REAL
  // params.data object — the content-write middleware guarantees that by
  // normalizing a clone's missing data to {} before validation runs.
  const writesThrough = touched || action === 'clone';

  if (isBlankCheckoutMerchant(value)) {
    // A blank ("" or whitespace) means "no merchant" — store NULL, not the
    // raw spelling, so downstream equality filters never meet a padded empty
    // string. Applies to a clone's inherited blank too: the explicit null in
    // the payload overrides the copied spelling.
    if (writesThrough && value !== null && value !== undefined) {
      Reflect.set(payload, CHECKOUT_MERCHANT_FIELD, null);
    }
    return;
  }

  const problems: Problem[] = [];
  const path = [CHECKOUT_MERCHANT_FIELD];

  if (typeof value !== 'string' || value.length > CHECKOUT_MERCHANT_MAX_LENGTH) {
    problems.push({
      path,
      message:
        `Checkout merchant must be a reference of at most ` +
        `${CHECKOUT_MERCHANT_MAX_LENGTH} characters. Re-pick the merchant from ` +
        `the dropdown.`,
    });
    throw toValidationError(problems);
  }

  const ref = parseCheckoutMerchant(value);
  if (!ref) {
    problems.push({
      path,
      message:
        `Checkout merchant is not a valid reference ("${value}"). It must read ` +
        `"store:<id>" or "brand:<id>" — re-pick the merchant from the dropdown.`,
    });
    throw toValidationError(problems);
  }

  const name = await findMerchantName(
    strapi,
    ref.kind,
    ref.documentId,
    failClosed,
  );
  if (name === null) {
    problems.push({
      path,
      message:
        `Checkout merchant points at a ${KIND_LABEL[ref.kind]} that no longer ` +
        `exists ("${ref.documentId}"). Pick another merchant, or clear the field.`,
    });
    throw toValidationError(problems);
  }

  // Canonicalize what gets STORED. parseCheckoutMerchant tolerates padding
  // (" store:x "), but everything downstream that matches by equality — the
  // festive scope's `checkoutMerchant` filter in isr-outbox/scopes.ts,
  // clearDeletedCheckoutMerchant's WHERE, detachAffiliateBrand's
  // allowedMerchant comparisons — assumes the canonical spelling. Touched
  // payloads rewrite in place; a CLONE's inherited value writes the
  // canonical spelling into the payload so the brand-NEW row never inherits
  // a legacy spelling those equality consumers would silently miss. Only an
  // untouched UPDATE is left alone: rewriting the stored row is not this
  // write's job.
  if (writesThrough) {
    const canonical = formatCheckoutMerchant(ref);
    if (value !== canonical) {
      Reflect.set(payload, CHECKOUT_MERCHANT_FIELD, canonical);
    }
  }
}

/**
 * Null every offer reference to a Store or Brand that is being deleted.
 *
 * MUST be called with the delete's own transaction in scope. It uses
 * `strapi.db.query(...).updateMany(...)`, which joins the ambient transaction
 * through AsyncLocalStorage (see AGENTS.md — a raw `strapi.db.connection`
 * write here would take a second pool connection and deadlock against the row
 * locks the delete is still holding).
 *
 * Returns the number of offers cleared, for the caller's log line.
 */
export async function clearDeletedCheckoutMerchant(
  strapi: Core.Strapi,
  kind: CheckoutMerchantKind,
  documentId: string,
): Promise<number> {
  const value = `${kind}:${documentId}`;
  let cleared = 0;

  for (const uid of CHECKOUT_MERCHANT_OFFER_UIDS) {
    const affected = await strapi.db.query(uid).updateMany({
      where: { [CHECKOUT_MERCHANT_FIELD]: value },
      data: { [CHECKOUT_MERCHANT_FIELD]: null },
    });
    // updateMany returns { count } on Strapi 5; stay defensive so a shape
    // change downgrades the log line rather than throwing mid-delete.
    cleared += typeof affected?.count === 'number' ? affected.count : 0;
  }

  return cleared;
}

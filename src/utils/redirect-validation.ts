import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  REDIRECT_RESERVED_ROUTE_LABELS,
  reservedRouteSegment,
} from './reserved-route-segments';
import {
  foldPathKey,
  isAssetFromPath,
  isWireSafeFromPath,
  normalizeRedirectPath,
  redirectKey,
} from './redirect-paths';
import { classifyTarget, findLiveEntity } from './redirect-targets';
import {
  ACTIVE_REDIRECT_LIMIT,
  REDIRECT_MAX_HOPS,
  REDIRECT_UID,
  findDuplicateFrom,
  loadActiveEdges,
  walkChain,
} from './redirect-graph';
import { readBoolean, readString } from './row-fields';

/**
 * Write-time safety rules for the editor-managed `redirect` collection.
 *
 * WHY THIS FILE IS THE MOST DEFENSIVE VALIDATOR IN THE ADMIN
 * ----------------------------------------------------------
 * A redirect row is executed by cguru-ui/src/middleware.ts on EVERY request,
 * BEFORE routing, and it is authored by an editor with no code review and no
 * deploy gate. The three failure modes are all site-wide:
 *
 *  1. `from === to` — an unconditional self-redirect. The browser gives up
 *     after ~20 hops and the URL is dead for everyone.
 *  2. `from` equal to a LIVE entity slug — the redirect fires before the page
 *     renders, so a real store/brand/category/bank page becomes unreachable.
 *     Nothing else in the stack notices: the page still builds, the sitemap
 *     still lists it, and the route manifest still holds it. This is the
 *     single most important guard here.
 *  3. A cycle across SEVERAL rows (a→b, b→c, c→a). No single row looks wrong,
 *     which is exactly why it has to be caught at write time by walking the
 *     graph rather than by inspecting the row in isolation.
 *
 * The frontend resolver carries its own read-time cap (visited set, 5 hops,
 * return the last good hop) so a loop that somehow reaches production degrades
 * to an extra hop instead of a browser redirect loop. These write-time guards
 * are the primary defence; that cap is the backstop. Neither replaces the
 * other.
 *
 * GRANDFATHERING
 * --------------
 * Redirect rows go stale through no fault of their author: a redirect at
 * `/winter-sale` is legal today and starts shadowing a real page the moment
 * somebody creates a category with that slug. An editor who later opens that
 * row to fix its `note` must still be able to save. So every rule is gated on
 * the payload ACTUALLY CHANGING the field it protects:
 *
 *  - `from` is re-checked when `from` changes, or when the row is switched
 *    from inactive to active (flipping a shadowing redirect ON is the moment
 *    it starts breaking the site, and the editor demonstrably touched it).
 *  - `to` format is only reported when `to` changes. When `from` changes and
 *    the STORED `to` is unusable, the cross-field guards are skipped rather
 *    than blocking on a value this writer never saw.
 *  - An inactive row is exempt from the live-shadowing, duplicate and cycle
 *    guards entirely — it does not run.
 *
 * PARTIAL PAYLOADS
 * ----------------
 * `context.params.data` is partial on update. Nothing derives from the payload
 * alone: the stored document is read and the payload merged over it. A write
 * that touches none of from/to/active/statusCode returns before any query, so
 * an unrelated partial update never pays for this and never trips a stale row.
 */

// Path parsing/keys live in ./redirect-paths, target classification in
// ./redirect-targets, and the active-edge graph walk in ./redirect-graph
// (which also owns REDIRECT_UID and REDIRECT_MAX_HOPS).

// A redirect `from` a segment owned by a real page in cguru-ui/src/pages/
// shadows the route in exactly the same way it shadows an entity — `/search`
// redirecting somewhere takes site search offline. The shared key set (with
// this validator's editor-facing labels) lives in ./reserved-route-segments;
// reserved-route-drift.test.ts pins the two consumers' key sets together.

type Problem = { path: string[]; message: string };

export function isRedirectUid(uid: string): boolean {
  return uid === REDIRECT_UID;
}

/**
 * Validate a redirect write. No-op for every other content type and for any
 * payload that leaves from/to/active/statusCode alone. Throws
 * errors.ValidationError with details.errors[].path so the admin highlights
 * the offending field inline instead of surfacing a raw 500.
 */
export async function validateRedirect(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!isRedirectUid(uid)) return;
  if (!data || typeof data !== 'object') return;

  const has = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const fromTouched = has('from');
  const toTouched = has('to');
  const activeTouched = has('active');
  const isClone = action === 'clone';

  // Every NON-strict write that leaves the routing-relevant fields alone (a
  // `note` edit, a `statusCode`-only change, any future partial update, and
  // notably the cron/programmatic path) stops here — no read, no query, no
  // chance of failing on a stale value the writer never saw. Under strict a
  // human save must clean the whole record, so even a note-only edit runs the
  // full guard set against the effective row.
  if (!strict && !isClone && !fromTouched && !toTouched && !activeTouched) return;

  const isCreate = action === 'create';

  const stored: unknown =
    (action === 'update' || isClone) && documentId
      ? await strapi.documents(REDIRECT_UID as any).findOne({
          documentId,
          fields: ['documentId', 'from', 'to', 'active'] as any,
        })
      : null;
  if (isClone && documentId && !stored) return;

  // Payload merged OVER the stored row — never derive from the payload alone.
  const mergedFrom = fromTouched ? Reflect.get(data, 'from') : readString(stored, 'from');
  const mergedTo = toTouched ? Reflect.get(data, 'to') : readString(stored, 'to');
  const mergedActive = activeTouched
    ? Reflect.get(data, 'active') !== false
    : (readBoolean(stored, 'active') ?? true);

  const fromPath = normalizeRedirectPath(mergedFrom);
  const fromKey = foldPathKey(fromPath);
  const target = classifyTarget(mergedTo);

  const storedFromKey = redirectKey(readString(stored, 'from'));
  // strict re-arms every guard against the whole effective record, so a dirty
  // untouched `from`/`to` on a legacy row is no longer grandfathered on a human
  // save — the record must be fully clean before it saves.
  const fromChanged =
    strict || isClone || (fromTouched && (isCreate || fromKey !== storedFromKey));
  const toChanged =
    strict ||
    isClone ||
    (toTouched &&
      (isCreate ||
        (typeof mergedTo === 'string' ? mergedTo.trim() : '') !==
          (readString(stored, 'to') ?? '').trim()));
  // Switching a row ON is the moment a shadowing or looping rule starts
  // executing, so it re-arms the live checks even though `from` is untouched.
  const activated =
    mergedActive &&
    (isCreate ||
      isClone ||
      (activeTouched && readBoolean(stored, 'active') !== true));

  const problems: Problem[] = [];

  if (fromChanged && !fromPath) {
    problems.push({
      path: ['from'],
      message:
        'From must be a path on this site starting with "/", for example "/old-page".',
    });
  } else if (fromChanged && fromPath && !isWireSafeFromPath(fromPath)) {
    // F5: a raw character the browser would percent-encode on the wire (a
    // space, apostrophe, parenthesis, comma, accented letter, …) can never
    // match the request, which arrives already encoded. Force the wire form.
    problems.push({
      path: ['from'],
      message:
        `"${fromPath}" contains a character that must be percent-encoded to ` +
        `match a real request (a space, apostrophe, parenthesis, comma or ` +
        `similar). The site compares the URL exactly as the browser sends it, ` +
        `so write the encoded form instead — for example "/mens-sale" or ` +
        `"/men%27s", and "/caf%C3%A9" for "/café". Use only letters, digits, ` +
        `"-", ".", "_", "~", "/", or "%XX" escapes.`,
    });
  } else if (fromChanged && fromPath && isAssetFromPath(fromPath)) {
    // The gateway answers asset requests before the redirect table is ever
    // consulted, so a rule from an asset path saves but never runs.
    problems.push({
      path: ['from'],
      message:
        `"${fromPath}" is served as a static asset, so a redirect from it ` +
        `would never run — the server answers asset requests before the ` +
        `redirect table is consulted. Redirect a retired page URL instead.`,
    });
  }

  if (toChanged && target.kind === 'invalid') {
    problems.push({ path: ['to'], message: `To ${target.reason}.` });
  }

  // Cross-field guards need BOTH sides usable. When the unusable side is one
  // this writer did not touch, skip rather than block — that is the
  // grandfathering rule, and it is why these are not `else` branches above.
  const usable = Boolean(fromPath) && target.kind !== 'invalid';
  const liveChecks = mergedActive && (fromChanged || activated);

  // 1. Self-redirect. Cheap, no query, and unconditionally fatal.
  if (usable && (fromChanged || toChanged) && target.kind === 'internal') {
    if (target.key === fromKey) {
      problems.push({
        path: ['to'],
        message:
          `To and From both resolve to "${fromPath}", so this rule redirects the ` +
          `URL to itself. The browser would follow it until it gives up and the ` +
          `page would be unreachable. Point To at a different path.`,
      });
    }
  }

  // 2. Shadowing a live page. THE critical guard.
  if (usable && liveChecks && problems.length === 0) {
    // The site root is always a live, durable page (the home page) but has no
    // path segment for the reserved/entity lookups below to match. At the ISR
    // gateway the home page is served from the durable cache BEFORE the authored
    // redirect map is consulted, so a redirect `from: "/"` would be silently
    // ignored in production while still taking the home page offline under SSR.
    // Reject it outright. (Unambiguous asset paths are rejected by the
    // isAssetFromPath guard above; entities created AFTER a rule is authored
    // can still shadow at the gateway — those are not knowable here.)
    if (fromPath === '/') {
      problems.push({
        path: ['from'],
        message:
          '"/" is the site home page. A redirect from "/" runs before routing ' +
          'and would take the home page offline for every visitor. Redirect a ' +
          'retired URL instead.',
      });
    }
    const reserved =
      problems.length === 0
        ? reservedRouteSegment(
            REDIRECT_RESERVED_ROUTE_LABELS,
            fromPath.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '',
          )
        : undefined;
    if (reserved) {
      problems.push({
        path: ['from'],
        message:
          `"${fromPath}" is served by ${reserved}. This redirect runs before ` +
          `routing, so saving it would take that page offline for every visitor. ` +
          `Redirect a retired URL instead.`,
      });
    } else if (problems.length === 0) {
      const entity = await findLiveEntity(strapi, fromPath);
      if (entity) {
        const via = entity.slug.toLowerCase() === fromPath.replace(/^\/+/, '').toLowerCase()
          ? ''
          : ` (stored as "${entity.slug}")`;
        const pageLabel = entity.entityDealPage
          ? `generated Product Deal page of the ${entity.kind}`
          : `live page of the ${entity.kind}`;
        problems.push({
          path: ['from'],
          message:
            `"${fromPath}" is the ${pageLabel} "${entity.name}"` +
            `${via}. This redirect runs before routing, so saving it would make ` +
            `that page unreachable everywhere on the site while it still appears ` +
            `in the sitemap and in every link to it. Redirect a retired URL, or ` +
            `delete/rename the ${entity.kind} first.`,
        });
      }
    }
  }

  // 2b. Table-size cap, enforced at write. The frontend resolver pages in at
  // most MAX_REDIRECT_PAGES × 100 rows and the cycle walk below loads at most
  // ACTIVE_REDIRECT_LIMIT edges, so an active rule beyond that ceiling is saved
  // but NEVER executes (and can hide a cycle from the walk). Only a write that
  // ADDS an active rule — a create/clone that is active, or an activation —
  // pays for the count; editing an already-active row does not.
  if (activated && problems.length === 0) {
    const activeCount: number = await strapi.documents(REDIRECT_UID as any).count({
      filters: { active: true } as any,
    });
    if (activeCount >= ACTIVE_REDIRECT_LIMIT) {
      problems.push({
        path: ['active'],
        message:
          `The redirect table is limited to ${ACTIVE_REDIRECT_LIMIT.toLocaleString()} ` +
          `active rules — beyond that a rule is saved but never runs. There are ` +
          `already ${activeCount.toLocaleString()}. Switch an unused rule off before ` +
          `adding another.`,
      });
    }
  }

  // 3. Duplicate `from`, and cycle detection across the whole active graph.
  // The two checks share one graph load but re-arm on DIFFERENT edits:
  //  - the DUPLICATE check re-arms on (fromChanged || activated) only. A
  //    to-only edit on a legacy row whose `from` case-folds onto another
  //    active row (a casing variant that slipped past the byte-exact unique
  //    index) must still save — the editor never touched `from`, and blocking
  //    the save would also block ever fixing that row.
  //  - the CYCLE walk re-arms on toChanged as well, because pointing `to` at
  //    a new destination is exactly how a cycle is closed.
  // A clone forces fromChanged (isClone), so it always re-arms both.
  const duplicateArmed = fromChanged || activated;
  const cycleArmed = fromChanged || toChanged || activated;
  if (usable && mergedActive && cycleArmed && problems.length === 0) {
    const edges = await loadActiveEdges(
      strapi,
      action === 'update' ? documentId : undefined,
    );

    const duplicate = duplicateArmed ? findDuplicateFrom(edges, fromKey) : null;
    if (duplicate) {
      problems.push({
        path: ['from'],
        message:
          `Another active redirect already sends "${duplicate.fromPath}" to ` +
          `"${duplicate.note}". Two rules for one URL means only one of them ` +
          `ever runs, and which one is arbitrary. Edit that rule instead, or ` +
          `switch it off.`,
      });
    } else {
      // Insert the pending edge, then walk from it. On a to-only edit of a
      // legacy duplicate row this OVERWRITES the other row's edge for the
      // walk — the row being written is the edge whose acyclicity matters.
      edges.set(fromKey, {
        fromPath,
        toPath: target.kind === 'internal' ? target.path : null,
        note: target.kind === 'internal' ? target.path : target.raw,
      });

      const chain = walkChain(edges, fromKey);
      if (chain?.kind === 'loop') {
        problems.push({
          path: ['to'],
          message:
            `This rule closes a redirect loop: ${chain.path.join(' → ')}. Visitors ` +
            `would be bounced between those URLs until the browser gives up. ` +
            `Point To at a page that is not itself redirected.`,
        });
      } else if (chain?.kind === 'too-long') {
        problems.push({
          path: ['to'],
          message:
            `This rule makes a redirect chain longer than ${REDIRECT_MAX_HOPS} hops: ` +
            `${chain.path.join(' → ')}. The site only follows ${REDIRECT_MAX_HOPS}, so ` +
            `visitors would be left part-way along it. Point To at the final ` +
            `destination directly.`,
        });
      }
    }
  }

  if (!problems.length) return;

  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This redirect has ${problems.length} ${noun} (the fields are highlighted in ` +
      `the form):\n• ${problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('\n• ')}`,
    {
      errors: problems.map((p) => ({
        path: p.path,
        message: p.message,
        name: 'ValidationError',
      })),
      problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
    }
  );
}

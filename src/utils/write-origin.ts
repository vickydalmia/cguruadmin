import type { Core } from '@strapi/strapi';

/**
 * True when the current write originates from a live HTTP request — a human
 * editing in the admin (or an authenticated API client) — as opposed to a
 * background write with no request context.
 *
 * WHY THIS GATES STRICT ("clean as you touch") VALIDATION
 * -------------------------------------------------------
 * The product rule is: when an editor opens a record and saves, EVERY field
 * must be valid before the save succeeds — including legacy/WordPress-migrated
 * violations, even on fields the editor did not change. That deliberately
 * blocks the save until the whole record is clean, so migrated data is cleaned
 * one record at a time as it is touched, without a risky bulk migration.
 *
 * But the SAME documents middleware also runs for the 5-minute status cron
 * (config/cron-tasks.ts), which issues partial `{ contentStatus }` updates over
 * migrated rows that may still hold dirty data. Enforcing the full-record rules
 * there would make the cron throw on a dirty offer and silently stop flipping
 * statuses site-wide. The cron runs with no HTTP request; a human admin save
 * always has one. So strict enforcement keys off exactly that signal.
 *
 * The WordPress migration itself writes raw SQL (migration/src/utils/
 * strapi-insert.ts) and never reaches this middleware at all, so migrated rows
 * land untouched and are only ever validated when a human later edits them —
 * which is the intent.
 *
 * `requestContext` is AsyncLocalStorage-backed (Strapi 5): `.get()` returns the
 * Koa ctx during a request and `undefined` outside one (cron, bootstrap).
 */
export function isHumanWrite(strapi: Core.Strapi): boolean {
  return Boolean(strapi?.requestContext?.get());
}

/**
 * True only for writes made through the Content Manager collection-type API.
 *
 * This is intentionally narrower than `isHumanWrite`: custom admin routes,
 * authenticated integrations, and public APIs also have a request context but
 * must keep the database's many-to-many Store compatibility. Koa exposes the
 * matched request at `ctx.path`; `request.path` is accepted as a defensive
 * fallback for focused tests and future Strapi context-shape changes.
 */
export function isContentManagerWrite(strapi: Core.Strapi): boolean {
  const context = strapi?.requestContext?.get?.() as
    | { path?: unknown; request?: { path?: unknown } }
    | undefined;
  const path = context?.path ?? context?.request?.path;
  return (
    typeof path === 'string' &&
    path.startsWith('/content-manager/collection-types/')
  );
}

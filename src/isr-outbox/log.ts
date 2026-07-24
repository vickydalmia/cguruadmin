import type { Core } from '@strapi/strapi';

export function logIsrOutbox(
  strapi: Core.Strapi,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  // Strapi's default logger expects a message string. Passing the metadata
  // object as the first argument renders as "[object Object]" in production,
  // hiding the event name, retry error, and affected paths. Emit one stable
  // JSON line so both Docker logs and log collectors retain every field.
  (strapi.log[level] as any)(JSON.stringify({
    event,
    component: 'isr-outbox',
    ...fields,
  }));
}

import type { Core } from '@strapi/strapi';

export function logIsrOutbox(
  strapi: Core.Strapi,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  (strapi.log[level] as any)({
    event,
    component: 'isr-outbox',
    ...fields,
  });
}

import type { Core } from '@strapi/strapi';

/** One stable JSON line per event — same discipline as logIsrOutbox. */
export function logTranslation(
  strapi: Core.Strapi,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  (strapi.log[level] as any)(
    JSON.stringify({
      event,
      component: 'translation',
      ...fields,
    }),
  );
}

import type { Core } from '@strapi/strapi';

let lastDiagnosticAt = 0;
let suppressed = 0;

/** Guard a registration, never an outbox ID: coalesced writes are independent. */
export function onceOnCommit(strapi: Core.Strapi, callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      suppressed += 1;
      if (Date.now() - lastDiagnosticAt >= 60_000) {
        strapi.log.warn(`[transaction] duplicate commit callbacks suppressed: ${suppressed}`);
        lastDiagnosticAt = Date.now();
        suppressed = 0;
      }
      return;
    }
    called = true;
    callback();
  };
}

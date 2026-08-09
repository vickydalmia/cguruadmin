import type { Core } from '@strapi/strapi';

import { assertCloneRelationFieldCoverage } from './clone-relation-overrides';
import { createContentWriteDocumentMiddleware } from './content-write-document-middleware';
import { createRecordLockDocumentMiddleware } from './record-lock-document-middleware';

export const DOCUMENT_MIDDLEWARE_ORDER = [
  'recordLockDocumentMiddleware',
  'contentWriteDocumentMiddleware',
] as const;

export function registerDocumentMiddlewares(strapi: Core.Strapi): void {
  // Fail startup if a schema gained a relation field the clone override
  // neither covers nor explicitly excludes — silently falling back to
  // Strapi's broken clone merge is the failure mode this table exists for.
  assertCloneRelationFieldCoverage(strapi);
  strapi.documents.use(createRecordLockDocumentMiddleware(strapi));
  strapi.documents.use(createContentWriteDocumentMiddleware(strapi) as any);
}

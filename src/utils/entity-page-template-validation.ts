import type { Core } from '@strapi/strapi';
import {
  findEntityTemplateOwners,
  type EntityPageTemplate,
} from '../api/site-configuration/services/entity-template-owners';
import { toValidationError } from './write-validation/problems';

// The campaign singletons (Deal of the Day, Independence Day Sale) hold ONE
// page's content. Two entities sharing the template would publish the same
// singleton at two self-canonical URLs — duplicate indexable pages — and the
// route metadata/sitemap would list both. One owner per template, enforced at
// write time.

const ENTITY_TEMPLATE_UIDS = new Set([
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
]);

const SINGLETON_TEMPLATES = new Set<EntityPageTemplate>([
  'dealTemplate',
  'independenceDayTemplate',
]);

export function isEntityTemplateUid(uid: string): boolean {
  return ENTITY_TEMPLATE_UIDS.has(uid);
}

export async function validateUniqueEntityPageTemplate(
  strapi: Core.Strapi,
  data: any,
  documentId?: string,
  action = 'update',
  uid?: string,
): Promise<void> {
  let pageTemplate = data?.pageTemplate;
  // Clone payloads contain overrides, not necessarily every copied field. If
  // pageTemplate is omitted, inspect the source document so an inherited
  // singleton template cannot bypass this guard.
  if (
    action === 'clone' &&
    pageTemplate === undefined &&
    documentId &&
    uid &&
    isEntityTemplateUid(uid)
  ) {
    const source: any = await strapi.documents(uid as any).findOne({
      documentId,
      fields: ['pageTemplate'] as any,
    });
    pageTemplate = source?.pageTemplate;
  }
  if (
    typeof pageTemplate !== 'string' ||
    !SINGLETON_TEMPLATES.has(pageTemplate as EntityPageTemplate)
  ) {
    return;
  }

  const owners = await findEntityTemplateOwners(
    strapi,
    pageTemplate as Exclude<EntityPageTemplate, 'default'>,
  );
  // On update (and on a first locale version, which validates as a create
  // with its shared documentId) the current document is the legitimate
  // owner. On clone, Strapi's documentId identifies the SOURCE document, not
  // the new row, so excluding it would let the clone duplicate its campaign
  // template.
  const currentDocumentId = action === 'clone' ? undefined : documentId;
  const other = owners.find((owner) => owner.documentId !== currentDocumentId);
  if (other) {
    throw toValidationError([
      {
        path: ['pageTemplate'],
        message: `Only one entity can use this page template. It is already assigned to the ${other.kind} "${other.slug}" — clear it there first.`,
      },
    ]);
  }
}

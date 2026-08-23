// CSV export COLUMN DEFINITIONS: the schema-derived column set and the
// narrow populate each target needs. One of the modules split out of the
// csv-export service (see ./csv-export.ts). Column order here IS the wire
// contract — the admin fetches pages one at a time and every page must
// carry the identical header.
import {
  CHECKOUT_MERCHANT_FIELD,
} from '../../../constants/checkout-merchant';
import { type CsvExportUid } from '../../../constants/csv-export';

export type ColumnKind =
  | 'scalar'
  | 'json'
  | 'relation'
  | 'media'
  | 'audit-user'
  | 'merchant';

export type Column = {
  /** CSV header cell. */
  header: string;
  /** Path into the populated document, e.g. ['seo', 'metaTitle']. */
  path: string[];
  kind: ColumnKind;
  /** relation: the attribute on the related row to display. */
  displayField?: string;
  /** media: which file attribute this column carries. */
  mediaField?: 'url' | 'name' | 'alternativeText';
};

/** Resolves a content-type or component uid to its loaded schema. */
export type ModelResolver = (uid: string) => any;

export const ADMIN_USER_UID = 'admin::user';

const MEDIA_FIELDS = ['url', 'name', 'alternativeText'] as const;

const ADMIN_USER_FIELDS = ['firstname', 'lastname', 'username'];

/**
 * Attributes Strapi adds to every content type at load time. They are walked
 * explicitly, in this order, AFTER the schema's own attributes so the audit
 * trail always sits in the last columns regardless of where the loader put
 * them. `localizations` is omitted: none of the exported types is localized
 * and the self-relation would only ever hold the row itself.
 */
const TRAILING_ATTRIBUTES = [
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
] as const;

const SKIPPED_ATTRIBUTES = new Set<string>([...TRAILING_ATTRIBUTES, 'localizations']);

const DISPLAY_FIELD_BY_UID: Record<string, string> = {
  'api::coupon.coupon': 'title',
  'api::deal.deal': 'title',
  [ADMIN_USER_UID]: 'email',
};

export function relationDisplayField(targetUid: string): string {
  return DISPLAY_FIELD_BY_UID[targetUid] ?? 'name';
}

function attributesOf(model: any): Array<[string, any]> {
  const attributes = model?.attributes;
  if (!attributes || typeof attributes !== 'object') return [];
  return Object.entries(attributes);
}

function isCheckoutMerchantAttribute(name: string, attribute: any): boolean {
  return name === CHECKOUT_MERCHANT_FIELD && attribute?.type === 'customField';
}

function columnsForAttribute(
  name: string,
  attribute: any,
  prefix: string[],
  getModel: ModelResolver,
  depth: number,
): Column[] {
  const path = [...prefix, name];
  const header = path.join('.');
  switch (attribute?.type) {
    case 'password':
      return [];
    case 'relation': {
      const target = String(attribute.target ?? '');
      if (target === ADMIN_USER_UID) {
        return [{ header, path, kind: 'audit-user' }];
      }
      return [{ header, path, kind: 'relation', displayField: relationDisplayField(target) }];
    }
    case 'media':
      return MEDIA_FIELDS.map((mediaField) => ({
        header: `${header}.${mediaField}`,
        path,
        kind: 'media' as const,
        mediaField,
      }));
    case 'component': {
      // Repeatable components and anything nested too deep become one JSON
      // cell: a row-per-entry CSV cannot represent a list of objects as
      // columns without inventing a fixed count.
      if (attribute.repeatable || depth >= 3) {
        return [{ header, path, kind: 'json' }];
      }
      const component = getModel(String(attribute.component ?? ''));
      if (!component) return [{ header, path, kind: 'json' }];
      return attributesOf(component).flatMap(([childName, child]) =>
        columnsForAttribute(childName, child, path, getModel, depth + 1),
      );
    }
    case 'dynamiczone':
    case 'json':
      return [{ header, path, kind: 'json' }];
    case 'customField':
      if (isCheckoutMerchantAttribute(name, attribute) && prefix.length === 0) {
        return [{ header, path, kind: 'merchant' }];
      }
      return [{ header, path, kind: 'scalar' }];
    default:
      return [{ header, path, kind: 'scalar' }];
  }
}

/**
 * The ordered column list for a content type: id, documentId, the schema's
 * own attributes in declaration order, then the audit/lifecycle attributes.
 */
export function buildColumns(uid: string, getModel: ModelResolver): Column[] {
  const model = getModel(uid);
  if (!model) throw new Error(`csv-export: unknown model ${uid}`);

  const columns: Column[] = [
    { header: 'id', path: ['id'], kind: 'scalar' },
    { header: 'documentId', path: ['documentId'], kind: 'scalar' },
  ];

  for (const [name, attribute] of attributesOf(model)) {
    if (SKIPPED_ATTRIBUTES.has(name)) continue;
    columns.push(...columnsForAttribute(name, attribute, [], getModel, 0));
  }

  for (const name of TRAILING_ATTRIBUTES) {
    const attribute = model.attributes?.[name];
    if (!attribute) continue;
    columns.push(...columnsForAttribute(name, attribute, [], getModel, 0));
  }

  return columns;
}

/**
 * Populate object matching `buildColumns`: related rows contribute only
 * their display field and documentId, media only the three file attributes,
 * components recurse. Returns `true` for a schema with nothing to populate so
 * a component of plain scalars is still loaded.
 */
export function buildPopulate(
  uid: string,
  getModel: ModelResolver,
  depth = 0,
): Record<string, any> | true {
  const model = getModel(uid);
  if (!model) return true;

  const populate: Record<string, any> = {};
  for (const [name, attribute] of attributesOf(model)) {
    if (name === 'localizations') continue;
    switch (attribute?.type) {
      case 'relation': {
        const target = String(attribute.target ?? '');
        // admin::user.email is `private`, and the document service validates a
        // populate's nested `fields` with the private-field rule ("Invalid key
        // email"). Populate the name parts only; emails are resolved per page
        // through strapi.db.query (resolveAdminEmails), which also keeps the
        // password hash and reset tokens out of the loaded rows.
        populate[name] =
          target === ADMIN_USER_UID
            ? { fields: ADMIN_USER_FIELDS }
            : { fields: [relationDisplayField(target), 'documentId'] };
        break;
      }
      case 'media':
        populate[name] = { fields: [...MEDIA_FIELDS] };
        break;
      case 'component': {
        // A nested `populate: true` is rejected by the query converter
        // ("Expected a string, an array of strings, a populate object"); a
        // component of plain scalars is loaded by setting the component
        // itself to true.
        const nested =
          depth >= 3
            ? true
            : buildPopulate(String(attribute.component ?? ''), getModel, depth + 1);
        populate[name] = nested === true ? true : { populate: nested };
        break;
      }
      case 'dynamiczone':
        populate[name] = true;
        break;
      default:
        break;
    }
  }
  return Object.keys(populate).length ? populate : true;
}

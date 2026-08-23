import EntryLinkCell from '../components/EntryLinkCell';
import { isLinkableCellType } from './entry-link';

/**
 * Content-manager list rows are `<tr>`s with a JS click handler, so middle-click,
 * Cmd-click and right-click → "Open in New Tab" all do nothing and editors can't
 * fan a review queue out into tabs. Strapi CE exposes no cell override; the only
 * supported seam is this waterfall, whose `cellFormatter` fully owns a cell's
 * rendering — so re-render the lead column as a real `<a href>` to the edit view.
 *
 * Scoped to the FIRST column (the one editors aim at) and to plain-text
 * attributes on purpose: taking over a relation/media/component cell would mean
 * reimplementing its popovers and thumbnails, and a broken list view blocks all
 * content editing. i18n appends its "Available in" column to the END of this
 * same list, so the first entry is always a real content column.
 */
export const INJECT_COLUMN_IN_TABLE = 'Admin/CM/pages/ListView/inject-column-in-table';

type ListViewHeaders = { displayedHeaders: any[]; layout: unknown };

export const linkifyFirstColumnHook = ({ displayedHeaders, layout }: ListViewHeaders) => {
  const [first, ...rest] = displayedHeaders ?? [];

  // Leave the table untouched unless the lead column is plain text and no other
  // plugin has already claimed its rendering.
  if (!first || first.cellFormatter || !isLinkableCellType(first.attribute?.type)) {
    return { displayedHeaders, layout };
  }

  return {
    layout,
    displayedHeaders: [
      {
        ...first,
        // Returning an element (not calling hooks here) matters: cellFormatter is
        // invoked inline in the row loop, so useHref must live one component down.
        cellFormatter: (row: any, header: any, meta: any) => (
          <EntryLinkCell
            collectionType={meta?.collectionType}
            model={meta?.model}
            documentId={row?.documentId}
            // Same lookup Strapi's own CellContent does: the header name is
            // suffixed with `.mainField` before it reaches us.
            content={row?.[String(header?.name ?? '').split('.')[0]]}
            withTooltip={header?.attribute?.type === 'string'}
          />
        ),
      },
      ...rest,
    ],
  };
};

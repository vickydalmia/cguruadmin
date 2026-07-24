import { Tooltip, Typography } from '@strapi/design-system';
import * as React from 'react';
import { useHref, useLocation } from 'react-router-dom';
import styled from 'styled-components';

import { buildEntryEditPath } from '../utils/entry-link';

type EntryLinkCellProps = {
  collectionType: string;
  model: string;
  documentId: unknown;
  content: unknown;
  /** `string` cells get a tooltip upstream; the other text types do not. */
  withTooltip: boolean;
};

/**
 * Inherit everything from the surrounding cell: this must be indistinguishable
 * from Strapi's plain-text cell, it is only an anchor so that middle-click,
 * Cmd-click and "Open in New Tab" have something real to act on.
 */
const CellLink = styled.a`
  display: block;
  min-width: 0;
  color: inherit;
  text-decoration: inherit;

  &:hover,
  &:focus,
  &:active {
    color: inherit;
    text-decoration: inherit;
  }
`;

const CellText = ({ content, withTooltip }: Pick<EntryLinkCellProps, 'content' | 'withTooltip'>) => {
  const label = String(content);
  // Mirrors CellContent/CellValue for the plain-text types: 30rem ellipsis in
  // neutral800, with a tooltip only on `string`.
  const text = (
    <Typography maxWidth="30rem" ellipsis textColor="neutral800">
      {label}
    </Typography>
  );

  return withTooltip ? <Tooltip label={label}>{text}</Tooltip> : text;
};

const EntryLinkCell = ({
  collectionType,
  model,
  documentId,
  content,
  withTooltip,
}: EntryLinkCellProps) => {
  const { search } = useLocation();
  const path = buildEntryEditPath(
    collectionType,
    model,
    documentId,
    search,
  );
  // `useHref` applies the router basename (built from process.env.ADMIN_PATH),
  // so this resolves correctly however the admin is mounted. It must run
  // unconditionally, hence the throwaway '.' when there is no path to build.
  const href = useHref(path ?? '.');

  // Strapi renders a dash for empty cells; leave that untouched rather than
  // turning a placeholder into a click target.
  if (content === null || content === undefined || content === '') {
    return <Typography textColor="neutral800">-</Typography>;
  }

  // No safe edit path (missing/unsafe documentId): the row still HAS content,
  // so show exactly what Strapi's default cell would have shown — plain text,
  // just not a link. Rendering "-" here would make a real value look empty.
  if (path === null) {
    return <CellText content={content} withTooltip={withTooltip} />;
  }

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Same modifier set react-router's own <Link> treats as "let the browser
    // have it", so this cell behaves like every other link in the admin. These
    // clicks are the entire point of the anchor: allow the native new
    // tab/window, and stop the event before Table.Row's onClick ALSO navigates
    // the current tab (which would hijack the tab you meant to keep).
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      event.stopPropagation();
      return;
    }

    // Plain left-click must feel exactly as it did before, i.e. a client-side
    // navigation rather than a full page load. Suppressing only the anchor's
    // default still lets the event bubble to Table.Row, which calls navigate().
    event.preventDefault();
  };

  return (
    <CellLink
      href={href}
      onClick={handleClick}
      // Middle-click dispatches `auxclick`, not `click`, so Table.Row's handler
      // does not fire for it today — stop it anyway so the row cannot start
      // double-opening if Strapi ever widens that listener.
      onAuxClick={(event: React.MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
    >
      <CellText content={content} withTooltip={withTooltip} />
    </CellLink>
  );
};

export default EntryLinkCell;

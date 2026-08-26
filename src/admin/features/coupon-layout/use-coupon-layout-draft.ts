import { useFetchClient } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  ORDERED_MAX,
  TOP_PICK_DISPLAYED,
  TOP_PICK_MAX,
  type CouponLayoutConfig,
} from './config';
import { toCandidate } from './coupon-layout';
import {
  useLocalRelationSelection,
  type RelationSelection,
} from './use-relation-selection';
import type { EntityCouponLayout } from './use-entity-coupon-layout';

/**
 * Draft, version-adoption, conflict-repair and save handling for the Coupon
 * layout dialog — everything except presentation, moved verbatim out of
 * components/coupon-layout-dialog.tsx so the modal is pure composition.
 */
export function useCouponLayoutDraft({
  config,
  documentId,
  layout,
  onOpenChange,
  onSaved,
  onReloadRequested,
  onDropped,
}: {
  config: CouponLayoutConfig;
  documentId?: string;
  layout: EntityCouponLayout;
  onOpenChange: (open: boolean) => void;
  onSaved: (layout: EntityCouponLayout) => void;
  onReloadRequested: () => void;
  onDropped: (message: string) => void;
}): {
  topPicks: RelationSelection;
  ordered: RelationSelection;
  edited: boolean;
  saving: boolean;
  saveError: string | null;
  autoRemoved: string[];
  unresolvedConflicts: string[];
  shownTopPickIds: ReadonlySet<string>;
  save: () => Promise<void>;
  requestClose: (nextOpen: boolean) => void;
} {
  const { put } = useFetchClient();
  const topPicks = useLocalRelationSelection(
    layout.topPickCoupons,
    TOP_PICK_MAX,
  );
  const ordered = useLocalRelationSelection(
    layout.orderedCoupons,
    ORDERED_MAX,
  );
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Adopt the server's state whenever its version moves while this dialog is
  // open — which is exactly what a 409 recovery does.
  //
  // useLocalRelationSelection seeds from `initial` only on mount, and the
  // panel renders this dialog without a key, so a refetch swapped in the
  // winner's `layout.version` while the visible selections stayed the losing
  // draft. The next save then matched on version and SILENTLY overwrote the
  // other editor's layout — strictly worse than the 409 loop it replaced.
  // Discarding the draft is the point: the editor is told to reapply.
  const appliedVersionRef = React.useRef(layout.version);
  React.useEffect(() => {
    if (appliedVersionRef.current === layout.version) return;
    appliedVersionRef.current = layout.version;
    topPicks.reset(layout.topPickCoupons);
    ordered.reset(layout.orderedCoupons);
  }, [
    layout.version,
    layout.topPickCoupons,
    layout.orderedCoupons,
    topPicks.reset,
    ordered.reset,
  ]);

  // Only the DISPLAYED Top Picks are barred from Ordered Coupons. Positions
  // 3-4 are expiry buffers the page never renders, so ordering them in the
  // main list meanwhile is exactly what they are for.
  const shownTopPickIds = React.useMemo(
    () =>
      new Set(
        topPicks.selected
          .slice(0, TOP_PICK_DISPLAYED)
          .map((item) => item.documentId),
      ),
    [topPicks.selected],
  );
  const orderedIds = React.useMemo(
    () => new Set(ordered.selected.map((item) => item.documentId)),
    [ordered.selected],
  );

  // A Coupon sitting in a SHOWN Top Pick slot and in Ordered Coupons at once.
  // Reachable by dragging a buffer upward, or by an ordered Coupon being
  // picked into the first two slots.
  const conflicting = React.useMemo(
    () =>
      topPicks.selected
        .slice(0, TOP_PICK_DISPLAYED)
        .filter((item) => orderedIds.has(item.documentId)),
    [topPicks.selected, orderedIds],
  );

  // Resolve it HERE, in the same edit, rather than leaving it for the cron.
  // The cron cannot see the intended order of a relation patch, but this
  // dialog owns that order, so it can drop the Coupon out of Ordered Coupons
  // immediately — the editor watches it happen instead of finding it changed
  // five minutes later. The cron stays as the backstop for writes that do not
  // come through here.
  const [autoRemoved, setAutoRemoved] = React.useState<string[]>([]);
  const edited = topPicks.dirty || ordered.dirty;
  const requestClose = React.useCallback(
    (nextOpen: boolean) => {
      if (
        !nextOpen &&
        edited &&
        !globalThis.confirm('Discard unsaved Coupon layout changes?')
      ) {
        return;
      }
      onOpenChange(nextOpen);
    },
    [edited, onOpenChange],
  );

  const save = React.useCallback(async () => {
    if (!documentId || !edited || saving) return;
    setSaving(true);
    setSaveError(null);
    // ONLY the request belongs in the try. Mapping the response, notifying the
    // parent and closing all used to sit here too, so a throw in any of them
    // reported "could not be saved" for a write that had already committed —
    // and the retry then conflicted forever against the bumped version.
    let response: any;
    try {
      response = await put(
        `/entity-coupon-layout/${config.kind}/${encodeURIComponent(documentId)}`,
        {
          data: {
            version: layout.version,
            topPickCouponIds: topPicks.selected.map(
              (coupon) => coupon.documentId,
            ),
            orderedCouponIds: ordered.selected.map(
              (coupon) => coupon.documentId,
            ),
          },
        },
      );
    } catch (error: any) {
      // The HTTP status lives on the error itself. `error.response` is
      // `{ data }` only, so the old `error.response.status` was always
      // undefined and this branch never ran.
      if (Number(error?.status) === 409) {
        // Refetch so the editor is working from the winning version. Telling
        // them to close and reopen did nothing: reopening reuses the same
        // loaded layout and re-sends the same stale version forever.
        onReloadRequested();
        setSaveError(
          'Another editor changed this layout. It has been reloaded with their version — reapply your changes and save again.',
        );
      } else {
        setSaveError(
          error?.response?.data?.error?.message ??
            'Coupon layout could not be saved. Your draft is still open.',
        );
      }
      setSaving(false);
      return;
    }
    setSaving(false);

    const body = response?.data?.data ?? response?.data;
    // toCandidate, not a hand-rolled spread: it is what derives `offerType`
    // and `detailed` from the same server projection the GET path uses.
    // Without them every saved row rendered "NO CODE" and lost its expiry
    // label until the page was reloaded.
    const saved: EntityCouponLayout = {
      ...body,
      topPickCoupons: (body?.topPickCoupons ?? []).map(toCandidate),
      orderedCoupons: (body?.orderedCoupons ?? []).map(toCandidate),
    };
    // The backend self-heals saved picks that are no longer live. Say so
    // rather than leaving the editor with a layout they did not submit.
    const dropped: any[] = Array.isArray(body?.dropped) ? body.dropped : [];
    if (dropped.length > 0) {
      const names = dropped
        .map((entry) => entry?.title)
        .filter(Boolean)
        .join(', ');
      onDropped(
        dropped.length === 1
          ? `1 Coupon was removed because it is no longer live${names ? `: ${names}` : ''}.`
          : `${dropped.length} Coupons were removed because they are no longer live${names ? `: ${names}` : ''}.`,
      );
    }
    onSaved(saved);
    onOpenChange(false);
  }, [
    config.kind,
    documentId,
    edited,
    layout.version,
    onOpenChange,
    onSaved,
    ordered.selected,
    put,
    saving,
    topPicks.selected,
  ]);

  React.useEffect(() => {
    // While either list is loading its selection is empty, which would read as
    // "no conflict" and, worse, could remove against a half-known state.
    if (topPicks.loading || ordered.loading) return;
    // ONLY repair a conflict the editor just created. The cron can leave this
    // state behind legitimately (it promotes a buffer into a displayed slot),
    // and acting on merely opening the dialog would queue a disconnect and
    // mark the entry dirty for someone who came to look — "Done" would not
    // undo it, and a later save for an unrelated field would persist an
    // ordering change they never made. Pre-existing conflicts are the cron's.
    if (!edited) return;
    if (conflicting.length === 0) return;

    ordered.removeMany(conflicting.map((item) => item.documentId));
    setAutoRemoved((current) => [
      ...new Set([...current, ...conflicting.map((item) => item.name)]),
    ]);
    // Removing empties `conflicting`, so the next pass returns early — this
    // converges rather than looping.
  }, [
    conflicting,
    edited,
    ordered.removeMany,
    ordered.loading,
    topPicks.loading,
  ]);

  // Left behind by the cron's buffer promotion, or a direct API write. Not
  // touched automatically — only described, with the fix one click away.
  const unresolvedConflicts = React.useMemo(
    () => (edited ? [] : conflicting.map((item) => item.name)),
    [edited, conflicting],
  );

  return {
    topPicks,
    ordered,
    edited,
    saving,
    saveError,
    autoRemoved,
    unresolvedConflicts,
    shownTopPickIds,
    save,
    requestClose,
  };
}

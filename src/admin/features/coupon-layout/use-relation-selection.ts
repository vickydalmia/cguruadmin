import { useFetchClient, useForm } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  mergeDescendingRelationPage,
  orderedRelationCommands,
  removalNeedsDisconnect,
} from '../../utils/ordered-relation';
import { toCandidate, type CouponCandidate } from './coupon-layout';

/**
 * Ordered-relation editing against the Content Manager form.
 *
 * The save mechanics here are load-bearing and were arrived at by fixing real
 * bugs — see utils/ordered-relation.ts:
 *
 * - Commands are ALWAYS rebuilt from the complete final selection. Reusing a
 *   command from an earlier order can leave a `before` anchor pointing at a
 *   Coupon that is no longer selected.
 * - `mergeDescendingRelationPage` reverses each page from the relations
 *   endpoint, which returns ordered relations newest-position first. Without
 *   it, an innocuous reopen-and-save silently reverses the selection.
 * - A removal only needs a `disconnect` when the Coupon is actually persisted;
 *   one added and removed within the same session was never connected.
 *
 * Both relations are ordered: `orderedCoupons` sets the main-list head, and the
 * first two `topPickCoupons` render in exact CMS order.
 *
 * This hook holds the selection itself and treats the form as write-mostly. It
 * re-reads the form only when the value arrives as an ARRAY, which is how the
 * Content Manager delivers a load or a discard — the object form is just our
 * own connect/disconnect payload echoing back, and replaying that would be
 * ambiguous (the command array is deliberately reversed, and carries apiData
 * rather than Coupon fields). Nothing else writes these two relations: their
 * raw inputs are hidden from the edit form by HIDE_FROM_EDIT in src/index.ts.
 */

type RelationFormValue = { connect?: any[]; disconnect?: any[] };

function isRelationCommandValue(value: unknown): value is RelationFormValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relationDocumentId(relation: any): string | undefined {
  return relation?.documentId ?? relation?.apiData?.documentId;
}

export type RelationSelection = {
  selected: CouponCandidate[];
  /** Persisted order still loading — show a loader, not an empty list. */
  loading: boolean;
  /**
   * True once the editor has changed this selection in this session. Lets
   * callers distinguish state the editor just created from state they merely
   * opened and looked at.
   */
  dirty: boolean;
  add: (candidate: CouponCandidate) => void;
  remove: (documentId: string) => void;
  /** Batch removal — one commit, so no removal is lost to a stale closure. */
  removeMany: (documentIds: readonly string[]) => void;
  move: (fromIndex: number, toIndex: number) => void;
  moveByDocumentId: (draggedId: string, targetId: string) => void;
};

export function useRelationSelection(
  field: string,
  model: string,
  documentId: string | undefined,
  maxSelections: number,
  active: boolean,
): RelationSelection {
  const { get } = useFetchClient();
  const formValue = useForm(
    `CouponLayout:${field}`,
    (state: any) => state.values?.[field],
  );
  const onChangeForm = useForm(
    `CouponLayout:${field}`,
    (state: any) => state.onChange,
  );

  const [selected, setSelected] = React.useState<CouponCandidate[]>([]);
  const [loading, setLoading] = React.useState(Boolean(documentId));
  const [dirty, setDirty] = React.useState(false);
  // null until the persisted set is known. A new (unsaved) entry has none.
  const persistedIdsRef = React.useRef<Set<string> | null>(
    documentId ? null : new Set(),
  );
  // Set once the editor touches this relation, so an in-flight load cannot
  // overwrite their edit.
  const dirtyRef = React.useRef(false);
  // Coupons added during this session. Used to decide whether a removal needs
  // a `disconnect` while the persisted set is still unknown — one added and
  // removed here was never in the database.
  const sessionAddedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    persistedIdsRef.current = documentId ? null : new Set();
    dirtyRef.current = false;
    setDirty(false);
    sessionAddedRef.current = new Set();
  }, [documentId, field]);

  // Array form = the Content Manager loaded the document, or the editor
  // discarded their changes. Either way it is authoritative.
  React.useEffect(() => {
    if (!Array.isArray(formValue)) return;
    // Replace—not merely initialise—the baseline. Content Manager rehydrates
    // an authoritative array after every successful save. Keeping the
    // original snapshot makes a Coupon added by that save look session-new
    // forever, so removing it in the next edit emits no disconnect.
    persistedIdsRef.current = new Set(
      formValue
        .map((value: any) => value?.documentId)
        .filter((value): value is string => typeof value === 'string'),
    );
    dirtyRef.current = false;
    setDirty(false);
    // The persisted baseline just changed, so nothing is session-new anymore.
    sessionAddedRef.current = new Set();
    setSelected(formValue.map(toCandidate));
  }, [formValue]);

  // Load the persisted order. The relations endpoint pages newest-position
  // first, so every page is reversed and prepended.
  React.useEffect(() => {
    if (!active || !documentId) return;
    let cancelled = false;

    const run = async () => {
      try {
        const all: CouponCandidate[] = [];
        for (let page = 1; page <= 50; page++) {
          const res = await get(
            `/content-manager/relations/${model}/${documentId}/${field}?page=${page}&pageSize=100`,
          );
          const body = res?.data?.data ?? res?.data;
          const results: any[] = body?.results ?? [];
          const merged = mergeDescendingRelationPage(
            all,
            results.map(toCandidate),
          );
          all.splice(0, all.length, ...merged);
          const pageCount = body?.pagination?.pageCount ?? 1;
          if (page >= pageCount || results.length === 0) break;
        }
        if (cancelled) return;

        persistedIdsRef.current = new Set(all.map((item) => item.documentId));
        setSelected((current) => {
          if (!dirtyRef.current) return all;
          // An edit raced the load. Discarding `all` here left the editor
          // holding only what they just added: the count read 1 instead of 9,
          // so they could blow past the maximum and have the whole save
          // rejected, and the next commit rebuilt `connect` from that partial
          // list. Keep the edit AND restore what it never got to see.
          //
          // Persisted entries lead, in their persisted order — they hold
          // positions 1..N — and anything genuinely new appends, which is
          // where `{ end: true }` already placed it.
          const persisted = new Set(all.map((item) => item.documentId));
          return [
            ...all,
            ...current.filter((item) => !persisted.has(item.documentId)),
          ];
        });
      } catch (err) {
        console.error(`[coupon-layout] Failed to load ${field}`, err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [active, documentId, model, field, get]);

  const commit = React.useCallback(
    (next: CouponCandidate[], removed: readonly CouponCandidate[] = []) => {
      dirtyRef.current = true;
      setDirty(true);
      setSelected(next);

      const current = isRelationCommandValue(formValue) ? formValue : {};
      const carried = (current.disconnect ?? []).filter((relation) => {
        const id = relationDocumentId(relation);
        // Drop stale disconnects for Coupons that are selected again.
        return id && !next.some((item) => item.documentId === id);
      });

      // Relations are patched, not replaced: leaving a Coupon out of `connect`
      // does NOT remove it, only `disconnect` does. When the persisted set is
      // not known yet, assume the Coupon IS in the database unless this
      // session added it — a redundant disconnect is harmless, a missing one
      // silently leaves the Coupon attached.
      const added = removed.filter(
        (candidate) =>
          removalNeedsDisconnect(
            persistedIdsRef.current,
            candidate.documentId,
            sessionAddedRef.current.has(candidate.documentId),
          ) &&
          !carried.some(
            (relation) => relationDocumentId(relation) === candidate.documentId,
          ),
      );

      onChangeForm(field, {
        // Rebuilt from the complete final selection, every time.
        connect: orderedRelationCommands(next),
        disconnect: [
          ...carried,
          ...added.map((candidate) => ({
            id: candidate.id,
            documentId: candidate.documentId,
            apiData: {
              id: candidate.id,
              documentId: candidate.documentId,
              locale: null,
            },
          })),
        ],
      });
    },
    [field, formValue, onChangeForm],
  );

  const add = React.useCallback(
    (candidate: CouponCandidate) => {
      if (selected.some((item) => item.documentId === candidate.documentId)) return;
      if (selected.length >= maxSelections) return;
      // Only claim it is new when we can actually confirm that. While the
      // persisted set is unknown, staying silent makes a later removal emit a
      // disconnect, which is the safe direction.
      if (persistedIdsRef.current?.has(candidate.documentId) === false) {
        sessionAddedRef.current.add(candidate.documentId);
      }
      commit([...selected, candidate]);
    },
    [commit, maxSelections, selected],
  );

  const removeMany = React.useCallback(
    (targetIds: readonly string[]) => {
      const targets = new Set(targetIds);
      const removed = selected.filter((item) => targets.has(item.documentId));
      if (removed.length === 0) return;
      // One commit for the whole batch. Calling `remove` in a loop would
      // compute every call from the same stale `selected` and keep only the
      // last removal.
      commit(
        selected.filter((item) => !targets.has(item.documentId)),
        removed,
      );
    },
    [commit, selected],
  );

  const remove = React.useCallback(
    (targetId: string) => removeMany([targetId]),
    [removeMany],
  );

  const move = React.useCallback(
    (fromIndex: number, toIndex: number) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= selected.length ||
        toIndex >= selected.length
      ) {
        return;
      }
      const next = [...selected];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return;
      next.splice(toIndex, 0, moved);
      commit(next);
    },
    [commit, selected],
  );

  const moveByDocumentId = React.useCallback(
    (draggedId: string, targetId: string) => {
      move(
        selected.findIndex((item) => item.documentId === draggedId),
        selected.findIndex((item) => item.documentId === targetId),
      );
    },
    [move, selected],
  );

  return {
    selected,
    loading,
    dirty,
    add,
    remove,
    removeMany,
    move,
    moveByDocumentId,
  };
}

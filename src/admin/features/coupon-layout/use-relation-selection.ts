import * as React from 'react';

import { type CouponCandidate } from './coupon-layout';

/**
 * Dialog-local ordered-selection draft for the atomic layout API.
 *
 * Mounting the dialog creates a draft; closing it discards the hook with no
 * Content Manager form mutations to leak into a later entity save. The
 * Content Manager-backed variant that once lived beside this hook
 * (useRelationSelection) was removed after the atomic layout API replaced
 * form-relation editing — the dialog draft is the only selection state left.
 */

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
  /**
   * Replace the draft wholesale. Used when the server state moves underneath
   * an open dialog — the draft was built against a version that no longer
   * exists, so keeping it would let the next save overwrite whoever won.
   */
  reset: (next: readonly CouponCandidate[]) => void;
};

/**
 * Dialog-owned selection used by the atomic layout API. Mounting the dialog
 * creates a draft; closing it discards the hook with no Content Manager form
 * mutations to leak into a later entity save.
 */
export function useLocalRelationSelection(
  initial: readonly CouponCandidate[],
  maxSelections: number,
): RelationSelection {
  const [selected, setSelected] = React.useState<CouponCandidate[]>(() => [
    ...initial,
  ]);

  // `dirty` is DERIVED, not stored. It used to be set from inside the
  // setSelected updater, which breaks React's rule that updaters are pure:
  // React may re-invoke one under StrictMode, or discard a concurrent render
  // entirely, and a discarded render would still have left `dirty` true for a
  // change that never landed. Comparing against the initial order also makes
  // it correct in a way a flag never was — undoing an edit now clears it.
  const initialKey = React.useMemo(
    () => initial.map((item) => item.documentId).join('\u0000'),
    [initial],
  );
  const dirty =
    selected.map((item) => item.documentId).join('\u0000') !== initialKey;
  const add = React.useCallback(
    (candidate: CouponCandidate) => {
      setSelected((current) => {
        if (
          current.length >= maxSelections ||
          current.some((item) => item.documentId === candidate.documentId)
        ) {
          return current;
        }
        return [...current, candidate];
      });
    },
    [maxSelections],
  );
  const removeMany = React.useCallback((ids: readonly string[]) => {
    const targets = new Set(ids);
    setSelected((current) => {
      return current.filter((item) => !targets.has(item.documentId));
    });
  }, []);
  const remove = React.useCallback(
    (id: string) => removeMany([id]),
    [removeMany],
  );
  const move = React.useCallback((fromIndex: number, toIndex: number) => {
    setSelected((current) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length
      ) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);
  const moveByDocumentId = React.useCallback(
    (draggedId: string, targetId: string) => {
      setSelected((current) => {
        const from = current.findIndex((item) => item.documentId === draggedId);
        const to = current.findIndex((item) => item.documentId === targetId);
        if (from < 0 || to < 0 || from === to) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [],
  );
  const reset = React.useCallback((next: readonly CouponCandidate[]) => {
    setSelected([...next]);
  }, []);

  return {
    selected,
    loading: false,
    dirty,
    add,
    remove,
    removeMany,
    move,
    moveByDocumentId,
    reset,
  };
}

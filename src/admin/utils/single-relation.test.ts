import { describe, expect, it } from 'vitest';

import {
  singleRelationChange,
  toRelationCommand,
  type RelationCandidate,
} from './single-relation';

const store = (id: number): RelationCandidate => ({
  id,
  documentId: `store-${id}`,
  name: `Store ${id}`,
});

const commandIds = (
  commands: { apiData: { documentId: string; isTemporary?: boolean } }[] = [],
) => commands.map((command) => command.apiData.documentId);

describe('single-relation command generation', () => {
  it('selects the first Store on create', () => {
    const first = store(1);
    const result = singleRelationChange({
      change: { type: 'select', candidate: first },
      selected: [],
      persistedDocumentIds: new Set(),
    });

    expect(result?.selected).toEqual([first]);
    expect(commandIds(result?.formValue.connect)).toEqual(['store-1']);
    expect(result?.formValue.connect?.[0]?.apiData.isTemporary).toBe(true);
    expect(result?.formValue.disconnect).toEqual([]);
  });

  it('replaces one persisted Store with another in one patch', () => {
    const first = store(1);
    const second = store(2);
    const result = singleRelationChange({
      change: { type: 'select', candidate: second },
      selected: [first],
      persistedDocumentIds: new Set(['store-1']),
    });

    expect(result?.selected).toEqual([second]);
    expect(commandIds(result?.formValue.connect)).toEqual(['store-2']);
    expect(commandIds(result?.formValue.disconnect)).toEqual(['store-1']);
  });

  it('reduces multiple legacy Stores to the selected Store', () => {
    const first = store(1);
    const second = store(2);
    const third = store(3);
    const result = singleRelationChange({
      change: { type: 'select', candidate: second },
      selected: [first, second, third],
      persistedDocumentIds: new Set(['store-1', 'store-2', 'store-3']),
    });

    expect(result?.selected).toEqual([second]);
    expect(result?.formValue.connect).toEqual([]);
    expect(commandIds(result?.formValue.disconnect)).toEqual([
      'store-1',
      'store-3',
    ]);
  });

  it('re-selects a pending-disconnected Store and drops stale commands', () => {
    const first = store(1);
    const second = store(2);
    const result = singleRelationChange({
      change: { type: 'select', candidate: first },
      selected: [second],
      persistedDocumentIds: new Set(['store-1', 'store-2']),
      formValue: {
        connect: [],
        disconnect: [toRelationCommand(first)],
      },
    });

    expect(result?.selected).toEqual([first]);
    expect(result?.formValue.connect).toEqual([]);
    expect(commandIds(result?.formValue.disconnect)).toEqual(['store-2']);
  });

  it('allows legacy cleanup only until one Store remains', () => {
    const first = store(1);
    const second = store(2);
    const cleanup = singleRelationChange({
      change: { type: 'remove', candidate: second },
      selected: [first, second],
      persistedDocumentIds: new Set(['store-1', 'store-2']),
    });

    expect(cleanup?.selected).toEqual([first]);
    expect(commandIds(cleanup?.formValue.disconnect)).toEqual(['store-2']);
    expect(
      singleRelationChange({
        change: { type: 'remove', candidate: first },
        selected: [first],
        persistedDocumentIds: new Set(['store-1']),
      }),
    ).toBeNull();
  });
});

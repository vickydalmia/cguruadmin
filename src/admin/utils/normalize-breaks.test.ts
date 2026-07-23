import { describe, expect, it } from 'vitest';

import {
  containsBreak,
  groupNodesByBreak,
  isMeaningfulBlock,
  normalizeBreaksToBlocks,
} from './normalize-breaks';

/**
 * The admin's vitest project runs in the `node` environment (vitest.config.ts:
 * `environment: 'node'`) and no DOM implementation is installed, so these tests
 * cover the pure helpers plus the parser-less guard paths of
 * `normalizeBreaksToBlocks`. The DOM walk itself is exercised in the browser by
 * the editor's load and paste paths.
 */

const node = (nodeName: string) => ({ nodeName });

describe('containsBreak', () => {
  it('detects breaks in any casing and with attributes', () => {
    expect(containsBreak('a<br>b')).toBe(true);
    expect(containsBreak('a<BR />b')).toBe(true);
    expect(containsBreak('a<br class="x">b')).toBe(true);
  });

  it('is false for empty input and for markup with no break', () => {
    expect(containsBreak('')).toBe(false);
    expect(containsBreak('<p>Plain paragraph</p>')).toBe(false);
  });

  it('does not mistake a word starting with "br" for a break', () => {
    expect(containsBreak('<p>brand new</p>')).toBe(false);
  });
});

describe('groupNodesByBreak', () => {
  it('splits children into one run per visual line', () => {
    const groups = groupNodesByBreak([
      node('#text'),
      node('STRONG'),
      node('BR'),
      node('#text'),
    ]);

    expect(groups.map((group) => group.map((item) => item.nodeName))).toEqual([
      ['#text', 'STRONG'],
      ['#text'],
    ]);
  });

  it('returns a single run when there is no break', () => {
    expect(groupNodesByBreak([node('#text')])).toHaveLength(1);
  });

  it('yields an empty run between consecutive breaks', () => {
    const groups = groupNodesByBreak([node('#text'), node('BR'), node('BR'), node('#text')]);

    expect(groups).toHaveLength(3);
    expect(groups[1]).toEqual([]);
  });
});

describe('isMeaningfulBlock', () => {
  it('keeps runs with text', () => {
    expect(isMeaningfulBlock('Free shipping', false)).toBe(true);
  });

  it('keeps an image-only run even though it has no text', () => {
    expect(isMeaningfulBlock('', true)).toBe(true);
  });

  it('drops whitespace-only and missing text with no image', () => {
    expect(isMeaningfulBlock('   ', false)).toBe(false);
    expect(isMeaningfulBlock(null, false)).toBe(false);
    expect(isMeaningfulBlock(undefined, false)).toBe(false);
  });
});

describe('normalizeBreaksToBlocks', () => {
  it('returns content without a break untouched, parser or not', () => {
    const html = '<p>One line only</p>';
    expect(normalizeBreaksToBlocks(html, null)).toBe(html);
  });

  it('returns the input unchanged when no DOM parser is available', () => {
    const html = '<p>First<br>Second</p>';
    expect(normalizeBreaksToBlocks(html, null)).toBe(html);
  });

  it('returns the input unchanged when the parser yields no document', () => {
    const html = '<p>First<br>Second</p>';
    expect(normalizeBreaksToBlocks(html, () => null)).toBe(html);
  });

  it('does not call the parser when there is nothing to split', () => {
    let calls = 0;
    const parser = () => {
      calls += 1;
      return null;
    };

    expect(normalizeBreaksToBlocks('<p>No breaks here</p>', parser)).toBe(
      '<p>No breaks here</p>'
    );
    expect(calls).toBe(0);
  });

  it('falls back to the browser parser lookup without throwing in node', () => {
    expect(normalizeBreaksToBlocks('<p>First<br>Second</p>')).toBe('<p>First<br>Second</p>');
  });
});

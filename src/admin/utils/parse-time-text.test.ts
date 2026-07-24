import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_SEPARATOR,
  isUnsafeTimeText,
  timeSeparatorsFor,
  toIsoStringOrNull,
  toSafeDate,
} from './parse-time-text';

/**
 * The oracle these tests are written against: a faithful copy of the
 * design-system TimePicker's blur parser (`b` at the `vf` binding in
 * @strapi/design-system/dist/index.mjs). `isUnsafeTimeText` must flag exactly
 * the inputs that make this throw — no more, no less.
 */
function designSystemParse(value: string, separator = ':'): string | undefined {
  const [hourPart, minutePart] = value.split(separator);
  if (!hourPart && !minutePart) return undefined;
  const hour = Number(hourPart ?? '0');
  const minute = Number(minutePart ?? '0');
  if (!(hour > 23 || minute > 59)) {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(0, 0, 0, hour, minute));
  }
  return undefined;
}

function designSystemThrows(value: string, separator = ':'): boolean {
  try {
    designSystemParse(value, separator);
    return false;
  } catch {
    return true;
  }
}

describe('isUnsafeTimeText — agrees with the real picker parser', () => {
  // Every one of these is reachable by typing: the picker's
  // isPrintableCharacter blocks letters but allows digits, ":", "-", "." and "+".
  const typeable = [
    '',
    ' ',
    '  ',
    ':',
    '::',
    '-',
    '--',
    '.',
    '+',
    '/',
    '7',
    '07',
    '23',
    '24',
    '99',
    '730',
    '7:',
    ':7',
    '7:0',
    '07:30',
    '23:59',
    '5:99',
    '99:99',
    '1-2',
    '1.2',
    '1.2.3',
    '5:-',
    '-:5',
    '5:.',
    '+:+',
    '1 2',
    ' 7 ',
  ];

  it.each(typeable)('matches the parser for %j', (value) => {
    expect(isUnsafeTimeText(value)).toBe(designSystemThrows(value));
  });
});

describe('isUnsafeTimeText — the crashing cases', () => {
  it('flags a lone dash, the reported repro', () => {
    expect(isUnsafeTimeText('-')).toBe(true);
    expect(designSystemThrows('-')).toBe(true);
  });

  it.each(['-', '.', '+', '--', '1-2', '1.2.3', '5:-', '-:5'])(
    'flags %j because Number() gives NaN and NaN passes both range guards',
    (value) => {
      expect(isUnsafeTimeText(value)).toBe(true);
    },
  );

  it('flags an infinite hour, which also builds an Invalid Date', () => {
    // Not typeable (letters are blocked) but reachable by paste.
    expect(isUnsafeTimeText('-Infinity')).toBe(true);
  });
});

describe('isUnsafeTimeText — must NOT over-reject', () => {
  it('leaves a bare number alone: the picker commits it as HH:00', () => {
    expect(isUnsafeTimeText('7')).toBe(false);
    expect(designSystemParse('7')).toBe('07:00');
  });

  it.each(['', ':', '::'])(
    'leaves %j alone — the picker bails out at its own empty guard',
    (value) => {
      expect(isUnsafeTimeText(value)).toBe(false);
    },
  );

  it.each(['24', '99', '730', '5:99', '99:99'])(
    'leaves out-of-range %j alone — the picker rejects it before formatting',
    (value) => {
      expect(isUnsafeTimeText(value)).toBe(false);
    },
  );

  it.each(['07:30', '23:59', '0:0'])('leaves valid %j alone', (value) => {
    expect(isUnsafeTimeText(value)).toBe(false);
  });

  it('treats whitespace as zero, exactly as Number() does', () => {
    expect(isUnsafeTimeText('  ')).toBe(false);
    expect(designSystemParse('  ')).toBe('00:00');
  });

  it('ignores non-string input rather than guessing', () => {
    expect(isUnsafeTimeText(null)).toBe(false);
    expect(isUnsafeTimeText(undefined)).toBe(false);
    expect(isUnsafeTimeText(7)).toBe(false);
  });
});

describe('isUnsafeTimeText — separator handling', () => {
  it('flags text that is unsafe under a "." separator locale', () => {
    // Under ":" this is the safe hour 1.2; under "." it splits to 1 and 2.
    expect(isUnsafeTimeText('1.2', [':'])).toBe(false);
    expect(isUnsafeTimeText('1.2', ['.'])).toBe(false);
    // "1.-" is safe read as one token under ".", unsafe read whole under ":".
    expect(isUnsafeTimeText('1.-', [':'])).toBe(true);
  });

  it('reports unsafe when ANY candidate separator is unsafe', () => {
    expect(isUnsafeTimeText('1.-', [':', '.'])).toBe(true);
  });

  it('falls back to safe when given no usable separator', () => {
    expect(isUnsafeTimeText('-', [])).toBe(false);
    expect(isUnsafeTimeText('-', [''])).toBe(false);
  });
});

describe('timeSeparatorsFor', () => {
  it('always offers the ":" default', () => {
    expect(timeSeparatorsFor('en-GB')).toContain(DEFAULT_TIME_SEPARATOR);
  });

  it('derives the locale separator the design system uses', () => {
    expect(timeSeparatorsFor('en-GB')).toEqual([':']);
  });

  it('survives an unsupported locale tag', () => {
    expect(timeSeparatorsFor('not-a-locale-!!')).toContain(':');
  });
});

describe('toSafeDate', () => {
  it('parses a stored ISO string', () => {
    expect(toSafeDate('2026-07-23T10:30:00.000Z')?.toISOString()).toBe(
      '2026-07-23T10:30:00.000Z',
    );
  });

  it('passes a valid Date through unchanged', () => {
    const date = new Date('2026-07-23T10:30:00.000Z');
    expect(toSafeDate(date)).toBe(date);
  });

  it('drops an Invalid Date instead of letting toISOString throw', () => {
    expect(toSafeDate(new Date('nonsense'))).toBeUndefined();
  });

  it.each(['', '   ', 'not a date', '2026-13-45T99:99:99Z'])(
    'drops unparseable %j',
    (value) => {
      expect(toSafeDate(value)).toBeUndefined();
    },
  );

  it.each([null, undefined, 0, 1_700_000_000_000, {}, []])(
    'drops non-string non-Date %j',
    (value) => {
      expect(toSafeDate(value)).toBeUndefined();
    },
  );
});

describe('toIsoStringOrNull', () => {
  it('round-trips a valid value', () => {
    expect(toIsoStringOrNull(new Date('2026-07-23T10:30:00.000Z'))).toBe(
      '2026-07-23T10:30:00.000Z',
    );
  });

  it.each([new Date('nonsense'), undefined, null, 'garbage'])(
    'returns null for %j rather than throwing RangeError',
    (value) => {
      expect(toIsoStringOrNull(value)).toBeNull();
    },
  );
});

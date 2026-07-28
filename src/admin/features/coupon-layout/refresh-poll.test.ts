import { describe, expect, it } from 'vitest';

import {
  isTerminalRefreshState,
  refreshPollDelayMs,
  REFRESH_POLL_MAX_ATTEMPTS,
  REFRESH_POLL_MAX_MS,
  TERMINAL_REFRESH_STATES,
} from './refresh-poll';

describe('refresh poll policy', () => {
  it('stops only on a genuinely final render outcome', () => {
    expect([...TERMINAL_REFRESH_STATES].sort()).toEqual(['failed', 'rendered']);
  });

  // Regression: `accepted` was briefly treated as terminal. The controller
  // sets it from `row.status === 'delivered'` and only ever upgrades it to
  // rendered/failed after probing the gateway, so it is the ordinary
  // "delivered, render in flight" state. Stopping there pinned the panel at
  // "Saved—refresh queued" and lost both the eventual success and failure.
  it.each(['accepted', 'queued', 'retrying'])(
    'keeps polling while the state is %s',
    (state) => {
      expect(isTerminalRefreshState(state)).toBe(false);
    },
  );

  it('treats an unknown or missing state as non-terminal', () => {
    expect(isTerminalRefreshState(undefined)).toBe(false);
    expect(isTerminalRefreshState('something-new')).toBe(false);
  });

  // Polling is bounded here, not by the terminal set — which is why
  // `accepted` does not need to be terminal to keep this finite.
  it('backs off linearly to a cap and terminates', () => {
    expect(refreshPollDelayMs(1)).toBe(2_000);
    expect(refreshPollDelayMs(3)).toBe(6_000);
    expect(refreshPollDelayMs(100)).toBe(REFRESH_POLL_MAX_MS);

    const total = Array.from({ length: REFRESH_POLL_MAX_ATTEMPTS }, (_, i) =>
      refreshPollDelayMs(i + 1),
    ).reduce((sum, delay) => sum + delay, 0);
    // A few minutes of watching, then it gives up rather than polling forever.
    expect(total).toBeLessThan(6 * 60_000);
  });
});

export type Poll = {
  /** Cancel the pending timer and stop the loop for good. */
  stop: () => void;
  /** Run the next tick now instead of waiting out the current delay.
   * Ignored while a tick is already in flight or after stop(). */
  kick: () => void;
};

/**
 * Self-rescheduling async poll loop — the cancel-flag / timer-handle /
 * reschedule-after-await pattern needed by both the record-lock heartbeat
 * (RecordLockPanel) and the coupon-layout refresh poll
 * (use-entity-coupon-layout), kept in ONE place so a cancellation-edge fix
 * reaches every caller.
 *
 * `tick` decides the cadence: it returns the delay in ms before the next
 * tick, or null to end the loop. It receives `alive()` to check between an
 * await and a state write whether the loop was stopped mid-flight. Retryable
 * errors are the tick's own business (catch and return a delay); an
 * exception that escapes it ends the loop.
 */
export function startPoll(
  tick: (alive: () => boolean) => Promise<number | null>,
): Poll {
  let running = true;
  let ticking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => running;

  const loop = async () => {
    if (!running || ticking) return;
    ticking = true;
    let delay: number | null = null;
    try {
      delay = await tick(alive);
    } catch {
      delay = null;
    }
    ticking = false;
    if (!running || delay === null) return;
    timer = setTimeout(() => void loop(), delay);
  };

  void loop();

  return {
    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
    },
    kick() {
      if (!running || ticking) return;
      if (timer !== undefined) clearTimeout(timer);
      void loop();
    },
  };
}

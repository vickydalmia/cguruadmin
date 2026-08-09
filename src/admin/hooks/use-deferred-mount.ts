import * as React from 'react';

/** Wait for the edit view to settle before firing secondary requests. */
export function useDeferredMount(): boolean {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const w = window as any;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(id);
  }, []);

  return ready;
}

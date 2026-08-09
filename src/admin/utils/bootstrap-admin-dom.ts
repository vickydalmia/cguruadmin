// Runs once per page load: the observer and the capture listener below are
// never torn down, so a second call (Vite HMR re-running app.tsx bootstrap, a
// test importing this directly) would stack duplicates — the guard makes the
// function idempotent instead.
let bootstrapped = false;

export function bootstrapAdminDom(): void {
  if (typeof document === 'undefined') return;
  if (bootstrapped) return;
  bootstrapped = true;

  const rewrite = () => {
    if (document.title.includes('Strapi')) {
      document.title = document.title.replace(/Strapi/g, 'CouponzGuru');
    }
  };
  rewrite();
  const titleElement = document.querySelector('title');
  if (titleElement) {
    new MutationObserver(rewrite).observe(titleElement, { childList: true });
  }

  // Swallow Enter in content-manager text inputs: Strapi's edit form submits
  // (and publishes) on Enter, which editors hit constantly while pasting.
  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (!window.location.pathname.includes('/content-manager/')) return;
      const element = event.target as HTMLElement | null;
      if (!element || element.tagName !== 'INPUT') return;
      const input = element as HTMLInputElement;
      if (input.getAttribute('role') === 'combobox') return;
      if (input.getAttribute('aria-autocomplete')) return;
      // The list view's search box lives in form[role="search"], where Enter
      // legitimately submits the search — leave it alone.
      if (input.closest('form[role="search"]')) return;
      const type = (input.type || 'text').toLowerCase();
      if (
        ['text', 'search', 'url', 'email', 'tel', 'number', 'password'].includes(
          type,
        )
      ) {
        event.preventDefault();
      }
    },
    true,
  );
}

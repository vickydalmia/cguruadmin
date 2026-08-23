/**
 * Global DOM behaviours installed once from app.tsx bootstrap. These register
 * document-level listeners that are never torn down, so they must be CALLED
 * from bootstrap (which runs exactly once) — never run as import side effects.
 */

export function installTitleRewrite(): void {
  if (typeof document === 'undefined') return;
  const rewrite = () => {
    if (document.title.includes('Strapi')) {
      document.title = document.title.replace(/Strapi/g, 'CouponzGuru');
    }
  };
  rewrite();
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(rewrite).observe(titleEl, { childList: true });
  }
}

// QC bug: pressing Enter while typing a store/brand name submitted the
// edit form and created the entry. Swallow Enter on single-line text
// inputs inside the content-manager edit view so it never auto-submits.
// Textareas, the rich-text editor (contenteditable), and comboboxes
// (which use Enter to pick an option) are left untouched.
export function installEnterKeyGuard(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (!window.location.pathname.includes('/content-manager/')) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.tagName !== 'INPUT') return;
      const input = el as HTMLInputElement;
      if (input.getAttribute('role') === 'combobox') return;
      if (input.getAttribute('aria-autocomplete')) return;
      // The list-view search bar (and the relation-picker search) submit on
      // Enter to apply the query — they live inside <form role="search">.
      // Swallowing Enter there silently breaks search on EVERY content type
      // (Strapi's SearchInput has no submit button; Enter is the only trigger).
      if (input.closest('form[role="search"]')) return;
      const type = (input.type || 'text').toLowerCase();
      if (['text', 'search', 'url', 'email', 'tel', 'number', 'password'].includes(type)) {
        e.preventDefault();
      }
    },
    true
  );
}

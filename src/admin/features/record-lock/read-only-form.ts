// Read-only form handling: until this exact tab owns the lock, freeze the
// complete Content Manager edit form (header actions, fields and side panels).
// The form lives inside <main>; both navigation sidebars live outside it and
// remain interactive. The scoped lock overlay is portalled outside the inert
// form, so its escape/takeover controls also remain available.
import * as React from 'react';

/** The CM edit form. `:not([role="search"])` keeps header search out. */
const findEditForm = (): HTMLFormElement | null =>
  document.querySelector<HTMLFormElement>('main form:not([role="search"])');

export function useReadOnlyEditForm(readOnly: boolean): void {
  React.useEffect(() => {
    if (!readOnly) return undefined;

    const freeze = () => {
      const form = findEditForm();
      if (form && !form.hasAttribute('inert')) {
        form.setAttribute('inert', '');
        form.style.opacity = '0.5';
      }
    };
    freeze();

    const observer = new MutationObserver(freeze);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      const form = findEditForm();
      if (form) {
        form.removeAttribute('inert');
        form.style.opacity = '';
      }
    };
  }, [readOnly]);
}

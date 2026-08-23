// Read-only form handling: until this exact tab owns the lock, grey out and
// freeze the CM edit form. `inert` removes the whole subtree from clicking,
// typing and tab order — a true read-only view. This closes the pre-acquire
// window where a duplicate same-user tab could submit before the modal
// appeared. Strapi re-renders can swap the form node out from under us, so a
// MutationObserver re-applies the freeze until ownership is confirmed; it
// watches document.body (not <main>, which Strapi can also replace,
// orphaning the observer).
import * as React from 'react';

/** The CM edit form (fields + Save/Publish panel). `:not([role="search"])`
 * keeps any header search form out of the match. */
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

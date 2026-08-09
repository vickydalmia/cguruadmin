import * as React from 'react';
import {
  Combobox,
  ComboboxOption,
  Field,
  Flex,
  Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';

import {
  parseCheckoutMerchant,
  type CheckoutMerchantRef,
} from '../../../../constants/checkout-merchant';
import {
  getAffiliateState,
  subscribeAffiliateState,
} from '../../../utils/affiliate-state';
import {
  findMerchantByRef,
  searchMerchants,
  withAffiliateOptions,
  withSelectedOption,
  type MerchantOption,
} from '../api/merchant-options';

/**
 * The Checkout Merchant dropdown: ONE searchable list containing every Store
 * and every Brand, of which an offer picks exactly one.
 *
 * Registered as a Strapi custom field (see src/constants/checkout-merchant.ts
 * for why a custom field and not a relation), which is what lets it render in
 * the main edit form rather than a side panel.
 *
 * Props arrive from the content-manager's InputRenderer, which spreads the
 * layout's field props over `useField(name)` — so `value`, `error` and
 * `onChange` are the form's, and calling `onChange(name, value)` is the same
 * write path every stock input uses.
 */

type CheckoutMerchantInputProps = {
  name: string;
  value?: string | null;
  error?: string;
  onChange: (name: string, value: string | null) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  labelAction?: React.ReactNode;
  placeholder?: string;
};

const SEARCH_DEBOUNCE_MS = 250;

const CheckoutMerchantInput = React.forwardRef<
  HTMLInputElement,
  CheckoutMerchantInputProps
>(function CheckoutMerchantInput(props, forwardedRef) {
  const {
    name,
    value,
    error,
    onChange,
    label,
    hint,
    required,
    disabled,
    labelAction,
    placeholder,
  } = props;

  const { get } = useFetchClient();
  // Stable identity: both effects below take the client as a dependency, and a
  // fresh object each render would re-fetch the whole list every render.
  const client = React.useMemo(() => ({ get }), [get]);

  // Affiliate exclusivity: while the Taxonomies panel reports an affiliate
  // brand selected (or still unresolved), the merchant may not be edited —
  // an affiliate brand is the offer's only merchant. The panel publishes the
  // verdict through module state because it renders in a separate React tree
  // (src/admin/utils/affiliate-state.ts). The server validator remains the
  // guarantee; this is the matching UX.
  // KNOWN LIMITATION: this context resolves from URL params, so an offer
  // edited inside a relation MODAL reads the HOST page's state — Strapi 5.50
  // exports no modal-aware document context. The restriction below is UX
  // sugar either way; the server validator rejects any actually-invalid
  // merchant on save.
  const { model, id: entryDocumentId } = unstable_useContentManagerContext();
  const affiliateState = React.useSyncExternalStore(subscribeAffiliateState, () =>
    getAffiliateState(model, entryDocumentId),
  );
  const affiliateBlocked = affiliateState?.blocked === true;
  // While an affiliate brand is selected the server still accepts exactly two
  // edits — clearing the field, or pointing it at that brand — so RESTRICT
  // the options to the affiliate brand(s) instead of disabling the control
  // wholesale (which also killed onClear and made the validator's own fix
  // instruction unfollowable). Hard-disable only while the state is UNKNOWN
  // (blocked with no resolved refs yet).
  const affiliateBrandRefs = affiliateState?.brandRefs ?? [];
  const allowedAffiliateValues = React.useMemo(
    () =>
      new Set(affiliateBrandRefs.map((ref) => `brand:${ref.documentId}`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [affiliateState],
  );
  const affiliateRestricted =
    affiliateBlocked && allowedAffiliateValues.size > 0;
  const affiliateDisabled =
    affiliateBlocked && allowedAffiliateValues.size === 0;

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [textValue, setTextValue] = React.useState<string | undefined>(undefined);

  const [options, setOptions] = React.useState<MerchantOption[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const [selected, setSelected] = React.useState<MerchantOption | null>(null);
  // Distinguishes "still resolving the saved value" from "resolved, and the
  // target is gone". Only the second is worth shouting about.
  const [missingRef, setMissingRef] = React.useState<CheckoutMerchantRef | null>(
    null,
  );

  const ref = React.useMemo(() => parseCheckoutMerchant(value), [value]);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // A new query is a new list, not more of the old one.
  React.useEffect(() => {
    setPage(1);
    setOptions([]);
  }, [debouncedSearch]);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const result = await searchMerchants(client, debouncedSearch, page);
        if (cancelled) return;
        setOptions((previous) =>
          page === 1 ? result.options : [...previous, ...result.options],
        );
        setHasMore(result.hasMore);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [client, debouncedSearch, page]);

  // Resolve whatever is stored so the closed dropdown shows a NAME rather than
  // `store:xk3f…`. Runs on every value change, including right after a pick,
  // where the option is already in hand and no request is made.
  React.useEffect(() => {
    let cancelled = false;

    if (!ref) {
      setSelected(null);
      setMissingRef(null);
      return () => {
        cancelled = true;
      };
    }

    const known = options.find((option) => option.value === value);
    if (known) {
      setSelected(known);
      setMissingRef(null);
      return () => {
        cancelled = true;
      };
    }

    const run = async () => {
      const found = await findMerchantByRef(client, ref);
      if (cancelled) return;
      setSelected(found);
      setMissingRef(found ? null : ref);
    };
    run();

    return () => {
      cancelled = true;
    };
    // `options` is deliberately NOT a dependency: it changes on every keystroke
    // and re-running this on each one would fire a lookup per character. The
    // selected value only changes when `value` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref, value]);

  const visibleOptions = React.useMemo(() => {
    const merged = withSelectedOption(options, selected);
    if (!affiliateRestricted) return merged;
    // Keep the affiliate brand(s) pickable, plus the currently stored value
    // (never hide what the field holds — the editor must see what to clear).
    const restricted = merged.filter(
      (option) =>
        allowedAffiliateValues.has(option.value) || option.value === value,
    );
    // The brand is rarely on the current search page — inject the legal
    // pick(s) from the panel's resolved refs so the dropdown is never an
    // empty list under a hint that says the brand is allowed.
    return withAffiliateOptions(restricted, affiliateBrandRefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, selected, affiliateRestricted, allowedAffiliateValues, value]);

  const handleChange = (nextValue?: string) => {
    // The Combobox emits undefined when its value is cleared. Null (not '')
    // is what makes the column empty: Form's change handler maps '' to null
    // anyway, and null is what the server-side blank check reads as "unset".
    onChange(name, nextValue ?? null);
    setTextValue('');
  };

  return (
    <Field.Root name={name} id={name} error={error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <Combobox
        ref={forwardedRef}
        name={name}
        value={value ?? undefined}
        disabled={disabled || affiliateDisabled}
        required={required}
        hasError={Boolean(error)}
        placeholder={placeholder ?? 'Select a Store or Brand'}
        autocomplete={{ type: 'list', filter: 'contains' }}
        loading={loading}
        loadingMessage="Loading merchants"
        hasMoreItems={hasMore}
        onLoadMore={() => setPage((current) => current + 1)}
        noOptionsMessage={() => 'No Store or Brand matches that name'}
        textValue={textValue}
        onTextValueChange={setTextValue}
        onInputChange={(event) => setSearch(event.currentTarget.value)}
        onOpenChange={(open) => {
          if (!open) setSearch('');
        }}
        onChange={handleChange}
        onClear={() => handleChange(undefined)}
      >
        {visibleOptions.map((option) => (
          <ComboboxOption
            key={option.value}
            value={option.value}
            // Drives both the typed-text filter and the label shown once the
            // dropdown closes, so it must carry the qualifier: two entities
            // legitimately share a name ("Nike" the Store, "Nike" the Brand)
            // and a bare name would make the closed field ambiguous.
            textValue={`${option.name} (${option.kindLabel})`}
          >
            <Flex justifyContent="space-between" gap={2} width="100%">
              <Typography ellipsis>{option.name}</Typography>
              <Typography variant="pi" textColor="neutral600">
                {option.kindLabel}
              </Typography>
            </Flex>
          </ComboboxOption>
        ))}
      </Combobox>
      {missingRef ? (
        <Typography variant="pi" textColor="danger600" tag="p">
          The selected {missingRef.kind === 'store' ? 'Store' : 'Brand'} (
          {missingRef.documentId}) no longer exists. Pick another merchant, or
          clear the field — saving will be rejected until you do.
        </Typography>
      ) : null}
      {affiliateBlocked ? (
        <Typography variant="pi" textColor="warning600" tag="p">
          {affiliateRestricted && affiliateState
            ? `Affiliate brand ${affiliateState.brandNames.join(', ')} is this ` +
              `offer's merchant — the checkout merchant can only be that ` +
              `brand or empty. Remove the brand in the Taxonomies panel to ` +
              `pick anything else.`
            : 'Disabled while the selected brands are checked for affiliate status.'}
        </Typography>
      ) : null}
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
});

export default CheckoutMerchantInput;

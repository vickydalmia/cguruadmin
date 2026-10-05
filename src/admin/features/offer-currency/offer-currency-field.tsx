import { Combobox, ComboboxOption, Field } from '@strapi/design-system';
import { useField } from '@strapi/strapi/admin';
import { OFFER_CURRENCIES } from '../../../constants/offer-currencies';
import { numericOfferAmountInput } from '../../../utils/offer-currency';

const names = new Intl.DisplayNames(['en'], { type: 'currency' });
export function OfferCurrencyField({ includeDiscount }: { includeDiscount: boolean }) {
  const field = useField<string | null>('currencyCode');
  const amountMode = useField<boolean>('usesCurrencyAmounts');
  const cashback = useField<string>('cashbackText');
  const bank = useField<string>('bankOfferText');
  const prepaid = useField<string>('prepaidText');
  const discount = useField<string>('discount');
  const changeCurrency = (value: string | number | null | undefined) => {
    const next = value ? String(value) : null;
    const amounts = { cashbackText: cashback, bankOfferText: bank, prepaidText: prepaid,
      ...(includeDiscount ? { discount } : {}) };
    // Normalize currently typed amounts before changing their display currency.
    for (const [name, input] of Object.entries(amounts)) {
      const amount = numericOfferAmountInput(input.value ?? '', field.value);
      if (amount !== null && amount !== input.value) input.onChange(name, amount);
    }
    if (next || field.value) amountMode.onChange('usesCurrencyAmounts', true);
    field.onChange('currencyCode', next);
  };
  return (
    <Field.Root name="currencyCode" error={field.error}
      hint="Optional. Applies to automatic monetary amounts. Blank uses the site default. Amounts are not converted.">
      <Field.Label>Offer currency</Field.Label>
      <Combobox name="currencyCode" autocomplete={{ type: 'list', filter: 'contains' }} value={field.value || undefined} placeholder="Use site default" onClear={() => changeCurrency(null)}
        onChange={changeCurrency}>
        {OFFER_CURRENCIES.map(code => (
          <ComboboxOption key={code} value={code}>{code} — {names.of(code)}</ComboboxOption>
        ))}
      </Combobox>
      <Field.Hint /><Field.Error />
    </Field.Root>
  );
}

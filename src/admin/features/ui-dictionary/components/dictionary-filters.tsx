// Filter row: search (writes `_q` to the URL), namespace, status, and the
// "show removed keys" switch. Namespaces come from the loaded rows.
import * as React from 'react';
import { Checkbox, Flex, SingleSelect, SingleSelectOption, Typography } from '@strapi/design-system';
import { SearchInput } from '@strapi/strapi/admin';

import { statusOptionsFor, type EntryFilters } from '../filter-entries';
import type { UiDictionaryQuery } from '../types';

export function DictionaryFilters({
  locale,
  filters,
  namespaces,
  setFilter,
}: {
  locale: string;
  filters: EntryFilters;
  namespaces: string[];
  setFilter: (next: Partial<Pick<UiDictionaryQuery, 'status' | 'namespace' | 'removed'>>) => void;
}) {
  return (
    <>
      <SearchInput label="Search UI text" placeholder="Search key, English or translation" />
      <SingleSelect
        aria-label="Namespace"
        placeholder="All namespaces"
        value={filters.namespace}
        onClear={() => setFilter({ namespace: '' })}
        onChange={(value: string | number) => setFilter({ namespace: String(value) })}
      >
        {namespaces.map((namespace) => (
          <SingleSelectOption key={namespace} value={namespace}>
            {namespace}
          </SingleSelectOption>
        ))}
      </SingleSelect>
      <SingleSelect
        aria-label="Status"
        placeholder="All statuses"
        value={filters.status}
        onClear={() => setFilter({ status: '' })}
        onChange={(value: string | number) => setFilter({ status: String(value) })}
      >
        {statusOptionsFor(locale).map((option) => (
          <SingleSelectOption key={option.value} value={option.value}>
            {option.label}
          </SingleSelectOption>
        ))}
      </SingleSelect>
      <Flex gap={2} alignItems="center">
        <Checkbox
          id="ui-dictionary-show-removed"
          aria-label="Show removed keys"
          checked={filters.showRemoved}
          onCheckedChange={(checked: boolean | 'indeterminate') =>
            setFilter({ removed: checked === true ? '1' : '' })
          }
        />
        <Typography tag="label" htmlFor="ui-dictionary-show-removed" variant="pi">
          Show removed keys
        </Typography>
      </Flex>
    </>
  );
}

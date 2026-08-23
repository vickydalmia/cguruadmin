// Filter row for the Deal-page SEO list: search plus the entity-type and
// index-state selects. Any filter change resets to page 1 via setFilter.
import * as React from 'react';
import {
  SingleSelect,
  SingleSelectOption,
} from '@strapi/design-system';
import { SearchInput } from '@strapi/strapi/admin';

import type { IdentityKind } from '../../../../utils/route-normalization';
import {
  ENTITY_KINDS,
  INDEX_STATES,
  INDEX_STATE_LABELS,
  type IndexState,
} from '../types';
import type { ListQueryParams } from '../seo-list-config';

export function SeoListFilters({
  kind,
  indexState,
  setFilter,
}: {
  kind: IdentityKind | '';
  indexState: IndexState | '';
  setFilter: (next: Partial<ListQueryParams>) => void;
}) {
  return (
    <>
              <SearchInput
                label="Search Deal pages"
                placeholder="Search name, slug or permalink"
              />
              <SingleSelect
                aria-label="Entity type"
                placeholder="All types"
                value={kind}
                onClear={() => setFilter({ kind: '' })}
                onChange={(value: string | number) =>
                  setFilter({ kind: String(value) })
                }
              >
                {ENTITY_KINDS.map((value) => (
                  <SingleSelectOption key={value} value={value}>
                    {value}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
              <SingleSelect
                aria-label="Index state"
                placeholder="All states"
                value={indexState}
                onClear={() => setFilter({ indexState: '' })}
                onChange={(value: string | number) =>
                  setFilter({ indexState: String(value) })
                }
              >
                {INDEX_STATES.map((value) => (
                  <SingleSelectOption key={value} value={value}>
                    {INDEX_STATE_LABELS[value]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
    </>
  );
}

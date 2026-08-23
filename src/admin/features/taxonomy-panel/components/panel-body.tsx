import * as React from 'react';
import { useForm } from '@strapi/strapi/admin';
import { Box, Divider } from '@strapi/design-system';

import {
  AFFILIATE_OFFER_TOGGLE_FIELD,
  isAffiliateOfferUid,
} from '../../../../constants/affiliate-offer';
import { useDeferredMount } from '../../../utils/use-deferred-mount';
import {
  AFFILIATE_BRAND_CANDIDATE_FILTER,
  RELATION_CONFIG,
  type SelectedRelationState,
} from '../config';
import { AffiliateOfferToggle } from './affiliate-offer-toggle';
import { RelationSection } from './relation-section';

export function PanelBody({
  model,
  documentId,
}: {
  model: string;
  documentId?: string;
}) {
  const deferred = useDeferredMount();
  const isAffiliateModel = isAffiliateOfferUid(model);
  const affiliateOn = useForm(
    'AffiliatePanelBody',
    (state) => state.values?.[AFFILIATE_OFFER_TOGGLE_FIELD] === true,
  );
  const [selectionState, setSelectionState] = React.useState<
    Record<string, SelectedRelationState>
  >({});
  const handleSelectedState = React.useCallback(
    (field: string, state: SelectedRelationState) => {
      setSelectionState((current) => {
        const existing = current[field];
        if (
          existing &&
          existing.count === state.count &&
          existing.ready === state.ready
        ) {
          return current;
        }
        return { ...current, [field]: state };
      });
    },
    [],
  );

  return (
    <Box width="100%">
      {isAffiliateModel ? (
        <>
          <AffiliateOfferToggle
            isOn={affiliateOn}
            selectionState={selectionState}
          />
          <Divider />
        </>
      ) : null}
      {RELATION_CONFIG[model].map((cfg, idx) => (
        <React.Fragment key={cfg.field}>
          {idx > 0 ? <Divider /> : null}
          <RelationSection
            config={cfg}
            deferred={deferred}
            model={model}
            documentId={documentId}
            selectionDisabled={
              isAffiliateModel && affiliateOn && cfg.field === 'stores'
            }
            selectionDisabledHint={
              cfg.field === 'stores'
                ? 'Stores are disabled for affiliate-brand offers.'
                : undefined
            }
            extraCandidateFilters={
              isAffiliateModel && affiliateOn && cfg.field === 'brands'
                ? AFFILIATE_BRAND_CANDIDATE_FILTER
                : undefined
            }
            onSelectedState={
              isAffiliateModel &&
              (cfg.field === 'stores' || cfg.field === 'brands')
                ? handleSelectedState
                : undefined
            }
          />
        </React.Fragment>
      ))}
    </Box>
  );
}

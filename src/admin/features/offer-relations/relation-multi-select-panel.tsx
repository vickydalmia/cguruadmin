import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { Box, Button, Divider, Flex, Typography } from '@strapi/design-system';
import * as React from 'react';

import { useDeferredMount } from '../../hooks/use-deferred-mount';
import { RELATION_CONFIG } from './config';
import { RelationSection } from './relation-section';
import { useAffiliateRelationContext } from './use-affiliate-relation-context';

function RelationPanelBody({
  model,
  documentId,
}: {
  model: string;
  documentId?: string;
}) {
  const deferred = useDeferredMount();
  const configs = RELATION_CONFIG[model];
  const affiliate = useAffiliateRelationContext({
    configs,
    model,
    documentId,
  });

  return (
    <Box width="100%">
      {affiliate.flagsRetryVisible ? (
        <Box
          hasRadius
          background="danger100"
          borderColor="danger200"
          padding={2}
          marginBottom={2}
        >
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography variant="pi" textColor="danger600">
              Could not check the selected brands for affiliate status. Store,
              brand and checkout-merchant changes stay disabled until this
              succeeds.
            </Typography>
            <Button
              variant="danger-light"
              size="S"
              onClick={affiliate.retryFlags}
            >
              Retry
            </Button>
          </Flex>
        </Box>
      ) : null}
      {configs.map((config, index) => (
        <React.Fragment key={config.field}>
          {index > 0 ? <Divider /> : null}
          <RelationSection
            config={config}
            deferred={deferred}
            model={model}
            documentId={documentId}
            affiliateContext={
              config.affiliateRule ? affiliate.affiliateContext : null
            }
            reportSelection={
              config.affiliateRule ? affiliate.reportSelection : undefined
            }
          />
        </React.Fragment>
      ))}
    </Box>
  );
}

export const RelationMultiSelectPanel: PanelComponent = ({
  model,
  documentId,
}) => {
  if (!RELATION_CONFIG[model]) return null;

  return {
    title: 'Taxonomies',
    content: <RelationPanelBody model={model} documentId={documentId} />,
  };
};

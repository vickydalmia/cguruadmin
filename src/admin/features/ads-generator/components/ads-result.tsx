import * as React from 'react';
import { Badge, Box, Button, Flex, Typography } from '@strapi/design-system';
import { Download } from '@strapi/icons';
import type { AdsGeneratorResult, GeneratedAd } from '../../../../constants/ads-generator';
import { downloadCsv } from '../api';

/** Review screen: warnings and manual steps first, then the copy, then the download. */
export function AdsResult({ result }: { result: AdsGeneratorResult }) {
  return (
    <Flex direction="column" alignItems="stretch" gap={5}>
      <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
        <Flex gap={2} wrap="wrap">
          <Badge>{result.adType === 'evergreen' ? 'Evergreen' : 'Offer-specific'}</Badge>
          <Badge>{result.model}</Badge>
          <Badge>{result.promptVersion}</Badge>
          <Badge>{result.cached ? 'cached result' : `${result.usage.calls} OpenAI call(s)`}</Badge>
          <Badge>{result.usage.inputTokens + result.usage.outputTokens} tokens</Badge>
        </Flex>
        <Button startIcon={<Download />} onClick={() => downloadCsv(result.csv)}>
          Download CSV ({result.csv.rows} rows)
        </Button>
      </Flex>

      <Notes title="Before you enable the campaign" items={result.manualSteps} />
      {result.warnings.length > 0 && <Notes title="Warnings" items={result.warnings} tone="warning600" />}

      <Box>
        <Typography variant="delta" tag="h3">Keywords (phrase match)</Typography>
        <Typography>{result.keywords.join(' · ')}</Typography>
      </Box>

      {result.ads.map((ad, index) => <AdCopy key={index} title={`Ad ${index + 1}`} ad={ad} />)}
    </Flex>
  );
}

function Notes({ title, items, tone = 'neutral800' }: { title: string; items: string[]; tone?: string }) {
  return (
    <Box>
      <Typography variant="delta" tag="h3">{title}</Typography>
      <ul>{items.map((item) => <li key={item}><Typography textColor={tone}>• {item}</Typography></li>)}</ul>
    </Box>
  );
}

function AdCopy({ title, ad }: { title: string; ad: GeneratedAd }) {
  return (
    <Box padding={4} background="neutral100" hasRadius>
      <Typography variant="delta" tag="h3">{title}</Typography>
      <CopyList label="Headlines (1 and 2 are pinned)" lines={ad.headlines} />
      <CopyList label="Descriptions (1 is pinned)" lines={ad.descriptions} />
    </Box>
  );
}

function CopyList({ label, lines }: { label: string; lines: string[] }) {
  return (
    <Box paddingTop={3}>
      <Typography variant="pi" textColor="neutral600">{label}</Typography>
      <ol>
        {lines.map((line, index) => (
          <li key={index}>
            <Typography>{index + 1}. {line} </Typography>
            <Typography variant="pi" textColor="neutral500">({[...line].length})</Typography>
          </li>
        ))}
      </ol>
    </Box>
  );
}

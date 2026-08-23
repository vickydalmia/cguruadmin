import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useForm } from '@strapi/strapi/admin';
import {
  Box,
  Button,
  Divider,
  Flex,
  Radio,
  Status,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';

import DateTimeInput from './DateTimeInput';
import { computeContentStatus } from '../../utils/content-status';
import { isOfferModel } from '../utils/offer-status-filter';
import {
  fieldWriteForEndMode,
  fieldWriteForStartMode,
  pendingDateFields,
  seedModes,
  STATUS_LABEL,
  STATUS_VARIANT,
  type EndMode,
  type StartMode,
} from '../utils/publishing-panel';

/**
 * "Publishing" side panel for Coupon and Product Deal — everything about WHEN
 * an offer is live, gathered under the Save button instead of scattered through
 * the main form.
 *
 * The four lifecycle fields are hidden from the main edit layout (see
 * HIDE_FROM_EDIT_FORM_ONLY in src/bootstrap/content-manager-layouts.ts) and
 * edited only here, the same way
 * RelationMultiSelectPanel owns the taxonomy relations. Writes go through the
 * shared form state, so nothing persists until the editor hits Save — no
 * separate request, and Cancel still discards.
 *
 * STATUS IS READ-ONLY ON PURPOSE. It is derived from the dates on the server
 * (src/utils/offer-lifecycle-validation.ts) and re-derived every 5 minutes by
 * the scheduler. An editable status control would let an editor assert
 * "Published" on an offer whose end date has passed, and the cron would flip it
 * back within minutes — so the panel shows what the dates mean and lets the
 * editor change the dates.
 */

function LabelledSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Typography variant="pi" fontWeight="bold" textColor="neutral800">
        {label}
      </Typography>
      {children}
    </Flex>
  );
}

function PublishingPanelBody({ documentId }: { documentId?: string }) {
  const values = useForm('PublishingPanel', (state) => state.values) as Record<
    string,
    unknown
  >;
  const onChange = useForm('PublishingPanel', (state) => state.onChange);

  const scheduledAt = values?.scheduledAt;
  const expiresAt = values?.expiresAt;
  const publishedOn = values?.publishedOn;

  // Seeded once per document, then editor-driven — see seedModes for why this
  // cannot re-derive from the values on every render.
  const [startMode, setStartMode] = React.useState<StartMode>(
    () => seedModes({ scheduledAt, expiresAt }).start,
  );
  const [endMode, setEndMode] = React.useState<EndMode>(
    () => seedModes({ scheduledAt, expiresAt }).end,
  );

  // Navigating between entries reuses this component, so re-seed when the
  // document changes or the panel would show the previous entry's shape.
  const seededFor = React.useRef(documentId);
  React.useEffect(() => {
    if (seededFor.current === documentId) return;
    seededFor.current = documentId;
    const seeded = seedModes({ scheduledAt, expiresAt });
    setStartMode(seeded.start);
    setEndMode(seeded.end);
    // Re-seeding is keyed on the document only: reacting to the dates as well
    // would re-run mid-edit and undo the editor's radio choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const status = computeContentStatus({
    scheduledAt: scheduledAt as string | null | undefined,
    expiresAt: expiresAt as string | null | undefined,
  });

  const pending = pendingDateFields(
    { start: startMode, end: endMode },
    { scheduledAt, expiresAt },
  );

  const chooseStart = (mode: StartMode) => {
    setStartMode(mode);
    const write = fieldWriteForStartMode(mode);
    if (write) onChange('scheduledAt', write.scheduledAt);
  };

  const chooseEnd = (mode: EndMode) => {
    setEndMode(mode);
    const write = fieldWriteForEndMode(mode);
    if (write) onChange('expiresAt', write.expiresAt);
  };

  return (
    <Flex direction="column" alignItems="stretch" gap={4} width="100%">
      <LabelledSection label="Status">
        <Box>
          <Status variant={STATUS_VARIANT[status]} size="S">
            <Typography fontWeight="bold">{STATUS_LABEL[status]}</Typography>
          </Status>
        </Box>
        <Typography variant="pi" textColor="neutral600">
          Set automatically from the dates below — not editable.
        </Typography>
      </LabelledSection>

      <Divider />

      <Flex direction="column" alignItems="stretch" gap={2}>
        <DateTimeInput
          name="publishedOn"
          label="Published date"
          hint="Orders the site's newest-first listings. Cannot be in the future."
        />
        <Box>
          <Button
            size="S"
            variant="tertiary"
            onClick={() => onChange('publishedOn', new Date().toISOString())}
          >
            Set to now (move to top)
          </Button>
        </Box>
      </Flex>

      <Divider />

      <LabelledSection label="Goes live">
        <Radio.Group
          value={startMode}
          onValueChange={(value: string) => chooseStart(value as StartMode)}
        >
          <Flex direction="column" alignItems="stretch" gap={2}>
            <Radio.Item value="now">Immediately</Radio.Item>
            <Radio.Item value="later">Schedule for later</Radio.Item>
          </Flex>
        </Radio.Group>
        {startMode === 'later' ? (
          <DateTimeInput
            name="scheduledAt"
            label="Goes live at"
            hint="Must be in the future, and before the end date."
          />
        ) : null}
      </LabelledSection>

      <Divider />

      <LabelledSection label="Ends">
        <Radio.Group
          value={endMode}
          onValueChange={(value: string) => chooseEnd(value as EndMode)}
        >
          <Flex direction="column" alignItems="stretch" gap={2}>
            <Radio.Item value="never">Never expires</Radio.Item>
            <Radio.Item value="date">On a date</Radio.Item>
          </Flex>
        </Radio.Group>
        {endMode === 'date' ? (
          <DateTimeInput
            name="expiresAt"
            label="Ends at"
            hint="Must be in the future. Clear it (or pick Never expires) to bring an expired offer back."
          />
        ) : null}
      </LabelledSection>

      {pending.length > 0 ? (
        <Typography variant="pi" textColor="danger600">
          {`Pick a date for ${pending.join(' and ')}, or switch back — the save will be rejected otherwise.`}
        </Typography>
      ) : null}
    </Flex>
  );
}

const PublishingPanel: PanelComponent = ({ model, documentId }) => {
  if (!isOfferModel(model)) return null;

  return {
    title: 'Publishing',
    content: <PublishingPanelBody documentId={documentId} />,
  };
};

export default PublishingPanel;

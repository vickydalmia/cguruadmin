import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';
import { Box, Flex, Typography } from '@strapi/design-system';
import { useForm } from '@strapi/strapi/admin';
import * as React from 'react';
import { useIntl } from 'react-intl';

import {
  pendingRequiredFields,
  type PendingField,
} from '../../utils/pending-required';
import {
  describeErrorLocation,
  flattenFormErrors,
  imageHintFor,
  type FlatError,
} from './error-location';

function ValidationProblemsList({
  problems,
  model,
  intro,
}: {
  problems: FlatError[];
  model: string;
  intro?: string;
}) {
  const { formatMessage } = useIntl();
  const messageText = (message: FlatError['message']): string =>
    typeof message === 'string'
      ? message
      : formatMessage(
          { id: message.id, defaultMessage: message.defaultMessage },
          message.values as any,
        );

  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        {intro ??
          'Fix these to save. Each problem field is also marked in red in the ' +
            'form, and any repeatable rows with problems open automatically.'}
      </Typography>
      {problems.map((problem) => {
        const isGenericClientMessage = typeof problem.message !== 'string';
        const hint = isGenericClientMessage ? imageHintFor(problem.path) : null;
        return (
          <Box key={problem.path.join('.')}>
            <Typography
              variant="pi"
              fontWeight="bold"
              textColor="danger600"
              tag="p"
            >
              {describeErrorLocation(problem.path, model)}
            </Typography>
            <Typography variant="pi" textColor="danger600" tag="p">
              {hint ?? messageText(problem.message)}
            </Typography>
          </Box>
        );
      })}
    </Flex>
  );
}

function PendingRequiredList({ pending }: { pending: PendingField[] }) {
  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        This entry is missing {pending.length === 1 ? 'a field' : 'fields'} that
        are now required. The save will be rejected until{' '}
        {pending.length === 1 ? 'it is' : 'they are'} filled in.
      </Typography>
      {pending.map((field) => (
        <Box key={field.path.join('.')}>
          <Typography
            variant="pi"
            fontWeight="bold"
            textColor="warning600"
            tag="p"
          >
            {field.label}
          </Typography>
        </Box>
      ))}
    </Flex>
  );
}

// The "Validation problems" side panel, on EVERY content type. Any
// create/update validation failure — client-side required-field checks or a
// server ValidationError whose details.errors[].path map onto form fields —
// is listed here with the offending field located.
//
// Deliberately NOT gated on a model allowlist (it used to be, on eight UIDs):
// nothing here needs per-model knowledge — flattenFormErrors walks arbitrary
// nested error state, pendingRequiredFields reads the content-manager's own
// schema attributes, and the two model-keyed lookups (SECTION_LABEL_BY_MODEL,
// IMAGE_RULE_BY_PATH) fall through to humanizeFieldName, so an unlisted model
// gets sensible generic labels rather than nothing.
export const ValidationProblemsPanel: PanelComponent = ({ model }) => {
  const formErrors = useForm('ValidationProblemsPanel', (state) => state.errors);
  const formValues = useForm('ValidationProblemsPanel', (state) => state.values);
  const { contentType, components, isCreatingEntry } =
    unstable_useContentManagerContext();
  const submitProblems = flattenFormErrors(formErrors);

  if (submitProblems.length > 0) {
    return {
      title: `Validation problems (${submitProblems.length})`,
      content: <ValidationProblemsList problems={submitProblems} model={model} />,
    };
  }
  if (isCreatingEntry) return null;

  const pending = pendingRequiredFields(
    contentType as any,
    components as any,
    formValues as Record<string, unknown>,
  );
  if (pending.length === 0) return null;

  return {
    title: `Needs attention (${pending.length})`,
    content: <PendingRequiredList pending={pending} />,
  };
};

import { useForm } from '@strapi/strapi/admin';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';
import { Box, Flex, Typography } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import {
  describeErrorLocation,
  flattenFormErrors,
  imageHintFor,
  type FlatError,
} from '../utils/form-errors';
import {
  pendingRequiredFields,
  type PendingField,
} from '../utils/pending-required';

function ValidationProblemsList({
  problems,
  model,
  intro,
}: {
  problems: FlatError[];
  model: string;
  /** Overrides the default copy, which assumes the fields are marked in red. */
  intro?: string;
}) {
  const { formatMessage } = useIntl();

  const messageText = (message: FlatError['message']): string =>
    typeof message === 'string'
      ? message
      : formatMessage(
          { id: message.id, defaultMessage: message.defaultMessage },
          message.values as any
        );

  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        {intro ??
          'Fix these to save. Each problem field is also marked in red in the ' +
            'form, and any repeatable rows with problems open automatically.'}
      </Typography>
      {problems.map((problem) => {
        // Server messages are already specific ("got 800×400 …") — only swap
        // in the size hint for the generic client-side "This value is required."
        const isGenericClientMessage = typeof problem.message !== 'string';
        const hint = isGenericClientMessage ? imageHintFor(problem.path) : null;
        return (
          <Box key={problem.path.join('.')}>
            <Typography variant="pi" fontWeight="bold" textColor="danger600" tag="p">
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

// The homepage-style "Validation problems" side panel, on EVERY content type.
// Any create/update validation failure — client-side required-field checks or a
// server ValidationError whose details.errors[].path map onto form fields (e.g.
// the coupon/deal offer-text word caps) — is listed here with the offending
// field highlighted inline.
//
// This used to be gated on a hardcoded eight-UID allowlist, which meant the same
// save failure read completely differently depending on the screen: redirects,
// jobs, job applications, unique coupon pools and every single type got a bare
// multi-line toast and no panel — exactly the screens where a toast is hardest
// to act on. Nothing in the panel needs per-model knowledge to work:
// flattenFormErrors walks arbitrary nested error state, and
// pendingRequiredFields reads the content-manager's own schema attributes. The
// two model-keyed lookups it does consult (SECTION_LABEL_BY_MODEL,
// IMAGE_RULE_BY_PATH) already fall through to humanizeFieldName, so an unlisted
// model gets sensible generic labels rather than nothing.
const ValidationProblemsPanel: PanelComponent = ({ model }) => {
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

  // Nothing has been submitted yet. Many rows here predate newer required-field
  // rules (205 entities are missing alt text), so list what is already missing
  // the moment the record opens — otherwise the editor only finds out when
  // their save bounces. Skipped while CREATING: an
  // empty new form would open with every required field listed as a problem,
  // which reads as broken rather than helpful.
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
          <Typography variant="pi" fontWeight="bold" textColor="warning600" tag="p">
            {field.label}
          </Typography>
        </Box>
      ))}
    </Flex>
  );
}

export default ValidationProblemsPanel;

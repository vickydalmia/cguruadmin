// Settings → UI Text: composition only. Read state from ../use-ui-dictionary,
// mutations from ../use-ui-dictionary-actions, rows filtered by
// ../filter-entries, pieces from the sibling components.
import * as React from 'react';
import { Dialog, Flex } from '@strapi/design-system';
import { ConfirmDialog, Layouts, Page } from '@strapi/strapi/admin';

import { filterEntries, namespacesOf } from '../filter-entries';
import type { UiDictionaryEntry } from '../types';
import { useUiDictionary } from '../use-ui-dictionary';
import { useUiDictionaryActions } from '../use-ui-dictionary-actions';
import { DictionaryFilters } from './dictionary-filters';
import { DictionaryTable } from './dictionary-table';
import { EntryEditDialog } from './entry-edit-dialog';
import { ImportDialog } from './import-dialog';
import { LanguageTabs } from './language-tabs';
import { PageActions } from './page-actions';
import { SyncStatusCard } from './sync-status-card';

const TITLE = 'UI Text';

export default function UiDictionaryPage() {
  const state = useUiDictionary();
  const actions = useUiDictionaryActions(state.locale, state.reload);
  const [editing, setEditing] = React.useState<UiDictionaryEntry | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [confirmForce, setConfirmForce] = React.useState(false);

  if (state.forbidden) {
    return (
      <Page.Main>
        <Page.Title>{TITLE}</Page.Title>
        <Page.NoPermissions />
      </Page.Main>
    );
  }
  if (state.error && !state.status) {
    return (
      <Page.Main>
        <Page.Title>{TITLE}</Page.Title>
        <Page.Error content={state.error} />
      </Page.Main>
    );
  }

  const translationActive = state.status?.translationActive === true;
  const isEnglish = state.language.code === 'en';
  const rows = filterEntries(state.entries, state.filters);
  const hasFilters = Boolean(
    state.filters.search || state.filters.status || state.filters.namespace || state.filters.showRemoved,
  );
  const catalogue = state.status?.catalogue;
  const subtitle = catalogue
    ? `Storefront UI text — catalogue ${catalogue.version.slice(0, 12)}, synced ${new Date(catalogue.pushedAt).toLocaleString()}`
    : 'Storefront UI text — no catalogue synced yet';

  const save = async (text: string) => {
    if (editing && (await actions.save(editing, text))) setEditing(null);
  };

  return (
    <Page.Main>
      <Page.Title>{TITLE}</Page.Title>
      <Layouts.Root>
        <Layouts.Header
          title={TITLE}
          subtitle={subtitle}
          primaryAction={
            <PageActions
              isEnglish={isEnglish}
              translationActive={translationActive}
              disabled={actions.busy || !catalogue}
              polling={state.polling}
              onImport={() => setImporting(true)}
              onExport={actions.exportMessages}
              onTranslate={() => actions.translate(false)}
              onRetranslate={() => setConfirmForce(true)}
            />
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {state.status ? <SyncStatusCard status={state.status} locale={state.locale} /> : null}
            <LanguageTabs
              languages={state.languages}
              locale={state.locale}
              status={state.status}
              onChange={state.setLocale}
            />
            <Flex gap={2} wrap="wrap" alignItems="center">
              <DictionaryFilters
                locale={state.locale}
                filters={state.filters}
                namespaces={namespacesOf(state.entries)}
                setFilter={state.setFilter}
              />
            </Flex>
            <DictionaryTable
              language={state.language}
              entries={rows}
              loading={state.loading}
              hasFilters={hasFilters}
              translationActive={translationActive}
              busy={actions.busy}
              onClearFilters={state.clearFilters}
              onEdit={setEditing}
              onReset={actions.reset}
            />
          </Flex>
        </Layouts.Content>
      </Layouts.Root>

      {editing ? (
        <EntryEditDialog
          key={`${state.locale}:${editing.key}`}
          entry={editing}
          language={state.language}
          saving={actions.busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          language={state.language}
          busy={actions.busy}
          onClose={() => setImporting(false)}
          onImport={actions.importMessages}
        />
      ) : null}
      <Dialog.Root open={confirmForce} onOpenChange={setConfirmForce}>
        <ConfirmDialog
          title="Re-translate every AI text?"
          onConfirm={async () => {
            setConfirmForce(false);
            await actions.translate(true);
          }}
        >
          {`This queues a paid re-translation of every AI-translated key${isEnglish ? ' in every language' : ` in ${state.language.name}`}. Manual texts are kept.`}
        </ConfirmDialog>
      </Dialog.Root>
    </Page.Main>
  );
}

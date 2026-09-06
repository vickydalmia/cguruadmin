import { RefreshResult } from './refresh-result';
import * as React from 'react';
import { Box, Button, Field, Flex, SingleSelect, SingleSelectOption, TextInput, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { refreshError, websiteRefreshApi, type RefreshOptions, type RefreshStatus } from '../api/website-refresh-api';

export function RefreshControls({ uid, documentId, website = false }: { uid?: string; documentId?: string; website?: boolean }) {
  const client = useFetchClient();
  const api = React.useMemo(() => websiteRefreshApi(client), [client.get, client.post]);
  const [options, setOptions] = React.useState<RefreshOptions | null>(null);
  const [locale, setLocale] = React.useState('en');
  const [path, setPath] = React.useState('/');
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState<RefreshStatus | null>(null);
  React.useEffect(() => {
    let active = true;
    setOptions(null); setStatus(null); setError(''); setConfirm(false);
    void api.options(uid, documentId).then((value) => {
      if (active) { setOptions(value); setPath(value.paths[0] ?? '/'); }
    }).catch((failure) => { if (active) setError(refreshError(failure)); });
    return () => { active = false; };
  }, [api, uid, documentId]);
  const polling = status?.state === 'queued' || status?.state === 'rendering' || Boolean(status?.pages?.some((page) => page.state === 'accepted'));
  React.useEffect(() => {
    if (!status?.id || !polling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.status(status.id); if (active) { setStatus(next); setError(''); } }
      catch (failure) { if (active) setError(refreshError(failure)); }
      if (active) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [api, status?.id, polling]);
  async function refresh(all: boolean) {
    setBusy(true); setError('');
    try { setStatus(await api.refresh({ locale, all, ...(all ? { confirm: true } : { path }) })); setConfirm(false); }
    catch (failure) { setError(refreshError(failure)); }
    finally { setBusy(false); }
  }
  const hasPage = website || Boolean(options?.paths.length);
  return <Flex direction="column" alignItems="stretch" gap={4}>
    {error && <Typography role="alert" textColor="danger600">{error}</Typography>}
    {!options && !error && <Typography>Loading website controls…</Typography>}
    {options && <>
      <Typography variant="pi">Website: {options.country}. Save your edits first. Refresh uses published content and existing translations.</Typography>
      <Field.Root name="refresh-language">
        <Field.Label>Website language</Field.Label>
        <SingleSelect value={locale} onChange={(value) => { setLocale(String(value)); setConfirm(false); }}>
          {options.languages.map((entry) => <SingleSelectOption key={entry.code} value={entry.code}>{entry.name}</SingleSelectOption>)}
          <SingleSelectOption value="*">All languages</SingleSelectOption>
        </SingleSelect>
      </Field.Root>
      {hasPage ? <>
        <Field.Root name="refresh-path">
          <Field.Label>Page path (English URL)</Field.Label>
          {website ? <TextInput value={path} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPath(event.target.value)} placeholder="/about-us/" /> :
            <SingleSelect value={path} onChange={(value) => setPath(String(value))}>
              {options.paths.map((entry) => <SingleSelectOption key={entry} value={entry}>{entry}</SingleSelectOption>)}
            </SingleSelect>}
        </Field.Root>
        <Button variant="secondary" loading={busy} disabled={busy || polling || !path} onClick={() => void refresh(false)}>Refresh website page</Button>
      </> : <Typography variant="pi">This entry has no individual public page. For shared content such as menus, use Settings → Website refresh.</Typography>}
      <Typography variant="pi" textColor="neutral600">Visitors keep seeing the current cached page while its replacement is generated. Refreshing does not create or update translations.</Typography>
      {website && <Box paddingTop={4}>
        {!confirm ? <Button variant="danger-light" disabled={busy || polling} onClick={() => setConfirm(true)}>Refresh entire website</Button> :
          <Flex direction="column" alignItems="stretch" gap={3}>
            <Typography>Refresh all pages for {locale === '*' ? 'all languages' : options.languages.find((entry) => entry.code === locale)?.name}? This runs in the background and can take several minutes.</Typography>
            <Button variant="danger" loading={busy} disabled={busy || polling} onClick={() => void refresh(true)}>Confirm website refresh</Button>
            <Button variant="tertiary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
          </Flex>}
      </Box>}
    </>}
    {status && <RefreshResult status={status} />}
  </Flex>;
}

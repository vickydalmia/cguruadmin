import Logo from './extensions/logo-icon.svg';

import type { StrapiApp } from '@strapi/strapi/admin';
import { useFetchClient, useForm } from '@strapi/strapi/admin';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import * as React from 'react';
import {
  Box,
  Checkbox,
  Divider,
  Flex,
  Loader,
  Tag,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { Cross } from '@strapi/icons';

import { useIntl } from 'react-intl';

import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from '../constants/homepage-sections';
import { HOMEPAGE_IMAGE_RULES } from '../constants/homepage-images';

type RelationConfig = {
  field: string;
  target: string;
  label: string;
};

const RELATION_CONFIG: Record<string, RelationConfig[]> = {
  'api::deal.deal': [
    { field: 'stores', target: 'api::store.store', label: 'Stores' },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
    { field: 'tags', target: 'api::tag.tag', label: 'Tags' },
  ],
  'api::coupon.coupon': [
    { field: 'stores', target: 'api::store.store', label: 'Stores' },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
    { field: 'tags', target: 'api::tag.tag', label: 'Tags' },
  ],
};

type Candidate = { id: number; documentId: string; name: string };
type RelationCommand = Candidate & {
  apiData: {
    id: number;
    documentId: string;
    locale: string | null;
    isTemporary?: boolean;
  };
};
type RelationFormValue = {
  connect?: RelationCommand[];
  disconnect?: RelationCommand[];
};

const PAGE_SIZE = 30;

const isRelationFormValue = (value: unknown): value is RelationFormValue =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('connect' in value || 'disconnect' in value)
  );

const getRelationDocumentId = (relation: any): string | undefined =>
  relation?.apiData?.documentId ?? relation?.documentId;

const toRelationCommand = (
  candidate: Candidate,
  options: { isTemporary?: boolean } = {}
): RelationCommand => ({
  id: candidate.id,
  documentId: candidate.documentId,
  name: candidate.name,
  apiData: {
    id: candidate.id,
    documentId: candidate.documentId,
    locale: null,
    ...(options.isTemporary ? { isTemporary: true } : {}),
  },
});

function useDeferredMount(): boolean {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const w = window as any;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(id);
  }, []);
  return ready;
}

function RelationSection({
  config,
  deferred,
  model,
  documentId,
}: {
  config: RelationConfig;
  deferred: boolean;
  model: string;
  documentId?: string;
}) {
  const { get } = useFetchClient();

  const formValue = useForm(
    'RelationSection',
    (state) => state.values?.[config.field]
  );
  const onChangeForm = useForm('RelationSection', (state) => state.onChange);

  const [selectedList, setSelectedList] = React.useState<Candidate[]>([]);

  const formValueRef = React.useRef(formValue);
  React.useEffect(() => {
    formValueRef.current = formValue;
  }, [formValue]);

  React.useEffect(() => {
    if (Array.isArray(formValue) && formValue.length > 0) {
      setSelectedList(
        formValue.map((v: any) => ({
          id: v.id,
          documentId: v.documentId,
          name: v.name ?? v.title ?? String(v.id),
        }))
      );
      return;
    }

    if (isRelationFormValue(formValue)) {
      setSelectedList((current) => {
        const disconnectDocIds = new Set(
          (formValue.disconnect ?? [])
            .map((relation) => getRelationDocumentId(relation))
            .filter((docId): docId is string => Boolean(docId))
        );
        const next = current.filter(
          (relation) => !disconnectDocIds.has(relation.documentId)
        );

        for (const relation of formValue.connect ?? []) {
          const docId = getRelationDocumentId(relation);
          if (
            !docId ||
            disconnectDocIds.has(docId) ||
            next.some((item) => item.documentId === docId)
          ) {
            continue;
          }

          next.push({
            id: relation.id,
            documentId: docId,
            name: relation.name ?? String(relation.id),
          });
        }

        return next;
      });
    }
  }, [formValue]);

  React.useEffect(() => {
    if (!deferred || !documentId) return;
    let cancelled = false;
    const run = async () => {
      try {
        const all: Candidate[] = [];
        for (let page = 1; page <= 50; page++) {
          const res = await get(
            `/content-manager/relations/${model}/${documentId}/${config.field}?page=${page}&pageSize=100`
          );
          const body = res?.data?.data ?? res?.data;
          const results: any[] = body?.results ?? [];
          all.push(
            ...results.map((r: any) => ({
              id: r.id,
              documentId: r.documentId,
              name: r.name ?? r.title ?? String(r.id),
            }))
          );
          const pageCount = body?.pagination?.pageCount ?? 1;
          if (page >= pageCount || results.length === 0) break;
        }
        if (cancelled) return;
        setSelectedList(() => {
          const latest = formValueRef.current;
          if (!isRelationFormValue(latest)) return all;
          const disconnectDocIds = new Set(
            (latest.disconnect ?? [])
              .map((relation) => getRelationDocumentId(relation))
              .filter((docId): docId is string => Boolean(docId))
          );
          const next = all.filter((r) => !disconnectDocIds.has(r.documentId));
          for (const relation of latest.connect ?? []) {
            const docId = getRelationDocumentId(relation);
            if (
              !docId ||
              disconnectDocIds.has(docId) ||
              next.some((item) => item.documentId === docId)
            ) {
              continue;
            }
            next.push({
              id: relation.id,
              documentId: docId,
              name: relation.name ?? String(relation.id),
            });
          }
          return next;
        });
      } catch (err) {
        console.error(`[taxonomy-panel] Failed to load selected ${config.field}`, err);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [deferred, documentId, model, config.field, get]);

  const selectedDocIds = React.useMemo(
    () => new Set(selectedList.map((s) => s.documentId)),
    [selectedList]
  );

  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [page, setPage] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [initialLoaded, setInitialLoaded] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setCandidates([]);
    setPage(1);
    setPageCount(1);
    setInitialLoaded(false);
  }, [debouncedSearch, config.target]);

  React.useEffect(() => {
    if (!deferred) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const searchParam = debouncedSearch
          ? `&filters[name][$containsi]=${encodeURIComponent(debouncedSearch)}`
          : '';
        const res = await get(
          `/content-manager/collection-types/${config.target}?page=${page}&pageSize=${PAGE_SIZE}&sort=name:ASC${searchParam}`
        );
        const body = res?.data?.data ?? res?.data;
        const results: any[] = body?.results ?? [];
        if (cancelled) return;
        const list: Candidate[] = results.map((r: any) => ({
          id: r.id,
          documentId: r.documentId,
          name: r.name ?? r.title ?? String(r.id),
        }));
        setCandidates((prev) => (page === 1 ? list : [...prev, ...list]));
        setPageCount(body?.pagination?.pageCount ?? 1);
        setInitialLoaded(true);
      } catch (err) {
        console.error(`[taxonomy-panel] Failed to load ${config.field}`, err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [deferred, page, debouncedSearch, config.target, config.field, get]);

  const toggle = (c: Candidate) => {
    const exists = selectedList.some((s) => s.documentId === c.documentId);
    const next = exists
      ? selectedList.filter((s) => s.documentId !== c.documentId)
      : [...selectedList, c];
    const currentValue = isRelationFormValue(formValue) ? formValue : {};
    const currentConnect = currentValue.connect ?? [];
    const currentDisconnect = currentValue.disconnect ?? [];

    setSelectedList(next);

    if (exists) {
      const wasOnlyPendingConnect = currentConnect.some(
        (relation) => getRelationDocumentId(relation) === c.documentId
      );

      onChangeForm(config.field, {
        connect: currentConnect.filter(
          (relation) => getRelationDocumentId(relation) !== c.documentId
        ),
        disconnect: wasOnlyPendingConnect
          ? currentDisconnect
          : [
              ...currentDisconnect.filter(
                (relation) => getRelationDocumentId(relation) !== c.documentId
              ),
              toRelationCommand(c),
            ],
      });

      return;
    }

    const wasPendingDisconnect = currentDisconnect.some(
      (relation) => getRelationDocumentId(relation) === c.documentId
    );

    onChangeForm(config.field, {
      connect: wasPendingDisconnect
        ? currentConnect.filter(
            (relation) => getRelationDocumentId(relation) !== c.documentId
          )
        : [
            ...currentConnect.filter(
              (relation) => getRelationDocumentId(relation) !== c.documentId
            ),
            toRelationCommand(c, { isTemporary: true }),
          ],
      disconnect: currentDisconnect.filter(
        (relation) => getRelationDocumentId(relation) !== c.documentId
      ),
    });
  };

  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const hasMore = page < pageCount;

  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage((p) => p + 1);
        }
      },
      { root: el.parentElement, rootMargin: '50px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, candidates.length]);

  return (
    <Box paddingTop={3} paddingBottom={3} width="100%">
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="sigma" textColor="neutral600">
          {config.label} ({selectedList.length})
        </Typography>
      </Flex>

      {selectedList.length > 0 ? (
        <Box paddingBottom={2} width="100%">
          <Flex gap={1} wrap="wrap">
            {selectedList.map((c) => (
              <Tag key={c.documentId} icon={<Cross />} onClick={() => toggle(c)}>
                {c.name}
              </Tag>
            ))}
          </Flex>
        </Box>
      ) : null}

      <Box paddingBottom={2} width="100%">
        <TextInput
          aria-label={`Search ${config.label}`}
          placeholder={`Search ${config.label.toLowerCase()}...`}
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          size="S"
        />
      </Box>

      <Box
        hasRadius
        background="neutral0"
        borderColor="neutral200"
        padding={2}
        width="100%"
        style={{ maxHeight: 220, overflowY: 'auto', boxSizing: 'border-box' }}
      >
        {candidates.map((c) => (
          <Box key={c.documentId} paddingBottom={1}>
            <Checkbox
              checked={selectedDocIds.has(c.documentId)}
              onCheckedChange={() => toggle(c)}
            >
              {c.name}
            </Checkbox>
          </Box>
        ))}

        {initialLoaded && candidates.length === 0 ? (
          <Typography variant="pi" textColor="neutral500">
            {debouncedSearch ? 'No matches.' : `No ${config.label.toLowerCase()} available.`}
          </Typography>
        ) : null}

        {loading ? (
          <Flex justifyContent="center" padding={2}>
            <Loader small>Loading</Loader>
          </Flex>
        ) : null}

        <div ref={sentinelRef} style={{ height: 1 }} />
      </Box>
    </Box>
  );
}

function PanelBody({
  model,
  documentId,
}: {
  model: string;
  documentId?: string;
}) {
  const deferred = useDeferredMount();
  return (
    <Box width="100%">
      {RELATION_CONFIG[model].map((cfg, idx) => (
        <React.Fragment key={cfg.field}>
          {idx > 0 ? <Divider /> : null}
          <RelationSection
            config={cfg}
            deferred={deferred}
            model={model}
            documentId={documentId}
          />
        </React.Fragment>
      ))}
    </Box>
  );
}

const RelationMultiSelectPanel: PanelComponent = ({ model, documentId }) => {
  if (!RELATION_CONFIG[model]) return null;

  return {
    title: 'Taxonomies',
    content: <PanelBody model={model} documentId={documentId} />,
  };
};

// ---------------------------------------------------------------------------
// Validation-problems panel (homepage). Both the client-side pre-save check
// and the server-side image validator put their errors into the same nested
// form-errors state ({ section: { items: [{ field: 'msg' }] } }); this panel
// flattens that into a human list with the numbered section names, so editors
// see exactly WHERE the save failed instead of hunting through every section.
// ---------------------------------------------------------------------------
const SECTION_LABEL_BY_ATTR: Record<string, string> = Object.fromEntries(
  HOMEPAGE_SECTION_LABELS.map(({ attr, label }) => [attr, label])
);

// Client-side (pre-save) errors are stored as react-intl message descriptors
// ({ id, defaultMessage, values? }), server-side ones as plain strings — the
// flattener must treat descriptors as leaves, not nested error objects.
type MessageDescriptorLike = {
  id: string;
  defaultMessage?: string;
  values?: Record<string, unknown>;
};

const isMessageDescriptor = (node: unknown): node is MessageDescriptorLike =>
  typeof node === 'object' &&
  node !== null &&
  !Array.isArray(node) &&
  typeof (node as MessageDescriptorLike).id === 'string' &&
  typeof (node as MessageDescriptorLike).defaultMessage === 'string';

type FlatError = {
  path: Array<string | number>;
  message: string | MessageDescriptorLike;
};

const flattenFormErrors = (
  node: unknown,
  path: Array<string | number> = []
): FlatError[] => {
  if (node == null) return [];
  if (typeof node === 'string' || isMessageDescriptor(node)) {
    return path.length ? [{ path, message: node }] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      child == null ? [] : flattenFormErrors(child, [...path, index])
    );
  }
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) =>
      flattenFormErrors(value, [...path, key])
    );
  }
  return [];
};

// 'cardImage' -> 'card image'
const humanizeFieldName = (segment: string): string =>
  segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

// ['newlyAdded','items',1,'cardImage'] -> "7 · Fresh Drops … › items #2 › card image"
const describeErrorLocation = (path: Array<string | number>): string => {
  const parts: string[] = [];
  path.forEach((segment, index) => {
    if (typeof segment === 'number') {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''} #${segment + 1}`;
      return;
    }
    parts.push(
      index === 0
        ? SECTION_LABEL_BY_ATTR[segment] ?? segment
        : humanizeFieldName(segment)
    );
  });
  return parts.join(' › ');
};

// "newlyAdded.items[].cardImage" rule paths, keyed without indices so an error
// path like newlyAdded.items.1.cardImage can look up its size requirement.
const IMAGE_RULE_BY_PATH = new Map(
  HOMEPAGE_IMAGE_RULES.map((rule) => [rule.path.replace('[]', ''), rule])
);

const imageHintFor = (path: Array<string | number>): string | null => {
  const key = path.filter((segment) => typeof segment === 'string').join('.');
  const rule = IMAGE_RULE_BY_PATH.get(key);
  return rule ? `Upload the ${rule.label} — exactly ${rule.width}×${rule.height} px.` : null;
};

function ValidationProblemsList({ problems }: { problems: FlatError[] }) {
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
        Fix these to save. Each problem field is also marked in red in the
        form, and rows with problems open automatically.
      </Typography>
      {problems.map((problem) => {
        // Server messages are already specific ("got 800×400 …") — only swap
        // in the size hint for the generic client-side "This value is required."
        const isGenericClientMessage = typeof problem.message !== 'string';
        const hint = isGenericClientMessage ? imageHintFor(problem.path) : null;
        return (
          <Box key={problem.path.join('.')}>
            <Typography variant="pi" fontWeight="bold" textColor="danger600" tag="p">
              {describeErrorLocation(problem.path)}
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

const ValidationProblemsPanel: PanelComponent = ({ model }) => {
  // Hook order must not depend on the model — select first, bail after.
  const formErrors = useForm('ValidationProblemsPanel', (state) => state.errors);

  if (model !== HOMEPAGE_UID) return null;

  const problems = flattenFormErrors(formErrors);
  if (problems.length === 0) return null;

  return {
    title: `Validation problems (${problems.length})`,
    content: <ValidationProblemsList problems={problems} />,
  };
};

export default {
  config: {
    auth: { // Replace the Strapi logo in auth (login) views
      logo: Logo,
    },
    menu: { // Replace the Strapi logo in the main navigation
      logo: Logo,
    },
    locales: ['en'],
    translations: {
      en: {
        'Auth.form.welcome.title': 'Welcome to CouponzGuru',
        'Auth.form.welcome.subtitle': 'Log in to your account',
        // Shown when the pre-save (client-side) check finds empty required
        // fields — the request never reaches the server in that case, so the
        // detailed server toast can't appear. Point editors at the panel.
        'content-manager.validation.error':
          'Some required fields are empty or invalid. See the "Validation problems" panel on the right — problem fields are marked in red and their rows open automatically.',
      },
    }
  },
  bootstrap(app: StrapiApp) {
    const apis = (app.getPlugin('content-manager') as any).apis;
    apis.addEditViewSidePanel([RelationMultiSelectPanel, ValidationProblemsPanel]);

    if (typeof document !== 'undefined') {
      const rewrite = () => {
        if (document.title.includes('Strapi')) {
          document.title = document.title.replace(/Strapi/g, 'CouponzGuru');
        }
      };
      rewrite();
      const titleEl = document.querySelector('title');
      if (titleEl) {
        new MutationObserver(rewrite).observe(titleEl, { childList: true });
      }
    }
  },
};

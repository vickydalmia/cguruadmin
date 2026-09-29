import type { SectionLabel } from './homepage-sections';

export const FESTIVAL_PAGE_UID = 'api::festival-page.festival-page';

export const FESTIVAL_SECTION_LABELS: SectionLabel[] = [
  {
    attr: 'title',
    label: 'Admin title',
    description:
      'Internal name only. The selected entity keeps its default view until Festival content sections are available and configured.',
  },
  {
    attr: 'seo',
    label: 'SEO (search & social)',
    description:
      'Festival metadata for the configured template. The default entity metadata remains active until Festival content is ready.',
  },
];

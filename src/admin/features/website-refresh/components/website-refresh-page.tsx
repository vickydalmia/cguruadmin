import { Box } from '@strapi/design-system';
import { Layouts, Page } from '@strapi/strapi/admin';
import { RefreshControls } from './refresh-controls';
export default function WebsiteRefreshPage() {
  return <Page.Main>
    <Layouts.Header title="Website refresh" subtitle="Regenerate a page or refresh the website by language." />
    <Layouts.Content><Box background="neutral0" padding={6} hasRadius><RefreshControls website /></Box></Layouts.Content>
  </Page.Main>;
}

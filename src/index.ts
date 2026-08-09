import type { Core } from '@strapi/strapi';

import {
  bootstrapApplication,
  destroyApplication,
} from './lifecycles/bootstrap-application';
import { registerApplication } from './lifecycles/register-application';

export { COMPONENT_FIELD_DESCRIPTIONS } from './lifecycles/content-manager/component-field-hints';
export { CONTENT_TYPE_FIELD_HINTS } from './lifecycles/content-manager/content-type-field-hints';

export default {
  async register({ strapi }: { strapi: Core.Strapi }) {
    await registerApplication(strapi);
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await bootstrapApplication(strapi);
  },

  async destroy() {
    await destroyApplication();
  },
};

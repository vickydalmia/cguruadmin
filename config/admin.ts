import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Admin => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT'),
    },
  },
  secrets: {
    encryptionKey: env('ENCRYPTION_KEY'),
  },
  flags: {
    nps: env.bool('FLAG_NPS', true),
    promoteEE: env.bool('FLAG_PROMOTE_EE', true),
  },
  // No frontend preview integration — hide the "Set up preview" panel in the
  // edit view for every content type. (enabled:false makes the preview-url
  // endpoint answer 204, which removes the panel; leaving preview unconfigured
  // would instead show the setup CTA.)
  preview: {
    enabled: false,
    // Never called while disabled; the type requires a handler regardless.
    config: {
      handler: () => undefined,
    },
  },
});

export default config;

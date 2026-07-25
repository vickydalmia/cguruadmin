import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Middlewares => {
  const uploadCspSources = env.array('UPLOAD_CSP_SOURCES', []);

  return [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...uploadCspSources],
          'media-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...uploadCspSources],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      // Direct browser-to-CMS access is not needed for the beta/production site:
      // search/redeem go through the public site's ISR gateway proxy. Add
      // origins only for trusted direct-CMS browser clients such as local dev.
      origin: env.array('CORS_ORIGINS', ['http://localhost:4321']),
      headers: ['Content-Type', 'Authorization'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'global::live-offer-relations',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  ];
};

export default config;

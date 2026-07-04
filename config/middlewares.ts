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
      // Browser-issued requests from the static site: /api/search and
      // /plugin/unique-coupon/redeem. Add production origins via CORS_ORIGINS.
      origin: env.array('CORS_ORIGINS', ['http://localhost:4321']),
      headers: ['Content-Type', 'Authorization'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  ];
};

export default config;

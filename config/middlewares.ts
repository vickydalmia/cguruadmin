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
      // Empty by default: an unset value must not silently admit a dev origin
      // in production. Local development sets CORS_ORIGINS in its own .env.
      origin: env.array('CORS_ORIGINS', []),
      headers: ['Content-Type', 'Authorization'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'global::live-offer-relations',
  'global::relation-search-config-guard',
  {
    name: 'strapi::body',
    config: {
      // Formidable's default cap is 200 MB, and it is spent BEFORE any
      // controller-level size check runs. There is no longer a public
      // multipart route on this server — résumés are emailed by the ISR
      // gateway and never reach Strapi — so this now bounds authenticated
      // admin media uploads only, ~8× below the default while leaving
      // headroom for editor images.
      formidable: {
        maxFileSize: 25 * 1024 * 1024,
        maxTotalFileSize: 25 * 1024 * 1024,
      },
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  ];
};

export default config;

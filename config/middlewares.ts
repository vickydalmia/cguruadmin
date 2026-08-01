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
  'global::relation-search-config-guard',
  {
    name: 'strapi::body',
    config: {
      // Formidable's default cap is 200 MB, and it is spent BEFORE any
      // controller-level size check runs — an anonymous multipart request
      // (e.g. the public job-application submit) could burn that much
      // disk/network per attempt. 25 MB is global (admin media uploads share
      // it), bounding abuse ~8× below the default while leaving headroom for
      // editor images; the résumé route additionally enforces its own 5 MB
      // rule in the controller, and the site gateway caps the public path at
      // 6 MB before it reaches this server at all.
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

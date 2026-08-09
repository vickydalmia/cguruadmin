import type { Core } from '@strapi/strapi';

import { hasTrustedIpsConfigured } from '../middlewares/rate-limit';

export function warnIfTrustedIpsMissing(strapi: Core.Strapi): void {
  if (!hasTrustedIpsConfigured()) {
    strapi.log.warn(
      '[rate-limit] RATE_LIMIT_TRUSTED_IPS is empty — ISR renders share the ' +
        'public per-IP budget and signed ISR cache-bypass requests will be ' +
        "rejected. Set it to the Astro origin's private IP.",
    );
  }
}

export function warnIfUploadConfigurationIsUnsafe(strapi: Core.Strapi): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.S3_UPLOAD_ENABLED !== 'true'
  ) {
    strapi.log.error(
      '[upload] S3_UPLOAD_ENABLED is not "true" — uploads will go to LOCAL DISK ' +
        '(ephemeral tmpfs, lost on redeploy). Set S3_UPLOAD_ENABLED=true in the production env.',
    );
  }

  const uploadAllowedTypes = strapi.config.get([
    'plugin::upload',
    'security',
    'allowedTypes',
  ]);
  if (!Array.isArray(uploadAllowedTypes)) {
    strapi.log.error(
      '[upload] plugin::upload.security.allowedTypes is missing — the Media Library ' +
        'will accept ANY file type. Restore the `security` block in config/plugins.ts.',
    );
  } else if (uploadAllowedTypes.length === 0) {
    strapi.log.error(
      '[upload] plugin::upload.security.allowedTypes is empty — EVERY upload will be ' +
        'rejected. List the permitted MIME types in config/plugins.ts.',
    );
  }
}

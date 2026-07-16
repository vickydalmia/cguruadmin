import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => {
  const s3UploadEnabled = env.bool(
    'S3_UPLOAD_ENABLED',
    env('NODE_ENV', 'development') !== 'production'
  );

  const s3BaseUrl = env('S3_BASE_URL', 'https://media.vicky.com');
  const s3RootPath = env('S3_ROOT_PATH', '');

  return {
    'unique-coupon': {
      enabled: true,
      resolve: './src/plugins/unique-coupon',
    },

    ...(s3UploadEnabled
      ? {
          upload: {
            config: {
              // Responsive format sizes generated on upload (originals are
              // capped at 1920 by src/extensions/upload — no 1920 breakpoint).
              // xsmall serves ~150px card slots at DPR 2 — without it the
              // smallest variant is 500px and thumbnails download 3x the
              // pixels they render (Lighthouse "improve image delivery").
              breakpoints: { large: 1000, medium: 750, small: 500, xsmall: 320 },
              provider: 'aws-s3',
              providerOptions: {
                baseUrl: s3BaseUrl,
                ...(s3RootPath ? { rootPath: s3RootPath } : {}),
                s3Options: {
                  credentials: {
                    accessKeyId: env('S3_ACCESS_KEY_ID'),
                    secretAccessKey: env('S3_ACCESS_SECRET'),
                  },
                  region: env('S3_REGION'),
                  forcePathStyle: env.bool('S3_FORCE_PATH_STYLE', false),
                  params: {
                    Bucket: env('S3_BUCKET'),
                    ACL: undefined,
                  },
                },
                providerConfig: {
                  checksumAlgorithm: env('S3_CHECKSUM_ALGORITHM', 'CRC64NVME'),
                  preventOverwrite: env.bool('S3_PREVENT_OVERWRITE', true),
                  multipart: {
                    partSize: env.int('S3_MULTIPART_PART_SIZE', 10 * 1024 * 1024),
                    queueSize: env.int('S3_MULTIPART_QUEUE_SIZE', 4),
                  },
                },
              },
              actionOptions: {
                // Media filenames are content-hashed (and preventOverwrite is
                // on), so a replaced image always gets a NEW URL — immutable
                // year-long browser/CDN caching is safe and fixes the
                // "Cache TTL: None" Lighthouse audit on media.couponzguru.com.
                // Existing objects need a one-time metadata backfill (aws s3 cp
                // --metadata-directive REPLACE --cache-control ...).
                upload: { CacheControl: 'public, max-age=31536000, immutable' },
                uploadStream: { CacheControl: 'public, max-age=31536000, immutable' },
                delete: {},
              },
            },
          },
        }
      : {}),
  };
};

export default config;
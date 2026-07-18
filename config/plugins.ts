import type { Core } from '@strapi/strapi';
import { IMAGE_BREAKPOINTS } from '../src/constants/image';

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

    upload: {
      config: {
        // Breakpoints live OUTSIDE the S3 gate: the variant matrix must be
        // identical whether uploads land on S3 or local disk (values in
        // src/constants/image.ts, shared with the migration pipeline).
        breakpoints: { ...IMAGE_BREAKPOINTS },
        ...(s3UploadEnabled
          ? {
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
                // Existing objects need a one-time metadata backfill:
                // migration's `npm run fix:cache-headers` (NOT aws s3 cp,
                // which re-guesses Content-Type from extensions).
                upload: { CacheControl: 'public, max-age=31536000, immutable' },
                uploadStream: { CacheControl: 'public, max-age=31536000, immutable' },
                delete: {},
              },
            }
          : {}),
      },
    },
  };
};

export default config;
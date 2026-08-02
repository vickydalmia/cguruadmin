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
    email: {
      config: {
        provider: 'nodemailer',
        providerOptions: {
          host: env('SMTP_HOST'),
          port: env.int('SMTP_PORT', 587),
          secure: env.bool('SMTP_SECURE', false),
          auth: {
            user: env('SMTP_USERNAME'),
            pass: env('SMTP_PASSWORD'),
          },
        },
        settings: {
          defaultFrom: env('EMAIL_DEFAULT_FROM'),
          defaultReplyTo: env('EMAIL_DEFAULT_REPLY_TO'),
        },
      },
    },

    'unique-coupon': {
      enabled: true,
      resolve: './src/plugins/unique-coupon',
    },

    upload: {
      config: {
        // Server-side MIME allow list. @strapi/upload 5.50 reads exactly this
        // key (`plugin::upload.security`) in utils/mime-validation and applies
        // it in BOTH upload controllers — the admin media library and
        // POST /api/upload. It sniffs the file's magic bytes and rejects when
        // content, extension and declared Content-Type disagree, so a renamed
        // .html/.php cannot get in on its extension. Without the key the
        // plugin allows every type and only logs a warning per request; the
        // boot check in src/index.ts catches that regression loudly.
        //
        // No SVG: an SVG can carry inline <script> and is served same-origin,
        // so src/extensions/upload already rejects it outright — this list
        // just moves that refusal earlier, before the file is written.
        //
        // Images only. PDF/DOC/DOCX used to be listed so résumé submissions
        // could reach the media library through the upload service; that path
        // is gone (applications are emailed by the ISR gateway and never
        // stored), so the document types come off with it. DOC/DOCX in
        // particular can carry macros and had no editorial use case.
        security: {
          allowedTypes: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/avif',
            'image/gif',
          ],
        },
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

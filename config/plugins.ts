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
        // Resume document types (PDF/DOC/DOCX) ARE listed: resumes normally
        // reach the media library through the upload SERVICE
        // (src/api/job-application/controllers/submit.ts), which this
        // controller-level gate does not see — that endpoint does its own
        // magic-byte validation in src/utils/resume-upload-validation.ts. They
        // are allowed here so that if that path is ever routed through the
        // controller gate, resume submissions keep working. Deliberate side
        // effect: the admin Media Library's upload endpoint now also accepts
        // these document types from editors (its UI picker is unchanged — it
        // filters by asset category, not by this list).
        security: {
          allowedTypes: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/avif',
            'image/gif',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
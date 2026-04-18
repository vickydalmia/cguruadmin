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
                upload: {},
                uploadStream: {},
                delete: {},
              },
            },
          },
        }
      : {}),
  };
};

export default config;
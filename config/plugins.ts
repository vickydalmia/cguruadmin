import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => {
  const s3UploadEnabled = env.bool('S3_UPLOAD_ENABLED', env('NODE_ENV', 'development') === 'production');
  const s3BaseUrl = env('S3_BASE_URL', '');
  const s3RootPath = env('S3_ROOT_PATH', '');
  const s3Endpoint = env('S3_ENDPOINT', '');
  const s3Acl = env('S3_ACL', '');
  const s3EncryptionType = env('S3_ENCRYPTION_TYPE', '');
  const s3KmsKeyId = env('S3_KMS_KEY_ID', '');

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
                ...(s3BaseUrl ? { baseUrl: s3BaseUrl } : {}),
                ...(s3RootPath ? { rootPath: s3RootPath } : {}),
                s3Options: {
                  credentials: {
                    accessKeyId: env('S3_ACCESS_KEY_ID'),
                    secretAccessKey: env('S3_ACCESS_SECRET'),
                  },
                  region: env('S3_REGION'),
                  ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
                  forcePathStyle: env.bool('S3_FORCE_PATH_STYLE', false),
                  params: {
                    Bucket: env('S3_BUCKET'),
                    signedUrlExpires: env.int('S3_SIGNED_URL_EXPIRES', 15 * 60),
                    ...(s3Acl ? { ACL: s3Acl } : {}),
                  },
                },
                providerConfig: {
                  checksumAlgorithm: env('S3_CHECKSUM_ALGORITHM', 'CRC64NVME'),
                  preventOverwrite: env.bool('S3_PREVENT_OVERWRITE', true),
                  ...(s3EncryptionType
                    ? {
                        encryption: {
                          type: s3EncryptionType,
                          ...(s3KmsKeyId ? { kmsKeyId: s3KmsKeyId } : {}),
                        },
                      }
                    : {}),
                  tags: {
                    application: env('S3_OBJECT_TAG_APPLICATION', 'couponzguru'),
                    environment: env('NODE_ENV', 'production'),
                  },
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

import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  'unique-coupon': {
    enabled: true,
    resolve: './src/plugins/unique-coupon',
  },
});

export default config;

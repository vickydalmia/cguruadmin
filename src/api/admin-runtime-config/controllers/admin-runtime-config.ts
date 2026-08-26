import { configuredPublicSiteUrl } from '../../../utils/public-site-url';

/**
 * Safe deployment identity for the authenticated admin bundle.
 *
 * Browser JavaScript cannot read the running container environment directly.
 * Serving this non-secret value from the admin router keeps the Docker image
 * country-neutral without exposing any secret or allowing editors to mutate
 * the deployment domain.
 */
export default () => ({
  async find(ctx: any) {
    return ctx.send({
      data: {
        publicSiteUrl: configuredPublicSiteUrl(),
      },
    });
  },
});

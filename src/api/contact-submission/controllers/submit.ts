import type { Core } from '@strapi/strapi';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submit(ctx: any) {
    const body = ctx.request.body ?? {};
    const fullName = clean(body.fullName, 120);
    const email = clean(body.email, 254).toLowerCase();
    const topic = clean(body.topic, 100);
    const message = clean(body.message, 2000);
    const company = clean(body.company, 120);

    // Honeypot submissions get the same successful response as real ones so
    // bots cannot tune themselves against the trap, but no database row is
    // created. The route-level rate limit still applies.
    if (company) {
      ctx.status = 201;
      return ctx.send({ data: { submitted: true } });
    }

    if (!fullName || !topic || !EMAIL_PATTERN.test(email)) {
      return ctx.badRequest('Please complete all required fields.');
    }

    await strapi
      .documents('api::contact-submission.contact-submission' as any)
      .create({
        data: {
          fullName,
          email,
          topic,
          message: message || null,
          status: 'new',
        } as any,
      });

    ctx.status = 201;
    return ctx.send({ data: { submitted: true } });
  },
});

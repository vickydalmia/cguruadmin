import type { Core } from '@strapi/strapi';
import { sanitizeOutput } from '../../../utils/offer-visibility';

const PAGE_POPULATE = {
  hero: { populate: { image: true } },
  whyJoinHeader: true,
  benefits: true,
  values: true,
  jobsSection: true,
  life: { populate: { header: true, paragraphs: true, image: true } },
  jobDetail: { populate: { heroImage: true } },
  seo: { populate: { ogImage: true } },
} as const;

const JOB_POPULATE = {
  opportunityParagraphs: true,
  responsibilities: true,
  requirements: true,
  benefits: true,
  seo: { populate: { ogImage: true } },
} as const;

async function careerPage(strapi: Core.Strapi, ctx: any) {
  const page = await strapi.documents('api::career-page.career-page' as any).findFirst({
    populate: PAGE_POPULATE as any,
  });
  return page
    ? sanitizeOutput(strapi, ctx, 'api::career-page.career-page', page)
    : null;
}

async function activeJobs(strapi: Core.Strapi, ctx: any) {
  const jobs = await strapi.documents('api::job.job' as any).findMany({
    filters: { isActive: true } as any,
    sort: ['sortOrder:asc', 'title:asc'] as any,
    populate: JOB_POPULATE as any,
  });
  return sanitizeOutput(strapi, ctx, 'api::job.job', jobs);
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async careerPageFull(ctx: any) {
    const [page, jobs] = await Promise.all([
      careerPage(strapi, ctx),
      activeJobs(strapi, ctx),
    ]);
    return ctx.send({ data: { page, jobs } });
  },

  async jobFull(ctx: any) {
    const slug = String(ctx.params.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return ctx.badRequest('Invalid job slug');
    }

    const [page, jobs] = await Promise.all([
      careerPage(strapi, ctx),
      activeJobs(strapi, ctx),
    ]);
    const job = (jobs as any[]).find((item) => item.slug === slug) ?? null;
    if (!job) return ctx.notFound('Job not found');

    return ctx.send({
      data: {
        page,
        job,
        moreJobs: (jobs as any[]).filter((item) => item.slug !== slug).slice(0, 2),
      },
    });
  },
});

export { JOB_POPULATE, PAGE_POPULATE };

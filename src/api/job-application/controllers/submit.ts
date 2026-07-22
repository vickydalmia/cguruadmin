import type { Core } from '@strapi/strapi';

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const RESUME_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const clean = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submit(ctx: any) {
    const body = ctx.request.body ?? {};
    const jobSlug = clean(body.jobSlug, 160).toLowerCase();
    const fullName = clean(body.fullName, 120);
    const email = clean(body.email, 254).toLowerCase();
    const phone = clean(body.phone, 40);
    const linkedInUrl = clean(body.linkedInUrl, 300);
    const message = clean(body.message, 2000);
    const fileValue = ctx.request.files?.resume;
    const resumeFile = Array.isArray(fileValue) ? fileValue[0] : fileValue;

    if (!jobSlug || !fullName || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return ctx.badRequest('Please complete all required fields.');
    }
    if (linkedInUrl) {
      try {
        const parsed = new URL(linkedInUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        return ctx.badRequest('LinkedIn URL is invalid.');
      }
    }
    if (!resumeFile) return ctx.badRequest('Please attach your resume.');
    if (Number(resumeFile.size ?? 0) > MAX_RESUME_BYTES) {
      return ctx.badRequest('Resume must be 5 MB or smaller.');
    }
    if (!RESUME_MIME_TYPES.has(String(resumeFile.type ?? resumeFile.mimetype ?? ''))) {
      return ctx.badRequest('Resume must be a PDF, DOC, or DOCX file.');
    }

    const job: any = await strapi.documents('api::job.job' as any).findFirst({
      filters: { slug: jobSlug, isActive: true } as any,
      fields: ['documentId'] as any,
    });
    if (!job) return ctx.notFound('This job is no longer accepting applications.');

    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name: resumeFile.name, caption: `Resume for ${fullName}` } },
      files: resumeFile,
    });
    const resume = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    await strapi.documents('api::job-application.job-application' as any).create({
      data: {
        job: job.documentId,
        fullName,
        email,
        phone,
        linkedInUrl: linkedInUrl || null,
        message: message || null,
        resume: resume?.id,
        status: 'new',
      } as any,
    });

    ctx.status = 201;
    return ctx.send({ data: { submitted: true } });
  },
});

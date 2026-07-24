import type { Core } from '@strapi/strapi';

import {
  readFirstBytes,
  validateResumeUpload,
} from '../../../utils/resume-upload-validation';

const RESUME_TYPE_ERROR = 'Resume must be a PDF or DOCX file.';

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

    // SECURITY GATE — must stay ahead of the upload service call below. That
    // service call bypasses the upload plugin's own MIME gate (its controllers
    // apply security.allowedTypes, its service does not), and the declared
    // Content-Type is attacker-controlled, so the verdict comes from the
    // file's magic bytes (src/utils/resume-upload-validation.ts). Size cap
    // (5 MB) is enforced in the same module.
    let firstBytes: Uint8Array;
    try {
      // Property fallbacks mirror @strapi/upload's mime-validation: formidable
      // uses `filepath`, older parsers `path`/`tempFilePath`.
      const tempPath =
        resumeFile.filepath ?? resumeFile.path ?? resumeFile.tempFilePath;
      if (!tempPath) throw new Error('uploaded file has no temp path');
      firstBytes = await readFirstBytes(String(tempPath));
    } catch {
      return ctx.badRequest(RESUME_TYPE_ERROR);
    }

    const verdict = await validateResumeUpload({
      firstBytes,
      declaredMime: String(resumeFile.type ?? resumeFile.mimetype ?? ''),
      filename: String(resumeFile.name ?? resumeFile.originalFilename ?? ''),
      size: Number(resumeFile.size ?? 0),
    });
    if (verdict.ok === false) {
      return verdict.reason === 'too-large'
        ? ctx.badRequest('Resume must be 5 MB or smaller.')
        : ctx.badRequest(RESUME_TYPE_ERROR);
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

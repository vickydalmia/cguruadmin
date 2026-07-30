import type { Core } from '@strapi/strapi';
import crypto from 'crypto';
import {
  isOfferEntityType,
  isOfferFeedbackValue,
} from '../services/offer-feedback';

const MAX_DOCUMENT_ID_LENGTH = 255;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submit(ctx) {
    const { entityType, documentId } = ctx.params;
    const { result } = ctx.request.body ?? {};

    if (!isOfferEntityType(entityType)) {
      return ctx.badRequest('Unsupported entity type');
    }

    const trimmedDocumentId =
      typeof documentId === 'string' ? documentId.trim() : '';
    if (
      trimmedDocumentId.length === 0 ||
      trimmedDocumentId.length > MAX_DOCUMENT_ID_LENGTH
    ) {
      return ctx.badRequest('Invalid document id');
    }

    if (!isOfferFeedbackValue(result)) {
      return ctx.badRequest('Feedback result must be "worked" or "failed"');
    }

    // One vote per client per offer, enforced by offer_feedback_votes. The IP
    // (koa-resolved, honors TRUST_PROXY / X-Forwarded-For like
    // global::rate-limit) is stored only as a salted hash.
    const ip: string = ctx.request.ip || 'unknown';
    const appKeys = strapi.config.get('server.app.keys', ['']) as string[];
    const ipHash = crypto
      .createHash('sha256')
      .update(`${appKeys[0] ?? ''}|${ip}`)
      .digest('hex');

    const outcome = await strapi
      .service('api::offer-feedback.offer-feedback' as any)
      .submitFeedback(entityType, trimmedDocumentId, result, ipHash);
    if (!outcome) {
      return ctx.notFound(`${entityType} not found`);
    }
    if (outcome.alreadyVoted) {
      return ctx.tooManyRequests('You have already left feedback for this offer.');
    }

    return ctx.send({
      ok: true,
      workedCount: outcome.workedCount,
      failedCount: outcome.failedCount,
    });
  },
});

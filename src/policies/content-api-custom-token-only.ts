/**
 * Only a Custom-type Content API token may pass. Strapi's own `verify` step
 * enforces route scopes for Custom and Read-only tokens, but a Full-access
 * token skips scope checks entirely (`@strapi/admin` content-api-token
 * strategy, `verify`), so a route that must be reachable ONLY by a token
 * scoped to it needs this extra gate. Admin sessions, read-only tokens and
 * unauthenticated calls also fail closed.
 *
 * The strategy name is `content-api-token` on Strapi ≥ 5.4x and `api-token`
 * on earlier 5.x releases; both are accepted.
 */
const CONTENT_API_TOKEN_STRATEGIES = new Set(['content-api-token', 'api-token']);
const CUSTOM_TOKEN_TYPE = 'custom';

export default (policyContext: any): boolean => {
  const auth = policyContext?.state?.auth;
  if (!CONTENT_API_TOKEN_STRATEGIES.has(String(auth?.strategy?.name ?? ''))) return false;
  return auth?.credentials?.type === CUSTOM_TOKEN_TYPE;
};

/** Bounded diagnostics for authenticated admins; never forward raw bodies/stacks. */
export function diagnosticMessage(value: unknown, secrets: string[] = []): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let message = value;
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[redacted]');
  return message.split(/[\r\n]/, 1)[0]
    .replace(/https?:\/\/[^\s<>"']+/gi, '[upstream URL]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:password|secret|token|authorization|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/<[^>]*>/g, '')
    .slice(0, 500);
}
export function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value as string | number);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function pageDiagnostics(value: unknown, secret: string) {
  if (!Array.isArray(value)) return [];
  return value.filter((page) => page && typeof page === 'object').slice(0, 100).map((page) => ({
    path: typeof page.path === 'string' ? page.path : '',
    state: ['rendered', 'failed', 'accepted'].includes(page.state) ? page.state : 'unknown',
    generatedAt: timestamp(page.renderedAt),
    cachedHttpStatus: number(page.cachedHttpStatus),
    targetVersion: number(page.targetVersion),
    renderedVersion: number(page.renderedVersion),
    jobId: typeof page.jobId === 'string' ? page.jobId : null,
    attemptsMade: number(page.attemptsMade), maxAttempts: number(page.maxAttempts),
    lastAttemptAt: timestamp(page.lastAttemptAt), finishedAt: timestamp(page.finishedAt),
    error: diagnosticMessage(page.error, [secret]),
  }));
}

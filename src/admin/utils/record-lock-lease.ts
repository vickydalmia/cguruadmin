import { RECORD_LOCK_LEASE_HEADER } from '../../constants/record-lock';

/** RFC 4122 v4 lease id, matching the controller's LEASE_ID_PATTERN.
 * crypto.randomUUID exists only in SECURE contexts — an admin served over
 * plain http:// (LAN IP, internal staging host) or an older Safari must not
 * throw here: the call sits in the lock panel's effect, and an escaped
 * TypeError would blank the whole edit view via the error boundary. */
export const createLeaseId = (): string => {
  const cryptoApi = typeof window !== 'undefined' ? window.crypto : undefined;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
};

const CONTENT_MANAGER_PATH = '/content-manager/';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let activeLeaseId: string | null = null;
let interceptorInstalled = false;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const requestMethod = (
  input: RequestInfo | URL,
  init?: RequestInit,
): string => {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : 'GET';
};

const isContentManagerWrite = (
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean => {
  if (!WRITE_METHODS.has(requestMethod(input, init))) return false;
  try {
    return new URL(requestUrl(input), window.location.origin).pathname.includes(
      CONTENT_MANAGER_PATH,
    );
  } catch {
    return false;
  }
};

/** Install once during admin bootstrap. Strapi's fetch client delegates to the
 * native fetch at request time, so this covers Save, Publish, Unpublish and
 * Delete without replacing Strapi's document actions. */
export const installRecordLockLeaseInterceptor = (): void => {
  if (interceptorInstalled || typeof window === 'undefined') return;
  interceptorInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const leaseId = activeLeaseId;
    if (!leaseId || !isContentManagerWrite(input, init)) {
      return nativeFetch(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(RECORD_LOCK_LEASE_HEADER, leaseId);
    return nativeFetch(input, { ...init, headers });
  };
};

export const activateRecordLockLease = (leaseId: string): void => {
  activeLeaseId = leaseId;
};

/** Clear only the lease owned by the departing panel. During fast client-side
 * navigation the next panel may activate before the previous cleanup runs. */
export const clearRecordLockLease = (leaseId: string): void => {
  if (activeLeaseId === leaseId) activeLeaseId = null;
};

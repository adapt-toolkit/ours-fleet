export interface ApiErrorShape {
  code: string;
  message: string;
  provesOffline: boolean;
  retryable: boolean;
  requestId: string;
}

export class ApiClient {
  csrf = '';
  async bootstrap(): Promise<void> {
    const bootstrap = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    if (bootstrap) {
      const response = await fetch('/api/v1/auth/exchange', {
        method: 'POST',
        headers: { Authorization: `Bootstrap ${bootstrap}` },
      });
      history.replaceState(null, '', location.pathname + location.search);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? 'Authentication failed');
      this.csrf = body.csrfToken;
      return;
    }
    const response = await fetch('/api/v1/auth/session');
    if (!response.ok) throw new Error('Open the one-time URL printed by ours-fleet web.');
    this.csrf = (await response.json()).csrfToken;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const mutation = !['GET', 'HEAD'].includes(method);
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(mutation ? { 'x-csrf-token': this.csrf } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body.error as ApiErrorShape | undefined;
      throw Object.assign(new Error(error?.message ?? `Request failed (${response.status})`), { detail: error });
    }
    return body as T;
  }
  get<T>(path: string): Promise<T> { return this.request(path); }
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body), headers });
  }
}

export const api = new ApiClient();
export const idempotencyKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

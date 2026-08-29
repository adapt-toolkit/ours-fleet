export interface ApiErrorShape {
  code: string;
  message: string;
  provesOffline: boolean;
  retryable: boolean;
  requestId: string;
}

export class ApiClient {
  csrf = '';
  accessWarning = '';
  accessMode: 'pairing' | 'password' | 'none' = 'pairing';
  async bootstrap(): Promise<'authenticated' | 'password'> {
    const access: { mode?: 'pairing' | 'password' | 'none'; warning?: string } =
      await fetch('/api/v1/auth/mode').then(response => response.ok
        ? response.json() : {}).catch(() => ({}));
    this.accessWarning = access.warning ?? '';
    this.accessMode = access.mode ?? 'pairing';
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
      return 'authenticated';
    }
    const current = await fetch('/api/v1/auth/session');
    if (current.ok) {
      this.csrf = (await current.json()).csrfToken;
      return 'authenticated';
    }
    const resumed = await fetch('/api/v1/auth/resume', { method: 'POST' });
    if (resumed.ok) {
      this.csrf = (await resumed.json()).csrfToken;
      return 'authenticated';
    }
    const mode = access.mode ? access : { mode: 'pairing' };
    if (mode.mode === 'password') return 'password';
    if (mode.mode === 'none') {
      const anonymous = await fetch('/api/v1/auth/anonymous', { method: 'POST' });
      if (!anonymous.ok) throw new Error('Could not start the unprotected browser session.');
      this.csrf = (await anonymous.json()).csrfToken;
      return 'authenticated';
    }
    throw new Error('Run `ours-fleet web open` on this computer to pair this browser.');
  }
  async login(password: string): Promise<void> {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message ?? 'Authentication failed');
    this.csrf = body.csrfToken;
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
  get<T>(path: string, signal?: AbortSignal): Promise<T> { return this.request(path, { signal }); }
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body), headers });
  }
  async logout(): Promise<void> {
    await this.post('/api/v1/auth/logout', {});
    this.csrf = '';
  }
}

export const api = new ApiClient();
export type ManagementRequest = {
  version: 1; requestId: string; idempotencyKey?: string; command: Record<string, unknown>;
};
export const manage = <T>(request: ManagementRequest, key = idempotencyKey()): Promise<T> =>
  api.post<T>('/api/v1/management', request, { 'idempotency-key': key });
export const idempotencyKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

import type { FormData } from './types';

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init?.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiOrigin}/api${path}`, { ...init, headers, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof body?.detail === 'string' ? body.detail : 'Не удалось выполнить действие');
  }
  return response.json();
}

export async function downloadFloor(token: string, signal: AbortSignal) {
  const response = await fetch(`${apiOrigin}/api/floor`, {
    headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store',
  });
  if (!response.ok) throw new ApiError(response.status, 'Не удалось открыть схему');
  return response.blob();
}

export function json(method: string, data: FormData) {
  return { method, body: JSON.stringify(data) };
}

export function telegram() {
  return (window as Window & { Telegram?: { WebApp?: {
    initData: string;
    ready: () => void;
    expand: () => void;
  } } }).Telegram?.WebApp;
}

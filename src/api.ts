import { ApiError } from './api-error';
import { browserApi, browserFloor } from './browser-store';
import type { FormData } from './types';

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, '') ?? '';
const browserOnly = import.meta.env.MODE === 'pages' && !apiOrigin;
const apiRoot = (eventId?: string) => eventId ? apiOrigin + '/events/' + encodeURIComponent(eventId) + '/api' : apiOrigin + '/api';

export { ApiError };

export async function api<T>(path: string, token?: string, init?: RequestInit, eventId?: string): Promise<T> {
  if (browserOnly) return browserApi<T>(path, init, eventId);
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init?.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(apiRoot(eventId) + path, { ...init, headers, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof body?.detail === 'string' ? body.detail : 'Не удалось выполнить действие');
  }
  return response.json();
}

export async function downloadFloor(token: string, signal: AbortSignal, eventId?: string) {
  if (browserOnly) return browserFloor(eventId);
  const response = await fetch(apiRoot(eventId) + '/floor', {
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
    platform: string;
    ready: () => void;
    expand: () => void;
    sendData: (data: string) => void;
  } } }).Telegram?.WebApp;
}

let telegramScript: Promise<void> | undefined;
export function loadTelegram() {
  if (telegram()) return Promise.resolve();
  telegramScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = () => resolve();
    script.onerror = () => {
      telegramScript = undefined;
      reject(new Error('Не удалось загрузить Telegram Mini App'));
    };
    document.head.append(script);
  });
  return telegramScript;
}

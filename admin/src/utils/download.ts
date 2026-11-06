import { useCallback } from 'react';
import { useAuth } from '@strapi/strapi/admin';

/**
 * CSV downloads use `fetch` directly. Strapi's fetch client parses every body as JSON, so a
 * `text/csv` response comes back as `{}`. Reading the body as a blob also lets a JSON error be
 * shown as a message instead of being saved as a broken file.
 */

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoked on a later tick; revoking synchronously cancels the download in Safari.
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  }
}

function fileNameFrom(headers: Headers, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(headers.get('content-disposition') ?? '');
  // The server only ever sends [A-Za-z0-9._-]; anything else is ignored rather than trusted.
  const name = match?.[1]?.trim();
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : fallback;
}

function absoluteUrl(path: string): string {
  const configured = (window as { strapi?: { backendURL?: string } }).strapi?.backendURL ?? '';
  return `${configured.replace(/\/$/, '')}${path}`;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `The export failed with status ${response.status}.`;
  try {
    const parsed = JSON.parse(await response.text()) as { error?: { message?: string } };
    return parsed.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export interface DownloadResult {
  total: number;
  truncated: boolean;
}

export function useCsvDownload() {
  const token = useAuth('useCsvDownload', (state) => state.token);

  return useCallback(
    async (path: string, fallbackName: string): Promise<DownloadResult> => {
      const headers = new Headers({ Accept: 'text/csv, application/json' });
      if (token) headers.set('Authorization', `Bearer ${token}`);

      const response = await fetch(absoluteUrl(path), { method: 'GET', headers, credentials: 'include' });
      if (!response.ok) throw new Error(await errorMessage(response));

      const blob = await response.blob();
      saveBlob(blob, fileNameFrom(response.headers, fallbackName));

      return {
        total: Number(response.headers.get('x-export-total') ?? 0),
        truncated: response.headers.get('x-export-truncated') === 'true',
      };
    },
    [token]
  );
}

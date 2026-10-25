/**
 * Google Slides export: the same tables as the CSV export (exports.ts) as a deck, one title slide and one table slide
 * per table, long tables split across slides. Runs as a Google Cloud service account whose JSON key stays on this
 * machine (GOOGLE_SERVICE_ACCOUNT_FILE); the deck is shared with SLIDES_SHARE_WITH. GOOGLE_SLIDES_FOLDER_ID puts it in
 * a (shared) Drive folder instead of the service account's own Drive, which newer service accounts have no quota for.
 * No Google SDK: a signed JWT (node:crypto) buys an access token, then three REST calls.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Table } from './exports';
import { recordFallback, recordOk } from './provider-calls';

export type SlidesConfig = { clientEmail: string; privateKey: string; tokenUri: string; shareWith: string[]; folderId?: string };
export type SlidesSetup = { config: SlidesConfig } | { missing: string[] };

const SCOPES = 'https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file';
const ROWS_PER_SLIDE = 12;
const MAX_COLUMNS = 8;
/** Rows per table on slides (10 slides); the rest stays in the CSV, and one batchUpdate stays well inside Google's limits. */
const MAX_ROWS = 120;
const EMAIL = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

/** What is configured, or the settings still missing (named, never their values). */
export function slidesSetup(env: NodeJS.ProcessEnv = process.env): SlidesSetup {
  const missing: string[] = [];
  const file = env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  const shareWith = (env.SLIDES_SHARE_WITH ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!file) missing.push('GOOGLE_SERVICE_ACCOUNT_FILE (path to the service account JSON key, with the Slides and Drive APIs enabled)');
  if (!shareWith.length) missing.push('SLIDES_SHARE_WITH (the email address(es) to share decks with)');
  if (shareWith.some(e => !EMAIL.test(e))) missing.push('SLIDES_SHARE_WITH must be comma-separated email addresses');
  if (missing.length || !file) return { missing };
  let key: { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
  try {
    key = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { missing: [`GOOGLE_SERVICE_ACCOUNT_FILE could not be read as JSON (${file})`] };
  }
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') return { missing: ['the service account key file has no client_email and private_key'] };
  const tokenUri = typeof key.token_uri === 'string' && key.token_uri.startsWith('https://') ? key.token_uri : 'https://oauth2.googleapis.com/token';
  const folderId = env.GOOGLE_SLIDES_FOLDER_ID?.trim() || undefined;
  return { config: { clientEmail: key.client_email, privateKey: key.private_key, tokenUri, shareWith, ...(folderId ? { folderId } : {}) } };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** A signed service-account assertion for the token endpoint (RFC 7523). */
export function serviceAccountJwt(c: SlidesConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: c.clientEmail, scope: SCOPES, aud: c.tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(c.privateKey);
  return `${head}.${claims}.${b64url(sig)}`;
}

async function google<T>(fetcher: typeof fetch, what: string, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`Google ${what} failed before a response: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let why = '';
    try {
      why = String(JSON.parse(text)?.error?.message ?? JSON.parse(text)?.error_description ?? '');
    } catch {
      /* not JSON */
    }
    throw new Error(`Google ${what} failed (HTTP ${res.status})${why ? `: ${why.slice(0, 200)}` : ''}.`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The deck's slides as Slides API batchUpdate requests: a title slide, then each table in chunks of ROWS_PER_SLIDE. */
export function deckRequests(title: string, subtitle: string, tables: Table[], deleteSlideId?: string): unknown[] {
  const reqs: unknown[] = [
    { createSlide: { objectId: 'cafoo_title', slideLayoutReference: { predefinedLayout: 'TITLE' }, placeholderIdMappings: [
      { layoutPlaceholder: { type: 'CENTERED_TITLE' }, objectId: 'cafoo_title_t' },
      { layoutPlaceholder: { type: 'SUBTITLE' }, objectId: 'cafoo_title_s' },
    ] } },
    { insertText: { objectId: 'cafoo_title_t', text: title } },
    { insertText: { objectId: 'cafoo_title_s', text: subtitle } },
  ];
  let n = 0;
  for (const t of tables) {
    const cols = Math.min(t.header.length, MAX_COLUMNS);
    const shown = t.rows.slice(0, MAX_ROWS);
    const chunks = shown.length ? Math.ceil(shown.length / ROWS_PER_SLIDE) : 1;
    for (let k = 0; k < chunks; k++) {
      n++;
      const slide = `cafoo_s${n}`;
      const table = `cafoo_t${n}`;
      const body = shown.slice(k * ROWS_PER_SLIDE, (k + 1) * ROWS_PER_SLIDE);
      const rows = [t.header.slice(0, cols), ...(body.length ? body : [['Nothing to show.']])].map(r => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
      const left = [t.rows.length > shown.length ? `first ${shown.length} of ${t.rows.length} rows` : '', t.header.length > cols ? `first ${cols} of ${t.header.length} columns` : ''].filter(Boolean);
      const heading = `${t.title}${chunks > 1 ? ` (${k + 1} of ${chunks})` : ''}${left.length ? `; ${left.join(', ')}, all in the CSV` : ''}`;
      reqs.push(
        { createSlide: { objectId: slide, slideLayoutReference: { predefinedLayout: 'TITLE_ONLY' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE' }, objectId: `${slide}_t` }] } },
        { insertText: { objectId: `${slide}_t`, text: heading } },
        { createTable: { objectId: table, elementProperties: { pageObjectId: slide }, rows: rows.length, columns: cols } },
      );
      rows.forEach((r, rowIndex) => r.forEach((text, columnIndex) => {
        if (!text) return;
        const cellLocation = { rowIndex, columnIndex };
        reqs.push(
          { insertText: { objectId: table, cellLocation, text } },
          { updateTextStyle: { objectId: table, cellLocation, textRange: { type: 'ALL' }, style: { fontSize: { magnitude: 8, unit: 'PT' }, bold: rowIndex === 0 }, fields: 'fontSize,bold' } },
        );
      }));
    }
  }
  if (deleteSlideId) reqs.push({ deleteObject: { objectId: deleteSlideId } });
  return reqs;
}

/** Build the deck, share it, and return its link. Records the outcome for /status. */
export async function exportToSlides(c: SlidesConfig, title: string, subtitle: string, tables: Table[], fetcher: typeof fetch = fetch): Promise<{ presentationId: string; url: string }> {
  try {
    const token = await google<{ access_token: string }>(fetcher, 'sign-in', c.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(c) }).toString(),
    });
    const auth = { Authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
    let id: string;
    if (c.folderId) {
      id = (await google<{ id: string }>(fetcher, 'Drive file creation', 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST', headers: auth, body: JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.presentation', parents: [c.folderId] }),
      })).id;
    } else {
      id = (await google<{ presentationId: string }>(fetcher, 'Slides creation', 'https://slides.googleapis.com/v1/presentations', { method: 'POST', headers: auth, body: JSON.stringify({ title }) })).presentationId;
    }
    // Share first: if filling fails, the person still has the deck rather than an orphan in the service account's Drive.
    for (const emailAddress of c.shareWith) {
      await google(fetcher, 'Drive sharing', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
        method: 'POST', headers: auth, body: JSON.stringify({ type: 'user', role: 'writer', emailAddress }),
      });
    }
    const deck = await google<{ slides?: { objectId: string }[] }>(fetcher, 'Slides read', `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(id)}?fields=slides.objectId`, { method: 'GET', headers: auth });
    await google(fetcher, 'Slides update', `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(id)}:batchUpdate`, {
      method: 'POST', headers: auth, body: JSON.stringify({ requests: deckRequests(title, subtitle, tables, deck.slides?.[0]?.objectId) }),
    });
    recordOk('slides');
    return { presentationId: id, url: `https://docs.google.com/presentation/d/${id}/edit` };
  } catch (e) {
    recordFallback('slides', e);
    throw e;
  }
}

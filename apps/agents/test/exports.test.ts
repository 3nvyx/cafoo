import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { decimal, exportTables, toCsv, type Table } from '../src/exports';
import { deckRequests, exportToSlides, serviceAccountJwt, slidesSetup, type SlidesConfig } from '../src/slides';
import { exportRoutes } from '../src/export-routes';
import { createGateway } from '../src/gateway';
import { evidence, resetProviderCalls } from '../src/provider-calls';
import type { Cast } from '../src/stdb';
import { fakeConn, ts } from './fake-conn';

const acct = (id: bigint, code: string, tag: string, name = code) => ({ id, subsidiaryId: 1n, code, name, accountType: { tag }, isIntercompany: false });
const rows = () => ({
  subsidiary: [{ id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false }],
  period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }],
  setting: [],
  account: [acct(10n, '4000', 'Revenue', 'Subscription revenue'), acct(12n, '1100', 'Asset', 'Accounts receivable')],
  journalEntry: [{ id: 101n, subsidiaryId: 1n, periodId: 2n, postedAt: ts('2026-09-30T12:00:00Z'), memo: 'Usage revenue', source: { tag: 'Agent' }, proposalId: 7n, postedByRole: 'advisor' }],
  journalLine: [
    { id: 1n, jeId: 101n, accountId: 12n, accountCode: '1100', debitMinor: 123456n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n, customerId: 4n, memo: '=HYPERLINK("x")' },
    { id: 2n, jeId: 101n, accountId: 10n, accountCode: '4000', debitMinor: 0n, creditMinor: 123456n, ccy: 'USD', fxRateE6: 1000000n, memo: 'Usage, "metered"' },
  ],
  proposal: [
    { id: 7n, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'AwaitingCfo' }, proposerRole: 'revenue', summaryPlain: 'Record $1,234.56 of usage revenue.', amountMinor: 123456n, createdAt: ts('2026-10-01T00:00:00Z') },
    { id: 8n, periodId: 2n, kind: { tag: 'BankMatch' }, status: { tag: 'Approved' }, proposerRole: 'bookkeeper', summaryPlain: 'x', amountMinor: 0n, createdAt: ts('2026-10-01T00:00:00Z') },
  ],
});
const cast = () => ({ advisor: fakeConn(rows()) }) as unknown as Cast;

describe('export tables', () => {
  it('writes amounts as two-place decimals with the sign first', () => {
    expect([decimal(123456n), decimal(-5n), decimal(0n)]).toEqual(['1234.56', '-0.05', '0.00']);
  });

  it('lists the month’s ledger lines with the slide columns first', () => {
    const [t] = exportTables(cast().advisor, 'ledger', '2026-09');
    expect(t!.header.slice(0, 8)).toEqual(['Entry', 'Posted', 'Company', 'Account', 'Memo', 'Debit', 'Credit', 'Currency']);
    expect(t!.rows.map(r => r.slice(0, 8))).toEqual([
      ['101', '2026-09-30', 'Cafoo Inc', '1100', '=HYPERLINK("x")', '1234.56', '0.00', 'USD'],
      ['101', '2026-09-30', 'Cafoo Inc', '4000', 'Usage, "metered"', '0.00', '1234.56', 'USD'],
    ]);
    expect(() => exportTables(cast().advisor, 'ledger', '2026-11')).toThrow('There is no 2026-11 period');
  });

  it('builds the Board Pack from the consolidation engine, debits and credits balancing to the posted figures', () => {
    const [pnl, bs] = exportTables(cast().advisor, 'board-pack', '2026-09');
    expect(pnl!.header).toEqual(['Code', 'Account', 'Cafoo Inc', 'Eliminations', 'Group (USD)']);
    expect(pnl!.rows.at(-1)).toEqual(['', 'Net income', '1234.56', '', '1234.56']);
    expect(bs!.rows.find(r => r[0] === '1100')?.at(-1)).toBe('1234.56');
    expect(bs!.rows.at(-1)?.[1]).toBe('Cumulative translation adjustment (computed)');
  });

  it('lists only what waits for the CFO', () => {
    const [t] = exportTables(cast().advisor, 'cfo-queue', '2026-09');
    expect(t!.rows).toEqual([['7', '2026-09', 'JournalEntry', 'revenue', 'Record $1,234.56 of usage revenue.', '1234.56', '2026-10-01']]);
  });
});

describe('CSV', () => {
  it('quotes per RFC 4180 and defuses formulas, but leaves negative numbers as numbers', () => {
    const t: Table = { title: 'T', header: ['a', 'b'], rows: [['=1+1', 'say "hi", ok'], ['-12.50', '@SUM(A1)'], ['- note', 'plain']] };
    expect(toCsv([t])).toBe("a,b\r\n'=1+1,\"say \"\"hi\"\", ok\"\r\n-12.50,'@SUM(A1)\r\n'- note,plain\r\n");
    expect(toCsv([t, { ...t, title: 'U', rows: [] }])).toMatch(/^T\r\na,b\r\n[\s\S]*\r\n\r\nU\r\na,b\r\n$/);
  });
});

describe('Google Slides export', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const config: SlidesConfig = { clientEmail: 'cafoo@proj.iam.gserviceaccount.com', privateKey, tokenUri: 'https://oauth2.googleapis.com/token', shareWith: ['cfo@example.com'] };
  beforeEach(() => resetProviderCalls());

  it('names what is missing, never the values', () => {
    expect(slidesSetup({})).toEqual({ missing: [expect.stringMatching(/^GOOGLE_SERVICE_ACCOUNT_FILE/), expect.stringMatching(/^SLIDES_SHARE_WITH/)] });
    expect(slidesSetup({ GOOGLE_SERVICE_ACCOUNT_FILE: '/nope.json', SLIDES_SHARE_WITH: 'not-an-email' })).toEqual({ missing: ['SLIDES_SHARE_WITH must be comma-separated email addresses'] });
    const dir = mkdtempSync(join(tmpdir(), 'cafoo-sa-'));
    writeFileSync(join(dir, 'sa.json'), JSON.stringify({ client_email: config.clientEmail, private_key: privateKey }));
    expect(slidesSetup({ GOOGLE_SERVICE_ACCOUNT_FILE: join(dir, 'sa.json'), SLIDES_SHARE_WITH: 'a@b.co, c@d.co' })).toMatchObject({ config: { clientEmail: config.clientEmail, shareWith: ['a@b.co', 'c@d.co'] } });
  });

  it('signs an RS256 service-account assertion for the Slides and Drive scopes', () => {
    const jwt = serviceAccountJwt(config, 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file', aud: config.tokenUri, iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('splits long tables across slides and caps the columns, saying so in the heading', () => {
    const wide: Table = { title: 'Ledger, 2026-09', header: Array.from({ length: 15 }, (_, i) => `c${i}`), rows: Array.from({ length: 25 }, (_, i) => Array.from({ length: 15 }, () => `${i}`)) };
    const reqs = deckRequests('Deck', 'sub', [wide], 'p') as Record<string, any>[];
    const tables = reqs.filter(r => r.createTable).map(r => r.createTable);
    expect(tables.map(t => [t.rows, t.columns])).toEqual([[13, 8], [13, 8], [2, 8]]);
    expect(reqs.filter(r => r.insertText?.objectId?.endsWith('_t') && r.insertText.objectId.startsWith('cafoo_s')).map(r => r.insertText.text)).toEqual([
      'Ledger, 2026-09 (1 of 3); first 8 of 15 columns, all in the CSV', 'Ledger, 2026-09 (2 of 3); first 8 of 15 columns, all in the CSV', 'Ledger, 2026-09 (3 of 3); first 8 of 15 columns, all in the CSV',
    ]);
    expect(reqs.at(-1)).toEqual({ deleteObject: { objectId: 'p' } });
    // Past 120 rows the deck stops and says the rest is in the CSV.
    const long = deckRequests('Deck', 'sub', [{ ...wide, rows: Array.from({ length: 300 }, () => ['x']) }]) as Record<string, any>[];
    expect(long.filter(r => r.createTable)).toHaveLength(10);
    expect(long.find(r => r.insertText?.objectId === 'cafoo_s1_t').insertText.text).toBe('Ledger, 2026-09 (1 of 10); first 120 of 300 rows, first 8 of 15 columns, all in the CSV');
  });

  it('signs in, creates the deck, shares it, fills it, and records the export', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (String(url).startsWith('https://oauth2')) return new Response(JSON.stringify({ access_token: 'at' }));
      if (String(url).endsWith('/v1/presentations')) return new Response(JSON.stringify({ presentationId: 'deck1' }));
      if (init?.method === 'GET') return new Response(JSON.stringify({ slides: [{ objectId: 'p' }] }));
      return new Response('{}');
    });
    const out = await exportToSlides(config, 'Cafoo Board Pack, 2026-09', 'sub', [{ title: 'T', header: ['a'], rows: [['1']] }], fetcher as unknown as typeof fetch);
    expect(out).toEqual({ presentationId: 'deck1', url: 'https://docs.google.com/presentation/d/deck1/edit' });
    expect(calls).toEqual([
      'POST https://oauth2.googleapis.com/token',
      'POST https://slides.googleapis.com/v1/presentations',
      // Shared before it is filled, so a failed fill never leaves an orphan deck.
      'POST https://www.googleapis.com/drive/v3/files/deck1/permissions?sendNotificationEmail=false&supportsAllDrives=true',
      'GET https://slides.googleapis.com/v1/presentations/deck1?fields=slides.objectId',
      'POST https://slides.googleapis.com/v1/presentations/deck1:batchUpdate',
    ]);
    expect(evidence('slides').okCount).toBe(1);
  });

  it('reports Google’s reason on failure and records the fallback', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Slides API has not been used in project 1' } }), { status: 403 }));
    await expect(exportToSlides(config, 't', 's', [], fetcher as unknown as typeof fetch)).rejects.toThrow('Google sign-in failed (HTTP 403): Slides API has not been used in project 1.');
    expect(evidence('slides').fallbackCount).toBe(1);
  });
});

describe('export routes', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));
  const start = async (isLocal = true, env: NodeJS.ProcessEnv = {}) => {
    server = createGateway({} as Cast, { runClose: vi.fn(), env: {}, isLocal: () => isLocal, routes: exportRoutes(cast(), env) });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it('downloads the CSV from this machine', async () => {
    const r = await fetch(`${await start()}/export/csv?dataset=cfo-queue&period=2026-09`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="cafoo-cfo-queue-2026-09.csv"');
    expect(await r.text()).toMatch(/^Proposal,Period,Kind,Proposed by,Summary,Amount,Proposed\r\n7,2026-09,JournalEntry,revenue,"Record \$1,234.56 of usage revenue.",1234.56,2026-10-01\r\n$/);
  });

  it('refuses another machine without the key, and a bad dataset', async () => {
    expect((await fetch(`${await start(false)}/export/csv?dataset=ledger&period=2026-09`)).status).toBe(403);
    await new Promise<void>(r => server!.close(() => r()));
    const base = await start();
    expect((await fetch(`${base}/export/csv?dataset=salaries&period=2026-09`)).status).toBe(400);
  });

  it('explains what Slides needs when it is not set up', async () => {
    const r = await fetch(`${await start()}/export/slides`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: 'board-pack', period: '2026-09' }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining('CSV export works without it'), missing: [expect.stringMatching(/^GOOGLE_SERVICE_ACCOUNT_FILE/), expect.stringMatching(/^SLIDES_SHARE_WITH/)] });
  });
});

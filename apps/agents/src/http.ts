/**
 * Shared HTTP pieces of the gateway, so other modules (charter routes, feed routes) can add routes that pass the same
 * guards. createGateway (src/gateway.ts) checks every request before any route runs: an allowlisted Host header (DNS
 * rebinding), no foreign Origin on a preflight or a POST, a JSON content type on every POST, and a body of at most
 * MAX_BODY_BYTES. A route that changes state (every POST unless it says otherwise) runs only from this machine or with
 * the gateway API key; the gateway answers 401/403 before the handler is called.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest request body the gateway reads; a chat history or a close request is far smaller. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Thrown by a handler (or readJson) for a malformed request: the gateway answers 400 with the message. */
export class BadRequest extends Error {}
/** Thrown by readJson for a body over MAX_BODY_BYTES: the gateway answers 413 and closes the connection. */
export class TooLarge extends Error {}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** The pattern's capture groups, in order (decoded with decodeURIComponent). */
  params: string[];
  url: URL;
  /** Whether this request may change state (from this machine, or with the gateway API key). */
  mayChangeState: boolean;
}

export interface Route {
  method: 'GET' | 'POST';
  /** Matched against the URL path only (no query string); anchor it (^…$). */
  pattern: RegExp;
  /**
   * Does the route change state (start work, write to the books, toggle something)? Defaults to true for POST and
   * false for GET. When true, the gateway refuses the request unless it comes from this machine or carries the
   * gateway API key, before the handler runs.
   */
  changesState?: boolean;
  handle(ctx: RouteContext): Promise<void> | void;
}

/**
 * Write a JSON response. The gateway has already set the request's CORS headers on `res` (they merge with these), so a
 * route answers browsers on allowlisted origins without doing anything else. 204 sends no body.
 */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(status === 204 ? undefined : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Read a POST body as a JSON object ({} when empty). Throws BadRequest (not JSON, not an object) or TooLarge. */
export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new TooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Keep draining so the response can still be written, but stop keeping the bytes.
    if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new TooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest('request body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('request body must be a JSON object');
  return body as Record<string, any>;
}

/** The first route whose method and pattern match, with its decoded capture groups. */
export function matchRoute(routes: readonly Route[], method: string | undefined, pathname: string): { route: Route; params: string[] } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    try {
      return { route, params: m.slice(1).map(p => (p === undefined ? '' : decodeURIComponent(p))) };
    } catch {
      throw new BadRequest('malformed path');
    }
  }
  return undefined;
}

/** Does this route change state? Explicit flag, else POST does and GET does not. */
export const changesState = (route: Route) => route.changesState ?? route.method === 'POST';

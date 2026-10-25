// Every area's upload handlers and live tickers, in one registry for the mock data source.
import * as books from './books';
import * as costs from './costs';
import * as crm from './crm';
import * as financing from './financing';
import * as people from './people';
import type { LiveTicker, UploadHandler } from './types';

export const HANDLERS: UploadHandler[] = [...books.handlers, ...financing.handlers, ...people.handlers, ...costs.handlers, ...crm.handlers];
export const TICKERS: LiveTicker[] = [...books.tickers, ...financing.tickers, ...people.tickers, ...costs.tickers, ...crm.tickers];

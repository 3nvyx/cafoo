// Export actions. Against the live backend the agent gateway builds the file (GET /export/csv, POST /export/slides); in
// Demo mode the CSV is built in the browser from the rows on screen and Google Slides is unavailable.
import { PUBLIC_AGENT_GATEWAY } from '$app/env/public';
import { db } from './data/index.js';
import { saveFile, toCsv, type CsvTable } from './csv.js';

export type Dataset = 'ledger' | 'board-pack' | 'cfo-queue';

/** True when the app runs against the live backend, so the gateway can build exports. */
export const hasBackend = () => db.kind === 'live';

const base = () => PUBLIC_AGENT_GATEWAY.replace(/\/+$/, '');
const offline = 'The agent gateway is not reachable. Start it, then try again.';

async function failure(res: Response, fallback: string): Promise<Error> {
	try {
		const body = (await res.json()) as { error?: string; missing?: string[] };
		const missing = body.missing?.length ? ` Missing: ${body.missing.join(', ')}.` : '';
		return new Error(`${body.error ?? fallback}${missing}`);
	} catch {
		return new Error(fallback);
	}
}

/** Download the month's CSV: from the gateway when live, otherwise built from `tables` (the rows shown on screen). */
export async function downloadCsv(dataset: Dataset, period: string, tables: () => CsvTable[]): Promise<void> {
	const filename = `cafoo-${dataset}-${period}.csv`;
	if (!hasBackend()) {
		saveFile(filename, new Blob([toCsv(tables())], { type: 'text/csv;charset=utf-8' }));
		return;
	}
	let res: Response;
	try {
		res = await fetch(`${base()}/export/csv?dataset=${encodeURIComponent(dataset)}&period=${encodeURIComponent(period)}`);
	} catch {
		throw new Error(offline);
	}
	if (!res.ok) throw await failure(res, `The export failed (${res.status}).`);
	saveFile(filename, await res.blob());
}

/** Build the month as a Google Slides deck on the gateway and return its link. Live backend only. */
export async function exportSlides(dataset: Dataset, period: string): Promise<string> {
	if (!hasBackend()) throw new Error('Google Slides export needs the live backend. Demo mode can download a CSV.');
	let res: Response;
	try {
		res = await fetch(`${base()}/export/slides`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset, period }) });
	} catch {
		throw new Error(offline);
	}
	if (!res.ok) throw await failure(res, `The Slides export failed (${res.status}).`);
	const body = (await res.json()) as { url?: string };
	if (!body.url) throw new Error('The gateway built the deck but sent no link.');
	return body.url;
}

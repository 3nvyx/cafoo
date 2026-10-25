// What the agent gateway's live-close log means for the CFO. The gateway reports each close as a list of step
// strings (apps/agents/src/live/orchestrator.ts); a few of them change what the CFO should do next, so they are
// turned into notices here. Everything else stays in the expert "Close log".

export interface CloseRun {
	status: 'running' | 'done' | 'error';
	steps?: string[];
	error?: string;
}

export interface CloseRunNote {
	tone: 'warn' | 'neg';
	title: string;
	body: string;
	href?: string;
	action?: string;
}

const ADVISOR_FAILED = /^Advisor run failed: (.*?); applying standard rulings to remaining proposals\s*$/i;
const WAIT_LIMIT = /CFO wait limit reached|revenue schedules still wait for the CFO/i;
const BUDGET = /close budget of (\$[\d,.]+) is spent \((\$[\d,.]+)\)/i;

/** Plain-English notices for one close run, in the order they first appear, without repeats. */
export function closeRunNotes(close: CloseRun | undefined): CloseRunNote[] {
	if (!close) return [];
	const notes: CloseRunNote[] = [];
	const seen = new Set<string>();
	const add = (key: string, note: CloseRunNote) => {
		if (seen.has(key)) return;
		seen.add(key);
		notes.push(note);
	};

	for (const step of close.steps ?? []) {
		const failed = ADVISOR_FAILED.exec(step);
		if (failed) {
			const why = failed[1].trim();
			add('advisor', {
				tone: 'warn',
				title: 'The Advisor was unavailable for part of this close',
				body: `Standard rulings were applied to the remaining proposals instead.${why ? ` The reason given: “${why}”.` : ''}`
			});
			continue;
		}
		if (WAIT_LIMIT.test(step)) {
			add('wait', {
				tone: 'warn',
				title: 'Revenue catch-up is waiting on your decision',
				body: 'The agents stopped waiting for your decision on the revenue schedules, so the revenue catch-up has not posted yet.',
				href: '/proposals',
				action: 'Decide the schedules'
			});
			continue;
		}
		const budget = BUDGET.exec(step);
		if (budget) {
			add('budget', {
				tone: 'warn',
				title: 'The close budget is spent',
				body: `This close used ${budget[2]} against a budget of ${budget[1]}, so the Advisor made no further runs.`
			});
		}
	}

	if (close.status === 'error') {
		add('error', { tone: 'neg', title: 'The close stopped with an error', body: close.error?.trim() || 'No reason was reported.' });
	}
	return notes;
}

/** The latest step as one short plain line ("Advisor: …", "A worker agent: …", "Using <tool>"), if there is one. */
export function latestStep(close: CloseRun | undefined): string | undefined {
	const raw = close?.steps?.at(-1)?.replace(/\s+/g, ' ').trim();
	if (!raw) return undefined;
	let m: RegExpExecArray | null;
	if ((m = /^advisor:\s*(.*)$/i.exec(raw))) return m[1] ? `Advisor: ${m[1]}` : 'The Advisor is working';
	if ((m = /^agent:\s*(.*)$/i.exec(raw))) return m[1] ? `A worker agent: ${m[1]}` : 'A worker agent is working';
	if ((m = /^tool\s+(\S+)/i.exec(raw))) return `Using ${m[1].replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')}`;
	return raw.charAt(0).toUpperCase() + raw.slice(1);
}

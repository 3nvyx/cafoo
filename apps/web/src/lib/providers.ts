// What the Settings page may honestly say about each outside connection. A key being present selects the live
// path; it proves nothing about calls succeeding. Only the ledger and the agent gateway are spoken to by this
// browser, so only they can be called Connected.
import type { ConnectionState } from './data/source';
import type { ProviderStatus } from './data/types';

export interface ProviderState {
	label: string;
	tone: 'muted' | 'neutral' | 'pos';
	/** One plain sentence on what the label means for this provider. */
	hint: string;
}

const LEDGER_HINT: Record<ConnectionState['ledger'], string> = {
	live: 'This browser is subscribed to the ledger database',
	connecting: 'This browser is still connecting to the ledger database',
	offline: 'This browser could not reach the ledger database',
	demo: 'This browser is not connected to a ledger database'
};

const AGENTS_HINT: Record<ConnectionState['agents'], string> = {
	online: 'The gateway answered /status in this session',
	offline: 'The gateway did not answer /status in this session',
	unknown: 'The gateway has not answered /status yet in this session'
};

export function providerState(p: ProviderStatus, conn: Pick<ConnectionState, 'ledger' | 'agents'>): ProviderState {
	if (p.mode === 'demo') return { label: 'Demo', tone: 'muted', hint: 'Replays recorded fixtures' };
	if (p.id === 'ledger') {
		if (conn.ledger === 'live') return { label: 'Connected', tone: 'pos', hint: LEDGER_HINT.live };
		return { label: conn.ledger === 'connecting' ? 'Connecting' : 'Unreachable', tone: 'neutral', hint: LEDGER_HINT[conn.ledger] };
	}
	if (p.id === 'agents') {
		if (conn.agents === 'online') return { label: 'Connected', tone: 'pos', hint: AGENTS_HINT.online };
		return { label: conn.agents === 'unknown' ? 'Not checked' : 'Unreachable', tone: 'neutral', hint: AGENTS_HINT[conn.agents] };
	}
	return { label: 'Configured', tone: 'neutral', hint: 'A key is present and the live path is selected; this does not prove a call succeeded' };
}

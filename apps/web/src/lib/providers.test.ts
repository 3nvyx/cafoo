import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from './data/types';
import { providerState } from './providers';

const provider = (id: string, mode: ProviderStatus['mode']): ProviderStatus => ({ id, name: id, purpose: '', mode, detail: '' });
const up = { ledger: 'live', agents: 'online' } as const;

describe('provider state on Settings', () => {
	it('calls every demo provider Demo, even the ledger', () => {
		for (const id of ['ledger', 'agents', 'bank-feed']) {
			expect(providerState(provider(id, 'demo'), up)).toMatchObject({ label: 'Demo', tone: 'muted' });
		}
	});

	it('calls the ledger and the gateway Connected only when this session reached them', () => {
		expect(providerState(provider('ledger', 'live'), up)).toMatchObject({ label: 'Connected', tone: 'pos' });
		expect(providerState(provider('agents', 'live'), up)).toMatchObject({ label: 'Connected', tone: 'pos' });
		expect(providerState(provider('ledger', 'live'), { ...up, ledger: 'offline' })).toMatchObject({ label: 'Unreachable', tone: 'neutral' });
		expect(providerState(provider('agents', 'live'), { ...up, agents: 'offline' })).toMatchObject({ label: 'Unreachable', tone: 'neutral' });
	});

	it('does not call a ledger that is still connecting, or a gateway not yet asked, unreachable', () => {
		expect(providerState(provider('ledger', 'live'), { ...up, ledger: 'connecting' })).toMatchObject({ label: 'Connecting', tone: 'neutral' });
		expect(providerState(provider('agents', 'live'), { ...up, agents: 'unknown' })).toMatchObject({ label: 'Not checked', tone: 'neutral' });
	});

	it('calls a feature the gateway has not built Not available, not Demo', () => {
		expect(providerState({ ...provider('gw-4', 'demo'), detail: 'crawl not implemented' }, up)).toMatchObject({ label: 'Not available', tone: 'muted' });
	});

	it('never calls a gateway-reported provider Connected: a key proves nothing about calls', () => {
		const state = providerState(provider('gw-0', 'live'), up);
		expect(state).toMatchObject({ label: 'Configured', tone: 'neutral' });
		expect(state.hint).toMatch(/does not prove/);
	});
});

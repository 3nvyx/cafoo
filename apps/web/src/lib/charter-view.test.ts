import { describe, expect, it } from 'vitest';
import { CHARTER_ROLES } from './charter';
import { BUNDLED_CATALOG, builtinBody, charterView, toolGroups } from './charter-view';

describe('Charters page view', () => {
	it('reads every built-in Charter into non-empty sections', () => {
		for (const role of CHARTER_ROLES) {
			const v = charterView(builtinBody(null, role).bodyMd);
			expect(v.intro.length, role).toBeGreaterThan(40);
			expect(v.mustNever.length, role).toBeGreaterThan(0);
			expect(v.plain.length, role).toBeGreaterThan(10);
		}
		const bk = charterView(builtinBody(null, 'bookkeeper').bodyMd);
		expect(bk.may[0]).toEqual({ label: 'May 1', text: 'You may propose bank matches, journal entries and accruals, and nothing else.' });
		expect(bk.escalates).toHaveLength(3);
		expect(bk.intro).toMatch(/^You are the Bookkeeper/);
	});

	it('groups Credit & Risk tools by source with the CRS cascade, from the bundled copy when the gateway has none', () => {
		const { groups, bundled } = toolGroups(null, 'credit');
		expect(bundled).toBe(true);
		expect(groups.map((g) => g.source)).toEqual(['ledger', 'engine', 'crs', 'brightdata', 'apify', 'moss', 'agent_sdk']);
		const crs = groups.find((g) => g.source === 'crs')!;
		expect(crs.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['crs_cascade', 'crs_identity_verify', 'crs_fraud_score', 'crs_credit_report', 'crs_public_records', 'run_credit_cascade']));
	});

	it('prefers the live catalog and shows the Bookkeeper services', () => {
		const live = { ...BUNDLED_CATALOG, tools: { sources: BUNDLED_CATALOG.tools!.sources, byRole: { bookkeeper: [{ name: 'x', source: 'ledger' as const, description: 'd', kind: 'tool' as const }] } } };
		expect(toolGroups(live, 'bookkeeper')).toEqual({ bundled: false, groups: [{ source: 'ledger', label: 'Ledger reducers (SpacetimeDB)', tools: live.tools.byRole.bookkeeper }] });
		const bk = toolGroups(null, 'bookkeeper').groups;
		expect(bk.find((g) => g.source === 'nessie')?.tools[0]?.kind).toBe('service');
	});
});

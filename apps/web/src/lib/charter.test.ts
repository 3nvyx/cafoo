// The Charter editor's helpers, against the gateway's catalog as Demo mode keeps it (mock/seed/charters.json) and the
// eval harness's own line parser.
import { describe, expect, it } from 'vitest';
import { charterLines } from '../../../../packages/eval-harness/src/charter';
import catalogJson from './data/mock/seed/charters.json';
import { editorProblems, latestEval, parseCharterLines, publishable, remap, templatesFor } from './charter';
import type { CharterCatalog, CharterEval, CharterVersion } from './data/types';

const catalog = catalogJson as unknown as CharterCatalog;
const book = catalog.builtin.bookkeeper!;
const NINETY = 'You may propose many matches in one batch only when every match in it is at least ninety percent confident; propose each less certain match on its own so it gets its own ruling.';
const ninetyBody = book.bodyMd.replace(/^2\. You may propose many matches.*$/m, `2. ${NINETY}`);

describe('parseCharterLines', () => {
	it('reads every Built-in Charter exactly as the eval harness does', () => {
		for (const [role, b] of Object.entries(catalog.builtin)) expect(parseCharterLines(b.bodyMd), role).toEqual(charterLines(b.bodyMd));
	});

	it('squashes the Plain summary rule into one last line and ignores other headings', () => {
		const md = '# T\n\nIntro.\n\n## May\n\n1.  You  may\n   wrap.\n2. Two.\n\n## Notes\n\n3. Ignored.\n\n## Plain summary rule\n\nOne\nsentence.';
		expect(parseCharterLines(md)).toEqual(charterLines(md));
		expect(parseCharterLines(md).at(-1)).toEqual({ label: 'Plain summary', text: 'One sentence.' });
	});
});

describe('editorProblems', () => {
	it('passes the Built-in Charter with its default mapping', () => {
		expect(editorProblems(catalog, 'bookkeeper', book.bodyMd, book.mapping)).toEqual([]);
	});

	it('passes the ninety percent example: May 2 tightened with batch_min_confidence at 9000', () => {
		const mapping = remap(catalog, 'bookkeeper', ninetyBody, book.mapping).map((e) =>
			e.label === 'May 2' ? { ...e, target: { kind: 'rule' as const, template: 'batch_min_confidence', params: { minScoreBp: 9000 } } } : e
		);
		expect(mapping.find((e) => e.label === 'May 2')!.text).toBe(NINETY);
		expect(editorProblems(catalog, 'bookkeeper', ninetyBody, mapping)).toEqual([]);
	});

	it('refuses a batch threshold below the shipped seventy-five percent', () => {
		const mapping = book.mapping.map((e) => (e.label === 'May 2' ? { ...e, target: { kind: 'rule' as const, template: 'batch_min_confidence', params: { minScoreBp: 7000 } } } : e));
		expect(editorProblems(catalog, 'bookkeeper', book.bodyMd, mapping)).toEqual(['May 2: lowest confidence allowed in a batch must be at least 75%.']);
	});

	it('refuses removing a shipped line or moving it off its rule', () => {
		const without = book.bodyMd.replace(/^3\. You may look up.*\n/m, '');
		expect(editorProblems(catalog, 'bookkeeper', without, remap(catalog, 'bookkeeper', without, book.mapping))).toContain(
			'May 3 is a shipped line; you may reword it but not remove it, because a custom Charter can only make the gate stricter.'
		);
		const moved = book.mapping.map((e) => (e.label === 'May 1' ? { ...e, target: { kind: 'rule' as const, template: 'max_proposal_amount', params: { maxMinor: '100' } } } : e));
		expect(editorProblems(catalog, 'bookkeeper', book.bodyMd, moved)).toContain('May 1 keeps its shipped rule, or a template that tightens it.');
	});

	it('maps an added line to a new rule, never a shipped one', () => {
		const body = book.bodyMd.replace('## Must never', '4. You may ask the CFO a question in the close thread.\n\n## Must never');
		const mapping = remap(catalog, 'bookkeeper', body, book.mapping);
		const added = mapping.find((e) => e.label === 'May 4')!;
		expect(added.target).toMatchObject({ kind: 'rule' });
		expect(added.target.kind === 'rule' && added.target.template.startsWith('builtin:')).toBe(false);
		expect(editorProblems(catalog, 'bookkeeper', body, mapping)).toEqual([]);
		const shippedRule = mapping.map((e) => (e.label === 'May 4' ? { ...e, target: { kind: 'rule' as const, template: 'builtin:bookkeeper.may.1' } } : e));
		expect(editorProblems(catalog, 'bookkeeper', body, shippedRule)).toContain('May 4 is a new line; shipped rules stay on their own lines.');
	});
});

describe('templatesFor', () => {
	it('offers a shipped rule line its own rule and the templates that tighten it', () => {
		expect(templatesFor(catalog, 'bookkeeper', 'May 2').map((t) => t.id)).toEqual(['builtin:bookkeeper.may.2', 'batch_min_confidence']);
		expect(templatesFor(catalog, 'consolidation', 'Escalates 1').map((t) => t.id)).toEqual(['builtin:consolidation.escalates.1', 'ic_difference_tolerance']);
	});

	it('gives the Red Team no worker templates on a new line', () => {
		expect(templatesFor(catalog, 'redteam', 'May 9')).toEqual([]);
	});
});

describe('publishable', () => {
	const v: CharterVersion = { id: '7', role: 'bookkeeper', version: 2, status: 'draft', bodyMd: '', mappingJson: '[]', summaryPlain: '', authoredByRole: 'cfo', createdAt: '2026-10-24T10:00:00Z' };
	const ev = (id: string, mode: CharterEval['mode'], passed: boolean, ranAt: string): CharterEval => ({ id, charterVersionId: '7', passed, mode, resultsJson: '{}', summaryPlain: '', ranByRole: 'advisor', ranAt });

	it('needs the latest eval to be a passing full eval', () => {
		expect(publishable(v, [])).toBe(false);
		expect(publishable(v, [ev('1', 'snapshot', true, '2026-10-24T10:01:00Z')])).toBe(false);
		expect(publishable(v, [ev('1', 'dry_run', true, '2026-10-24T10:01:00Z')])).toBe(true);
		// A later quick check replaces the full eval as the latest, as the module reads it.
		expect(publishable(v, [ev('1', 'dry_run', true, '2026-10-24T10:01:00Z'), ev('2', 'snapshot', true, '2026-10-24T10:02:00Z')])).toBe(false);
		expect(publishable(v, [ev('9', 'dry_run', false, '2026-10-24T10:03:00Z'), ev('10', 'dry_run', true, '2026-10-24T10:03:00Z')])).toBe(true);
		expect(publishable({ ...v, status: 'live' }, [ev('1', 'dry_run', true, '2026-10-24T10:01:00Z')])).toBe(false);
	});

	it('picks the latest eval by time, then id', () => {
		expect(latestEval([ev('9', 'dry_run', false, '2026-10-24T10:03:00Z'), ev('10', 'snapshot', true, '2026-10-24T10:03:00Z')], '7')?.id).toBe('10');
	});
});

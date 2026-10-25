import { describe, expect, it } from 'vitest';
import { company } from './map';

describe('company records', () => {
	it('groups rows by kind in id order', () => {
		const c = company([
			{ id: 2n, kind: 'employee', json: '{"id":"e2"}' },
			{ id: 1n, kind: 'employee', json: '{"id":"e1"}' },
			{ id: 3n, kind: 'deal', json: '{"id":"d1"}' }
		]);
		expect(c.employee.map((e) => e.id)).toEqual(['e1', 'e2']);
		expect(c.deal).toHaveLength(1);
		expect(c.batch).toEqual([]);
	});

	it('skips unknown kinds, broken JSON and non-objects', () => {
		const c = company([
			{ id: 1n, kind: 'nope', json: '{"id":"x"}' },
			{ id: 2n, kind: 'employee', json: '{broken' },
			{ id: 3n, kind: 'employee', json: '[1,2]' },
			{ id: 4n, kind: 'constructor', json: '{"id":"y"}' }
		]);
		expect(c.employee).toEqual([]);
		expect(Object.values(c).every((rows) => rows.length === 0)).toBe(true);
	});
});

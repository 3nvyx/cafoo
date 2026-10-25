import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODES, PACKAGE_ROOT, contrastRatio, loadTokens, resolveValue, toHex } from '../scripts/tokens.mjs';

interface Pair { fg: string; bg: string; min: number; why: string }
const { pairs } = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'contrast.json'), 'utf8')) as { pairs: Pair[] };
const tokens = loadTokens();

const semanticId = (name: string) => (name.startsWith('role-') ? `role.${name.slice(5)}` : `color.${name}`);

describe('contrast.json', () => {
	it('lists at least the pairs that matter most', () => {
		const keys = new Set(pairs.map((p) => `${p.fg}/${p.bg}`));
		for (const must of ['ink/canvas', 'on-accent/accent', 'accent-ink/canvas', 'on-neg-soft/neg-soft', 'focus/canvas']) {
			expect(keys.has(must), must).toBe(true);
		}
	});

	for (const mode of MODES) {
		describe(`${mode} mode`, () => {
			for (const pair of pairs) {
				it(`${pair.fg} on ${pair.bg} ≥ ${pair.min}:1 (${pair.why})`, () => {
					const fg = toHex(resolveValue(tokens, semanticId(pair.fg), mode), pair.fg);
					const bg = toHex(resolveValue(tokens, semanticId(pair.bg), mode), pair.bg);
					const ratio = contrastRatio(fg, bg);
					expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
				});
			}
		});
	}
});

import { readFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { beforeAll, describe, expect, it } from 'vitest';
import { CSS_FILE } from '../scripts/build.mjs';
import { PACKAGE_ROOT } from '../scripts/tokens.mjs';

// Compiles the committed CSS with the real Tailwind, the way apps/web will, and
// checks which classes exist afterwards.
let build: (candidates: string[]) => string;

beforeAll(async () => {
	const css = `@import 'tailwindcss';\n${readFileSync(CSS_FILE, 'utf8')}`;
	const compiler = await compile(css, { base: PACKAGE_ROOT, onDependency: () => {} });
	build = (candidates) => compiler.build(candidates);
}, 60_000);

const rule = (css: string, cls: string) => css.match(new RegExp(`\\.${cls.replace(/[.\\/:\[\]]/g, '\\$&')}\\s*\\{[^}]*\\}`))?.[0];

describe('the committed CSS under Tailwind', () => {
	it('keeps font-weight utilities working (a --font-* wildcard reset would remove them)', () => {
		const css = build(['font-medium', 'font-semibold']);
		expect(rule(css, 'font-medium')).toContain('font-weight: var(--font-weight-medium)');
		expect(css).toMatch(/--font-weight-medium:\s*500/);
	});

	it('generates the token classes', () => {
		const css = build(['bg-accent-soft', 'text-on-accent-soft', 'text-caption', 'rounded-md', 'bg-role-advisor', 'font-display']);
		expect(rule(css, 'bg-accent-soft')).toContain('var(--accent-soft)');
		expect(rule(css, 'text-on-accent-soft')).toContain('var(--on-accent-soft)');
		expect(rule(css, 'text-caption')).toContain('font-size: var(--type-caption-font-size)');
		expect(rule(css, 'text-caption')).toContain('var(--type-caption-line-height)');
		expect(rule(css, 'text-caption')).not.toContain('font-weight');
		expect(rule(css, 'rounded-md')).toContain('var(--shape-md)');
		expect(rule(css, 'bg-role-advisor')).toContain('var(--role-advisor)');
		expect(rule(css, 'font-display')).toContain('Space Grotesk');
	});

	it("does not generate Tailwind's palette, size or radius classes", () => {
		const css = build(['bg-red-500', 'text-gray-600', 'text-sm', 'text-2xl', 'rounded-2xl', 'font-serif']);
		for (const cls of ['bg-red-500', 'text-gray-600', 'text-sm', 'text-2xl', 'rounded-2xl', 'font-serif']) {
			expect(rule(css, cls), `${cls} should not exist`).toBeUndefined();
		}
	});

	it('keeps spacing, rounded-full and the colour-independent utilities', () => {
		const css = build(['p-3', 'gap-2', 'rounded-full', 'border-b', 'text-right', 'tabular-nums']);
		for (const cls of ['p-3', 'gap-2', 'rounded-full', 'border-b', 'text-right', 'tabular-nums']) {
			expect(rule(css, cls), `${cls} should exist`).toBeDefined();
		}
	});
});

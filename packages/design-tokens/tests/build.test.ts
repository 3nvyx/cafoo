import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSS_FILE, generateCSS } from '../scripts/build.mjs';
import { MODES, cssName, loadTokens, resolveValue, toHex } from '../scripts/tokens.mjs';

const tokens = loadTokens();
const committed = existsSync(CSS_FILE) ? readFileSync(CSS_FILE, 'utf8') : '';

describe('css/luyten-tokens.css', () => {
	it('is exactly what the tokens build; rebuild with: pnpm -F @luyten/design-tokens build', () => {
		expect(committed).toBe(generateCSS());
	}, 60_000);

	it('contains every semantic token as a CSS variable', () => {
		for (const t of tokens.values()) {
			if (['palette', 'size', 'font'].includes(t.path[0])) continue;
			const name = cssName(t.id);
			expect(committed, `${name} missing`).toMatch(new RegExp(`^\\s*${name}(?:-[a-z-]+)?: `, 'm'));
		}
	});

	it('contains no primitive as a CSS variable, so components cannot reach the palette', () => {
		for (const t of tokens.values()) {
			if (!['palette', 'size'].includes(t.path[0])) continue;
			expect(committed, `${cssName(t.id)} leaked into the CSS`).not.toContain(`${cssName(t.id)}:`);
		}
		expect(committed).not.toMatch(/var\(--(?:palette|size)-/);
		expect(committed).not.toContain('--font-sans: \'DM Sans\'' + ';'); // font stacks appear only inside @theme
		expect(committed.slice(0, committed.indexOf('@theme inline {'))).not.toMatch(/^\s*--font-(?:sans|display|mono):/m);
	});

	it('declares each colour token with its resolved value in both modes', () => {
		const [light, darkA, darkB] = [
			committed.match(/^:root \{[\s\S]*?^\}/m)![0],
			committed.match(/^:root\[data-theme='dark'\] \{[\s\S]*?^\}/m)![0],
			committed.match(/^@media \(prefers-color-scheme: dark\) \{[\s\S]*?^\}/m)![0],
		];
		for (const t of tokens.values()) {
			if (t.path[0] !== 'color' && t.path[0] !== 'role') continue;
			const name = cssName(t.id);
			const want = Object.fromEntries(MODES.map((m) => [m, toHex(resolveValue(tokens, t.id, m), t.id)]));
			expect(light, `${name} in light`).toContain(`${name}: ${want.light};`);
			expect(darkA, `${name} in [data-theme=dark]`).toContain(`${name}: ${want.dark};`);
			expect(darkB, `${name} in prefers-color-scheme`).toContain(`${name}: ${want.dark};`);
		}
	});

	it('switches Tailwind defaults off and maps every token in the @theme block', () => {
		const theme = committed.slice(committed.indexOf('@theme inline {'));
		for (const ns of ['color', 'text', 'radius']) expect(theme).toContain(`--${ns}-*: initial;`);
		// a --font-* wildcard would also remove --font-weight-*, breaking font-medium
		expect(theme).not.toContain('--font-*: initial;');
		expect(theme).toContain('--font-sans: initial;');
		expect(theme).not.toMatch(/--text-[a-z-]+--font-weight/);
		expect(theme).toContain('--color-on-accent-soft: var(--on-accent-soft);');
		expect(theme).toContain('--color-role-advisor: var(--role-advisor);');
		expect(theme).toContain('--text-caption--line-height: var(--type-caption-line-height);');
		expect(theme).toContain('--radius-md: var(--shape-md);');
		expect(theme).toMatch(/--font-sans: 'DM Sans', ui-sans-serif/);
	});
});

describe('token files', () => {
	it('resolve every token to a literal in both modes, with no dangling or circular alias', () => {
		for (const t of tokens.values()) for (const m of MODES) expect(() => resolveValue(tokens, t.id, m), `${t.id} (${m})`).not.toThrow();
	});

	it('keep each primitive colour\'s components and hex in agreement', () => {
		for (const t of tokens.values()) {
			if (t.path[0] !== 'palette') continue;
			const v = t.$value as { components: number[]; hex: string };
			const fromComponents = '#' + v.components.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
			expect(fromComponents, t.id).toBe(v.hex.toLowerCase());
		}
	});

	it('let the semantic tier read only primitives or other semantic tokens', () => {
		for (const t of tokens.values()) {
			if (t.path[0] === 'palette' || t.path[0] === 'size' || t.path[0] === 'font') {
				for (const m of MODES) {
					const raw = JSON.stringify(t.$value) + JSON.stringify(t.$extensions ?? {});
					expect(raw, `${t.id} is a primitive and must not alias anything`).not.toMatch(/\{[a-z]/);
				}
			}
		}
	});
});

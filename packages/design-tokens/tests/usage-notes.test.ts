import { describe, expect, it } from 'vitest';
import { loadTokens } from '../scripts/tokens.mjs';

const NAMESPACE = 'com.luyten';
const tokens = loadTokens();

/** Tokens that are easy to misuse must explain themselves. Removing their notes is a failure. */
const MUST_HAVE_NOTES = [
	'color.canvas', 'color.surface', 'color.subtle', 'color.ink-3', 'color.line', 'color.line-strong',
	'color.accent', 'color.on-accent', 'color.accent-ink', 'color.accent-soft', 'color.accent-deep',
	'color.pos', 'color.neg', 'color.warn', 'color.info', 'color.pos-soft', 'color.neg-soft', 'color.warn-soft', 'color.info-soft',
	'color.focus', 'shape.md', 'type.display', 'type.caption', 'role.advisor',
];

describe('usage notes ($extensions["com.luyten"])', () => {
	const noted = [...tokens.values()].filter((t) => t.$extensions && NAMESPACE in t.$extensions);

	it('exist on every token that is easy to misuse', () => {
		const missing = MUST_HAVE_NOTES.filter((id) => !noted.some((t) => t.id === id));
		expect(missing).toEqual([]);
	});

	for (const token of noted) {
		const note = (token.$extensions as any)[NAMESPACE] as Record<string, unknown>;
		describe(token.id, () => {
			it('uses only the keys usage and rules', () => {
				expect(Object.keys(note).sort()).toEqual(['rules', 'usage']);
			});
			it('lists kebab-case use cases', () => {
				expect(Array.isArray(note.usage) && (note.usage as unknown[]).length > 0).toBe(true);
				for (const u of note.usage as unknown[]) expect(u).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			});
			it('writes every rule as a "Never" or "Only" sentence', () => {
				expect(typeof note.rules).toBe('string');
				const sentences = (note.rules as string).trim().split(/(?<=\.)\s+/);
				expect(sentences.length).toBeGreaterThan(0);
				for (const s of sentences) expect(s, s).toMatch(/^(Never|Only) .+\.$/);
			});
			it('has a one-sentence $description too', () => {
				expect(token.$description, 'missing $description').toBeTruthy();
			});
		});
	}
});

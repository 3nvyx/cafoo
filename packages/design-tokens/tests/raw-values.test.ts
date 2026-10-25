import { describe, expect, it } from 'vitest';
import { ALLOWLIST, KINDS, scan, scanWebSource, readBaseline } from '../scripts/raw-values.mjs';

describe('raw values in apps/web/src', () => {
	it('never exceed the committed baseline, per file and kind (the ratchet)', () => {
		const current = scanWebSource();
		const baseline = readBaseline();
		const worse: string[] = [];
		const stale: string[] = [];
		const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
		for (const file of files) {
			for (const kind of KINDS) {
				const now = current[file]?.counts[kind] ?? 0;
				const allowed = baseline[file]?.[kind] ?? 0;
				if (now > allowed) {
					const samples = current[file]?.samples[kind] ?? [];
					worse.push(`${file}: ${kind} ${allowed} -> ${now}  e.g. ${samples.join(', ')}`);
				} else if (now < allowed) {
					stale.push(`${file}: ${kind} ${allowed} -> ${now}`);
				}
			}
		}
		expect(worse, 'new raw values; use tokens instead (see packages/design-tokens/NAMING.md)').toEqual([]);
		expect(stale, 'fewer raw values than the baseline allows; tighten it with: pnpm -F @cafoo/design-tokens baseline').toEqual([]);
	});

	it('allowlist entries each carry a reason', () => {
		for (const [file, reason] of Object.entries(ALLOWLIST)) {
			expect(reason.length, file).toBeGreaterThan(8);
		}
	});

	it('recognises each kind of violation', () => {
		const names = new Set(['ink', 'accent-soft', 'text:caption']);
		const { counts } = scan(
			`<div class="bg-[#ff0000] text-[13px] bg-red-500 bg-primary-container text-ink bg-accent-soft text-caption text-sm border-b hover:text-ink">
			 style="color: rgb(0 0 0 / 0.4)"`,
			names,
		);
		expect(counts).toEqual({ 'raw-colour': 2, 'bracket-size': 1, 'palette-class': 1, 'unknown-class': 2 }); // bg-primary-container and text-sm (Tailwind sizes are off)
	});

	it('ignores Svelte blocks, anchors and SVG attributes', () => {
		const names = new Set(['ink', 'text:caption']);
		const { counts } = scan(
			`{#each items as item}{#if x}{/if}{/each} <a href="#features"> <path stroke-width="2" stroke-linejoin="round" text-anchor="middle" fill-rule="evenodd" /> <p class="text-right text-caption text-pretty divide-y border-t-2 border-b-ink ring-offset-ink ring-offset-2 shadow-lg outline-none fill-current bg-transparent">`,
			names,
		);
		expect(counts).toEqual({ 'raw-colour': 0, 'bracket-size': 0, 'palette-class': 0, 'unknown-class': 0 });
	});
});

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
		expect(
			stale,
			'fewer raw values than the baseline allows (or a file moved); tighten it with: pnpm -F @cafoo/design-tokens baseline',
		).toEqual([]);
	});

	it('allowlist entries each carry a reason', () => {
		for (const [file, reason] of Object.entries(ALLOWLIST)) {
			expect(reason.length, file).toBeGreaterThan(8);
		}
	});

	it('recognises each kind of violation', () => {
		const names = new Set(['ink', 'accent-soft', 'text:caption', 'rounded:md']);
		const { counts, samples } = scan(
			`<div class="bg-[#ff0000] text-[13px] [font-size:13px] bg-red-500 bg-primary-container text-ink bg-accent-soft text-caption text-sm text-2xl rounded-md rounded-t-md rounded-2xl border-b hover:text-ink" style="color: rgb(0 0 0 / 0.4); background: #fff">
			 <rect fill="white" stroke="#123456" />`,
			names,
		);
		expect(samples['unknown-class']).toEqual(['bg-primary-container', 'text-sm', 'text-2xl', 'rounded-2xl']);
		expect(counts).toEqual({ 'raw-colour': 5, 'bracket-size': 2, 'palette-class': 1, 'unknown-class': 4 });
	});

	it('scans <style> blocks, style attributes and .css files for raw colours only', () => {
		const names = new Set(['ink']);
		const svelte = scan(
			`<p class="text-ink" style="border-top: 1px solid var(--line)">x</p>
			 <style>.a { border-left: 1px solid #000; text-underline-offset: 2px; color: var(--ink); }</style>`,
			names,
		);
		expect(svelte.counts).toEqual({ 'raw-colour': 1, 'bracket-size': 0, 'palette-class': 0, 'unknown-class': 0 });
		// #efebe4 and the named colour "red" count; border-top and text-decoration-color are properties, not classes
		const css = scan(`:root { --x: #efebe4; } .btn { border-top: 1px; text-decoration-color: red; width: 10px }`, names, 'css');
		expect(css.counts).toEqual({ 'raw-colour': 2, 'bracket-size': 0, 'palette-class': 0, 'unknown-class': 0 });
	});

	it('ignores Svelte blocks, anchors, prose, issue numbers and SVG attributes', () => {
		const names = new Set(['ink', 'text:caption']);
		const { counts } = scan(
			`{#each items as item}{#if x}{/if}{/each} <a href="#features"> <a href="#add-row"> Invoice #1042, a to-do list built from-scratch. <path fill="currentColor" /> <path stroke-width="2" stroke-linejoin="round" text-anchor="middle" fill-rule="evenodd" /> <p class="text-right text-caption text-pretty divide-y border-t-2 border-b-ink ring-offset-ink ring-offset-2 shadow-lg outline-none fill-current bg-transparent">`,
			names,
		);
		expect(counts).toEqual({ 'raw-colour': 0, 'bracket-size': 0, 'palette-class': 0, 'unknown-class': 0 });
	});
});

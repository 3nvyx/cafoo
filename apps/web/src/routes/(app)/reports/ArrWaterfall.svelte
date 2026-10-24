<script lang="ts">
	import type { ArrWaterfall } from '#lib/data/derive.js';
	import { formatMoney, toNumber } from '#lib/data/money.js';

	// ARR comes from contracts, so the bars link nowhere unless a caller passes `href`.
	let { w, href }: { w: ArrWaterfall; href?: string } = $props();

	const steps = $derived.by(() => {
		const start = toNumber(w.start);
		const added = toNumber(w.added);
		const exp = toNumber(w.expansion);
		const con = toNumber(w.contraction);
		const churn = toNumber(w.churned);
		let run = start;
		const s: { label: string; from: number; to: number; minor: string; kind: 'total' | 'up' | 'down' }[] = [];
		s.push({ label: 'Start', from: 0, to: start, minor: w.start, kind: 'total' });
		s.push({ label: 'New', from: run, to: (run += added), minor: w.added, kind: 'up' });
		s.push({ label: 'Expansion', from: run, to: (run += exp), minor: w.expansion, kind: 'up' });
		s.push({ label: 'Contraction', from: run, to: (run -= con), minor: w.contraction, kind: 'down' });
		s.push({ label: 'Churn', from: run, to: (run -= churn), minor: w.churned, kind: 'down' });
		s.push({ label: 'End', from: 0, to: toNumber(w.end), minor: w.end, kind: 'total' });
		return s;
	});

	const W = 640, H = 240, top = 28, bottom = 40, gap = 16;
	const max = $derived(Math.max(1, ...steps.map((s) => Math.max(s.from, s.to))) * 1.08);
	const bw = (W - gap * 7) / 6;
	const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
	const color = { total: 'var(--accent)', up: 'var(--pos)', down: 'var(--neg)' } as const;
</script>

<figure>
	<svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img" aria-labelledby="arr-title arr-desc">
		<title id="arr-title">ARR waterfall</title>
		<desc id="arr-desc">{steps.map((s) => `${s.label} ${formatMoney(s.minor, { whole: true })}`).join(', ')}</desc>
		<line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />
		{#each steps as s, i (s.label)}
			{@const x = gap + i * (bw + gap)}
			{@const y1 = y(Math.max(s.from, s.to))}
			{@const h = Math.max(2, Math.abs(y(s.from) - y(s.to)))}
			{#snippet bar()}
				<rect {x} y={y1} width={bw} height={h} rx="3" fill={color[s.kind]} opacity={s.kind === 'total' ? 1 : 0.85} />
				<text x={x + bw / 2} y={y1 - 8} text-anchor="middle" font-family="var(--font-mono)" font-size="13" fill="var(--ink)">
					{s.kind === 'down' && s.minor !== '0' ? '-' : s.kind === 'up' && s.minor !== '0' ? '+' : ''}{formatMoney(s.minor, { compact: true })}
				</text>
				<text x={x + bw / 2} y={H - 14} text-anchor="middle" font-size="13" fill="var(--ink-2)">{s.label}</text>
			{/snippet}
			{#if href}
				<a {href} aria-label="{s.label}: {formatMoney(s.minor, { whole: true })}">{@render bar()}</a>
			{:else}
				<g>{@render bar()}</g>
			{/if}
			{#if i < steps.length - 1}
				<line x1={x + bw} x2={x + bw + gap} y1={y(s.to)} y2={y(s.to)} stroke="var(--line-strong)" stroke-dasharray="3 3" />
			{/if}
		{/each}
	</svg>
</figure>

<script lang="ts">
	// The close as a pipeline: sources feed the worker agents, every Proposal passes the Red Team
	// and the Advisor, and only then reaches the ledger, through the CFO when it is material.
	// Pulses travel the connectors; under reduced motion the diagram is static.
	import { prefersReducedMotion } from 'svelte/motion';

	type Tone = 'system' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'advisor' | 'cfo' | 'accent';
	interface Node {
		id: string;
		c: number; // stage, left to right
		r: number; // lane, top to bottom
		title: string;
		short?: string;
		sub: string;
		tone: Tone;
		initials: string;
	}

	const STAGES = ['Sources', 'Propose', 'Critique', 'Rule', 'Confirm', 'Post'];
	const nodes: Node[] = [
		{ id: 'bank', c: 0, r: 0, title: 'Bank feed', short: 'Bank', sub: 'bank lines', tone: 'system', initials: 'BF' },
		{ id: 'billing', c: 0, r: 1, title: 'Billing', sub: 'invoices, contracts', tone: 'system', initials: 'BL' },
		{ id: 'owners', c: 0, r: 2, title: 'Owner records', short: 'Owners', sub: 'bureaus, filings', tone: 'system', initials: 'OR' },
		{ id: 'bk', c: 1, r: 0, title: 'Bookkeeper', sub: 'matches, accruals', tone: 'bookkeeper', initials: 'BK' },
		{ id: 'rv', c: 1, r: 1, title: 'Revenue', sub: 'schedules, ARR', tone: 'revenue', initials: 'RV' },
		{ id: 'cr', c: 1, r: 2, title: 'Credit & Risk', short: 'Credit', sub: 'tiers, allowance', tone: 'credit', initials: 'CR' },
		{ id: 'rt', c: 2, r: 1, title: 'Red Team', sub: 'second model', tone: 'redteam', initials: 'RT' },
		{ id: 'ad', c: 3, r: 1, title: 'Advisor', sub: 'rules and explains', tone: 'advisor', initials: 'AD' },
		{ id: 'cfo', c: 4, r: 2, title: 'CFO', sub: 'one click', tone: 'cfo', initials: 'You' },
		{ id: 'ledger', c: 5, r: 1, title: 'Ledger', sub: 'gate in the database', tone: 'accent', initials: 'GL' }
	];
	const edges: [string, string, string?][] = [
		['bank', 'bk'],
		['billing', 'rv'],
		['owners', 'cr'],
		['bk', 'rt'],
		['rv', 'rt'],
		['cr', 'rt'],
		['rt', 'ad'],
		['ad', 'ledger', 'up to $10,000'],
		['ad', 'cfo', 'over $10,000'],
		['cfo', 'ledger']
	];

	interface Layout {
		w: number;
		h: number;
		nw: number;
		nh: number;
		pos: (n: Node) => { x: number; y: number };
		edge: (a: Node, b: Node) => { d: string; lx: number; ly: number };
	}

	// Wide screens run left to right; phones run top to bottom with the same lanes.
	const wide: Layout = {
		w: 1070,
		h: 304,
		nw: 148,
		nh: 60,
		pos: (n) => ({ x: 16 + n.c * 178, y: 44 + n.r * 92 }),
		edge(a, b) {
			const p = this.pos(a), q = this.pos(b);
			const x1 = p.x + this.nw, y1 = p.y + this.nh / 2, x2 = q.x, y2 = q.y + this.nh / 2, k = (x2 - x1) / 2;
			return { d: `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 8 };
		}
	};
	const tall: Layout = {
		w: 360,
		h: 600,
		nw: 108,
		nh: 52,
		pos: (n) => ({ x: 8 + n.r * 118, y: 40 + n.c * 96 }),
		edge(a, b) {
			const p = this.pos(a), q = this.pos(b);
			const x1 = p.x + this.nw / 2, y1 = p.y + this.nh, x2 = q.x + this.nw / 2, y2 = q.y, k = (y2 - y1) / 2;
			return { d: `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`, lx: (x1 + x2) / 2 + 6, ly: (y1 + y2) / 2 + 4 };
		}
	};

	const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
	const color = (t: Tone) => (t === 'accent' ? 'var(--accent)' : `var(--role-${t})`);
	const still = $derived(prefersReducedMotion.current);
</script>

{#snippet diagram(L: Layout, vertical: boolean)}
	<svg viewBox="0 0 {L.w} {L.h}" class="h-auto w-full" role="img" aria-labelledby="flow-title-{vertical ? 1 : 0} flow-desc-{vertical ? 1 : 0}">
		<title id="flow-title-{vertical ? 1 : 0}">How a Proposal reaches the ledger</title>
		<desc id="flow-desc-{vertical ? 1 : 0}">
			Bank lines, billing and owner records feed the Bookkeeper, Revenue and Credit and Risk agents. Every Proposal goes to the Red Team, then the Advisor. Items up to $10,000 post to the ledger; larger ones go to the CFO first.
		</desc>

		{#each STAGES as s, c (s)}
			{#if vertical}
				<text x="8" y={L.pos({ c, r: 0 } as Node).y - 10} class="fill-ink-3 font-mono text-[11px]">0{c + 1} {s.toUpperCase()}</text>
			{:else}
				<text x={L.pos({ c, r: 0 } as Node).x} y="22" class="fill-ink-3 font-mono text-[12px]">0{c + 1} {s.toUpperCase()}</text>
			{/if}
		{/each}

		{#each edges as [from, to, label] (from + to)}
			{@const a = byId[from]}
			{@const e = L.edge(a, byId[to])}
			<path d={e.d} fill="none" class="stroke-line-strong" stroke-width="1.5" />
			{#if label}
				<text x={e.lx} y={e.ly} text-anchor={vertical ? 'start' : 'middle'} class="fill-ink-2 font-mono text-[11px]">{label}</text>
			{/if}
			{#if !still}
				<circle r="3.5" style="fill:{color(a.tone)}" opacity="0">
					<animateMotion dur="1.4s" begin="{a.c * 0.7}s" repeatCount="indefinite" path={e.d} />
					<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="1.4s" begin="{a.c * 0.7}s" repeatCount="indefinite" />
				</circle>
			{/if}
		{/each}

		{#each nodes as n (n.id)}
			{@const p = L.pos(n)}
			<g>
				<rect
					x={p.x}
					y={p.y}
					width={L.nw}
					height={L.nh}
					rx="8"
					class={n.tone === 'accent' ? 'fill-accent-soft stroke-accent' : 'fill-surface stroke-line-strong'}
					stroke-width={n.tone === 'accent' ? 1.5 : 1}
				/>
				{#if vertical}
					<text x={p.x + L.nw / 2} y={p.y + 23} text-anchor="middle" class="fill-ink text-[13px] font-medium">{n.short ?? n.title}</text>
					<text x={p.x + L.nw / 2} y={p.y + 39} text-anchor="middle" class="fill-ink-3 text-[10.5px]">{n.sub}</text>
				{:else}
					<circle cx={p.x + 24} cy={p.y + L.nh / 2} r="14" style="fill:color-mix(in srgb, {color(n.tone)} 16%, transparent)" />
					<text x={p.x + 24} y={p.y + L.nh / 2 + 3.5} text-anchor="middle" class="font-mono text-[10px] font-medium" style="fill:{color(n.tone)}">{n.initials}</text>
					<text x={p.x + 46} y={p.y + 26} class="fill-ink text-[14px] font-medium">{n.title}</text>
					<text x={p.x + 46} y={p.y + 43} class="fill-ink-3 text-[11.5px]">{n.sub}</text>
				{/if}
			</g>
		{/each}
	</svg>
{/snippet}

<div class="hidden lg:block">{@render diagram(wide, false)}</div>
<div class="mx-auto max-w-[420px] lg:hidden">{@render diagram(tall, true)}</div>

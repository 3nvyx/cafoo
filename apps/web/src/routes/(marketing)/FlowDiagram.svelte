<script lang="ts">
	// The close as a pipeline: sources feed the worker agents, every Proposal passes the Red Team
	// and the Advisor, and only then reaches the ledger, through the CFO when it is material.
	// Pulses travel the connectors; under reduced motion the diagram is static.
	import { prefersReducedMotion } from 'svelte/motion';
	import Icon from '#lib/components/Icon.svelte';
	import { smil } from './smil';

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
		{ id: 'billing', c: 0, r: 1, title: 'Billing', sub: 'invoices', tone: 'system', initials: 'BL' },
		{ id: 'owners', c: 0, r: 2, title: 'Owners', sub: 'bureaus, filings', tone: 'system', initials: 'OR' },
		{ id: 'bk', c: 1, r: 0, title: 'Bookkeeper', sub: 'bank matches', tone: 'bookkeeper', initials: 'BK' },
		{ id: 'rv', c: 1, r: 1, title: 'Revenue', sub: 'schedules, ARR', tone: 'revenue', initials: 'RV' },
		{ id: 'cr', c: 1, r: 2, title: 'Credit & Risk', short: 'Credit', sub: 'risk tiers', tone: 'credit', initials: 'CR' },
		{ id: 'rt', c: 2, r: 1, title: 'Red Team', sub: 'second model', tone: 'redteam', initials: 'RT' },
		{ id: 'ad', c: 3, r: 1, title: 'Advisor', sub: 'rules, explains', tone: 'advisor', initials: 'AD' },
		{ id: 'cfo', c: 4, r: 2, title: 'CFO', sub: 'one click', tone: 'cfo', initials: 'You' },
		{ id: 'ledger', c: 5, r: 1, title: 'Ledger', sub: 'behind the gate', tone: 'accent', initials: 'GL' }
	];
	// How a wire leaves and enters on wide screens: side to side, or an elbow for the CFO branch.
	type Bend = 'side' | 'down' | 'up';
	// [from, to, static label, data chip that rides the wire, bend]
	const edges: [string, string, string?, string?, Bend?][] = [
		['bank', 'bk', undefined, 'line'],
		['billing', 'rv', undefined, 'invoice'],
		['owners', 'cr', undefined, 'owner'],
		['bk', 'rt', undefined, 'proposal'],
		['rv', 'rt'],
		['cr', 'rt'],
		['rt', 'ad', undefined, 'critique'],
		['ad', 'ledger', 'under $10,000', 'post'],
		['ad', 'cfo', '$10,000 or more', 'awaiting_cfo', 'down'],
		['cfo', 'ledger', undefined, 'confirm', 'up']
	];

	interface Layout {
		w: number;
		h: number;
		nh: number;
		nodeW: (n: Node) => number;
		pos: (n: Node) => { x: number; y: number };
		edge: (a: Node, b: Node, bend: Bend) => { d: string; lx: number; ly: number; anchor: 'start' | 'middle' | 'end' };
	}

	// Wide screens run left to right; phones run top to bottom with the same lanes.
	// Stage x positions leave room between stages for a chip to be seen in transit.
	const XS = [16, 196, 412, 628, 764, 916];
	const wide: Layout = {
		w: 1070,
		h: 304,
		nh: 60,
		nodeW: (n) => (n.c === 0 ? 112 : 140),
		pos: (n) => ({ x: XS[n.c], y: 44 + n.r * 92 }),
		edge(a, b, bend) {
			const p = this.pos(a), q = this.pos(b), aw = this.nodeW(a), bw = this.nodeW(b), mid = this.nh / 2;
			if (bend === 'down') {
				const x1 = p.x + aw / 2, y1 = p.y + this.nh, x2 = q.x, y2 = q.y + mid;
				return { d: `M${x1} ${y1} C${x1} ${y2} ${x1} ${y2} ${x2} ${y2}`, lx: x1 + 10, ly: y1 + 22, anchor: 'start' };
			}
			if (bend === 'up') {
				const x1 = p.x + aw, y1 = p.y + mid, x2 = q.x + bw / 2, y2 = q.y + this.nh;
				return { d: `M${x1} ${y1} C${x2} ${y1} ${x2} ${y1} ${x2} ${y2}`, lx: x1, ly: y1, anchor: 'start' };
			}
			const x1 = p.x + aw, y1 = p.y + mid, x2 = q.x, y2 = q.y + mid, k = (x2 - x1) / 2;
			return { d: `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 8, anchor: 'middle' };
		}
	};
	const tall: Layout = {
		w: 360,
		h: 600,
		nh: 52,
		nodeW: () => 108,
		pos: (n) => ({ x: 8 + n.r * 118, y: 40 + n.c * 96 }),
		edge(a, b) {
			const p = this.pos(a), q = this.pos(b);
			const x1 = p.x + 54, y1 = p.y + this.nh, x2 = q.x + 54, y2 = q.y, k = (y2 - y1) / 2;
			// A straight wire's label goes on its left, clear of the CFO node in the right lane.
			const straight = x1 === x2;
			return { d: `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`, lx: straight ? x1 - 6 : (x1 + x2) / 2 + 6, ly: (y1 + y2) / 2 + 4, anchor: straight ? 'end' : 'start' };
		}
	};

	const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
	const color = (t: Tone) => (t === 'accent' ? 'var(--accent)' : `var(--role-${t})`);
	const still = $derived(prefersReducedMotion.current);
	let paused = $state(false);
</script>

{#snippet diagram(L: Layout, vertical: boolean)}
	<svg viewBox="0 0 {L.w} {L.h}" class="h-auto w-full" use:smil={paused} role="img" aria-labelledby="flow-title-{vertical ? 1 : 0} flow-desc-{vertical ? 1 : 0}">
		<title id="flow-title-{vertical ? 1 : 0}">How a Proposal reaches the ledger</title>
		<desc id="flow-desc-{vertical ? 1 : 0}">
			Bank lines, billing and owner records feed the Bookkeeper, Revenue and Credit and Risk agents. Every Proposal goes to the Red Team, then the Advisor. Items under $10,000 post to the ledger; items of $10,000 or more go to the CFO first.
		</desc>

		{#each STAGES as s, c (s)}
			{#if vertical}
				<text x="8" y={L.pos({ c, r: 0 } as Node).y - 10} class="fill-ink-3 font-mono text-[11px]" style="paint-order:stroke;stroke:var(--canvas);stroke-width:4px;stroke-linejoin:round">0{c + 1} {s.toUpperCase()}</text>
			{:else}
				<text x={L.pos({ c, r: 0 } as Node).x} y="22" class="fill-ink-3 font-mono text-[12px]" style="paint-order:stroke;stroke:var(--canvas);stroke-width:4px;stroke-linejoin:round">0{c + 1} {s.toUpperCase()}</text>
			{/if}
		{/each}

		{#each edges as [from, to, label, , bend = 'side'] (from + to)}
			{@const e = L.edge(byId[from], byId[to], bend)}
			<path d={e.d} fill="none" class="stroke-ink-3" stroke-width="1" stroke-dasharray="3 4" />
			{#if label}
				<text x={e.lx} y={e.ly} text-anchor={e.anchor} class="fill-ink-2 font-mono text-[11px]" style="paint-order:stroke;stroke:var(--canvas);stroke-width:4px;stroke-linejoin:round">{label}</text>
			{/if}
		{/each}

		<!-- Chips go on top of every wire so a later wire never hides one in transit. -->
		{#if !still}
			{#each edges as [from, to, , chip, bend = 'side'] (from + to)}
				{@const a = byId[from]}
				{@const e = L.edge(a, byId[to], bend)}
				{@const begin = `${a.c * 0.9}s`}
				{#if chip && !vertical}
					<g opacity="0">
						<rect x={-chip.length * 3 - 6} y="-9" width={chip.length * 6 + 12} height="18" rx="9" style="fill:{color(a.tone)}" />
						<text text-anchor="middle" y="3.5" class="font-mono text-[10px]" style="fill:var(--canvas)">{chip}</text>
						<animateMotion dur="1.8s" {begin} repeatCount="indefinite" path={e.d} />
						<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="1.8s" {begin} repeatCount="indefinite" />
					</g>
				{:else}
					<circle r="3.5" style="fill:{color(a.tone)}" opacity="0">
						<animateMotion dur="1.8s" {begin} repeatCount="indefinite" path={e.d} />
						<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="1.8s" {begin} repeatCount="indefinite" />
					</circle>
				{/if}
			{/each}
		{/if}

		{#each nodes as n (n.id)}
			{@const p = L.pos(n)}
			{@const w = L.nodeW(n)}
			<g>
				<rect
					x={p.x}
					y={p.y}
					width={w}
					height={L.nh}
					rx="12"
					class={n.tone === 'accent' ? 'fill-accent-soft stroke-line' : n.c === 0 ? 'fill-subtle stroke-line' : 'fill-surface stroke-line'}
					stroke-width="1"
				/>
				{#if vertical}
					<text x={p.x + w / 2} y={p.y + 22} text-anchor="middle" class="fill-ink text-[14px] font-medium">{n.short ?? n.title}</text>
					<text x={p.x + w / 2} y={p.y + 40} text-anchor="middle" class="fill-ink-3 text-[12px]">{n.sub}</text>
				{:else if n.c === 0}
					<text x={p.x + 12} y={p.y + 26} class="fill-ink text-[14px] font-medium">{n.title}</text>
					<text x={p.x + 12} y={p.y + 43} class="fill-ink-3 text-[11.5px]">{n.sub}</text>
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

<!-- The drawing fills the box; the pause control sits in its empty bottom-right corner. -->
<div class="relative">
	<div class="hidden lg:block">{@render diagram(wide, false)}</div>
	<div class="mx-auto w-full max-w-[560px] lg:hidden">{@render diagram(tall, true)}</div>
	{#if !still}
		<button
			class="btn btn-quiet absolute right-0 bottom-0 w-11 px-0 text-ink-3"
			aria-label={paused ? 'Play animation' : 'Pause animation'}
			title={paused ? 'Play animation' : 'Pause animation'}
			onclick={() => (paused = !paused)}
		>
			<Icon name={paused ? 'play' : 'pause'} size={16} />
		</button>
	{/if}
</div>

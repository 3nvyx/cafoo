<script lang="ts">
	// How the agents work together, as one connected graph: data comes in, four workers propose,
	// the Red Team critiques, the Advisor rules, and the ledger posts, through you when it is
	// material. Click an agent to highlight its connections and open its workflow underneath.
	// Steps follow the agents' charters (apps/agents/src/charters). Chips ride the wires; under
	// reduced motion the graph is static.
	import { prefersReducedMotion } from 'svelte/motion';
	import Icon from '#lib/components/Icon.svelte';
	import { smil } from './smil';

	// Consolidation has no role color yet, so it uses the neutral one.
	type Tone = 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'advisor' | 'cfo' | 'system' | 'ledger';
	type Id =
		| 'bank' | 'billing' | 'bureaus' | 'books'
		| 'bookkeeper' | 'revenue' | 'credit' | 'consolidation'
		| 'redteam' | 'advisor' | 'cfo' | 'ledger';
	interface Step {
		title: string;
		detail: string;
		tags?: string[];
	}
	interface Detail {
		model: string;
		summary: string;
		steps: Step[];
		never?: string[];
	}
	interface GraphNode {
		id: Id;
		title: string;
		sub: string;
		short?: string; // title on phones, where nodes are narrow
		initials?: string; // sources have none
		tone: Tone;
		detail?: Detail; // only these open a workflow
	}

	const NODES: GraphNode[] = [
		{ id: 'bank', title: 'Bank feed', sub: 'bank lines', tone: 'system' },
		{ id: 'billing', title: 'Billing', sub: 'invoices, bills', tone: 'system' },
		{ id: 'bureaus', title: 'Bureaus & web', short: 'Bureaus', sub: 'CRS, Bright Data', tone: 'system' },
		{ id: 'books', title: 'Group books', short: 'Books', sub: 'USD, GBP, rates', tone: 'system' },
		{
			id: 'bookkeeper',
			title: 'Bookkeeper',
			sub: 'bank matches',
			initials: 'BK',
			tone: 'bookkeeper',
			detail: {
				model: 'Claude Agent SDK',
				summary: 'Keeps the bank, the bills and the books in agreement.',
				steps: [
					{ title: 'Reads', detail: 'Bank lines and invoices live from the feed, plus the month’s bills.', tags: ['bank feed', 'bills'] },
					{ title: 'Matches', detail: 'Scores every bank line on amount, date, counterparty and reference.', tags: ['75% or more: batched'] },
					{ title: 'Checks', detail: 'Looks up unknown counterparties on the web and catches duplicate payments.', tags: ['Bright Data'] },
					{ title: 'Accrues', detail: 'Drafts an accrual for work done this month but billed later, reversing next month.' },
					{ title: 'Proposes', detail: 'Bank matches, journal entries and accruals, each citing its bank rows or bills.' }
				],
				never: ['Post to the ledger', 'Guess who sent unexplained money', 'Pay a blocked vendor']
			}
		},
		{
			id: 'revenue',
			title: 'Revenue',
			sub: 'schedules',
			initials: 'RV',
			tone: 'revenue',
			detail: {
				model: 'Claude Agent SDK',
				summary: 'Recognizes revenue as the service is delivered, not when it is invoiced.',
				steps: [
					{ title: 'Reads', detail: 'Contracts, invoices and metered usage for every customer.', tags: ['contracts', 'usage'] },
					{ title: 'Checks', detail: 'Finds contracts that were invoiced but have no recognition schedule.' },
					{ title: 'Schedules', detail: 'Spreads each subscription over the months it is earned, never outside its term.' },
					{ title: 'Recognizes', detail: 'Drafts the entry that moves the month’s earned share out of deferred revenue; usage counts in the month used.' },
					{ title: 'Proposes', detail: 'Revenue schedules and the month’s recognition entry.' }
				],
				never: ['Recognize revenue before the service month', 'Fix a missing schedule silently', 'Post to the ledger']
			}
		},
		{
			id: 'credit',
			title: 'Credit & Risk',
			sub: 'risk tiers',
			initials: 'CR',
			tone: 'credit',
			detail: {
				model: 'Claude Agent SDK',
				summary: 'Decides how much trust each customer and each new vendor gets.',
				steps: [
					{ title: 'Picks', detail: 'Every customer with unpaid invoices and every vendor about to be paid for the first time.' },
					{ title: 'Looks', detail: 'Collects the public footprint: a signal for a person, never a tier by itself.', tags: ['Yelp', 'job boards', 'LinkedIn'] },
					{ title: 'Checks', detail: 'Runs the CRS cascade on the customer’s guarantor or the vendor’s owner, stopping early when identity or fraud fails.', tags: ['identity', 'fraud', '3 bureaus', 'public records'] },
					{ title: 'Tiers', detail: 'Risk tier A to D, or BLOCK, sets payment terms and a reserve of 1% to 100%.' },
					{ title: 'Proposes', detail: 'Credit decisions, reserves, vendor blocks and vendor checks.' }
				],
				never: ['Pick a tier the cascade did not produce', 'Block a vendor without a BLOCK result', 'Store people’s names from a footprint']
			}
		},
		{
			id: 'consolidation',
			title: 'Consolidation',
			sub: 'eliminations',
			initials: 'CO',
			tone: 'system',
			detail: {
				model: 'Claude Agent SDK',
				summary: 'Turns a group of companies in two currencies into one set of books.',
				steps: [
					{ title: 'Reads', detail: 'Cafoo Inc in dollars, Cafoo Ltd in pounds, and the month’s closing rates.', tags: ['USD', 'GBP'] },
					{ title: 'Revalues', detail: 'Drafts the restatement of foreign-currency balances at the closing rate, with the gain or loss.' },
					{ title: 'Compares', detail: 'Checks both sides of every intercompany pair; a gap over $1 goes to the close thread.' },
					{ title: 'Eliminates', detail: 'Drafts the removal of what the companies owe and charge each other, in the Elimination subsidiary.' },
					{ title: 'Proposes', detail: 'The revaluation and the month’s eliminations.' }
				],
				never: ['Plug a gap between the two companies’ books', 'Revalue at any rate but the closing rate', 'Post to the ledger']
			}
		},
		{
			id: 'redteam',
			title: 'Red Team',
			sub: 'Grok + Gemini',
			initials: 'RT',
			tone: 'redteam',
			detail: {
				model: 'Grok, then Gemini',
				summary: 'Argues the other side of every Proposal, on models the workers do not use.',
				steps: [
					{ title: 'Reads', detail: 'Every open Proposal, before the Advisor rules on it.' },
					{ title: 'Challenges', detail: 'Grok goes first: a weak match, an assumed rate, a single source.', tags: ['Grok'] },
					{ title: 'Adds', detail: 'Gemini reads Grok’s critique and adds only what it missed.', tags: ['Gemini'] },
					{ title: 'Insists', detail: 'Always challenges a match under 75% confidence and a reserve at or above the threshold ($10,000 by default).' },
					{ title: 'Critiques', detail: 'One critique on the Proposal’s thread, in a plain sentence and in detail.' }
				],
				never: ['Propose a change', 'Rule on a Proposal', 'Critique after the ruling']
			}
		},
		{
			id: 'advisor',
			title: 'Advisor',
			sub: 'rules',
			initials: 'AD',
			tone: 'advisor',
			detail: {
				model: 'Claude Agent SDK',
				summary: 'The only agent that rules, and it answers to you.',
				steps: [
					{ title: 'Opens', detail: 'Opens the month-end close for the whole group.' },
					{ title: 'Reads', detail: 'Each Proposal together with the Red Team’s critique.' },
					{ title: 'Rules', detail: 'Approves, amends or rejects, always with a plain summary and a rationale.' },
					{ title: 'Routes', detail: 'Under the threshold ($10,000 by default) posts. At or above it, and every amendment, waits for you.' },
					{ title: 'Wraps up', detail: 'Once every Proposal is decided, prepares the Board Pack and asks you to lock.' }
				],
				never: ['Post $10,000 or more on its own word', 'Lock the month', 'Rule twice, unless you sent it back']
			}
		},
		{
			id: 'cfo',
			title: 'CFO',
			sub: 'one click',
			initials: 'You',
			tone: 'cfo',
			detail: {
				model: 'Human',
				summary: 'Has the final say on anything material, and on the month itself.',
				steps: [
					{ title: 'Reviews', detail: 'Everything in Needs your OK, with the ruling and the critique beside it.' },
					{ title: 'Confirms', detail: 'One click posts it, or sends it back to the Advisor.' },
					{ title: 'Reverses', detail: 'Can reverse any posted entry.' },
					{ title: 'Locks', detail: 'Confirms the period lock once the Advisor asks for it.' }
				]
			}
		},
		{ id: 'ledger', title: 'Ledger', sub: 'posts', initials: 'GL', tone: 'ledger' }
	];

	// [from, to, chip that rides the wire, label that stays on it]
	const EDGES: [Id, Id, string?, string?][] = [
		['bank', 'bookkeeper', 'bank line'],
		['billing', 'bookkeeper'],
		['billing', 'revenue', 'invoice'],
		['bureaus', 'credit', 'person'],
		['books', 'consolidation', 'balances'],
		['bookkeeper', 'redteam', 'proposal'],
		['revenue', 'redteam', 'proposal'],
		['credit', 'redteam', 'proposal'],
		['consolidation', 'redteam', 'proposal'],
		['redteam', 'advisor', 'critique'],
		['advisor', 'ledger', 'post', 'under $10,000'],
		['advisor', 'cfo', 'ruling', '$10,000+ or amended'],
		['cfo', 'ledger', 'confirm']
	];

	// Left to right: when a pulse leaves this column, so chips travel the graph in order.
	const COL: Record<Id, number> = {
		bank: 0, billing: 0, bureaus: 0, books: 0,
		bookkeeper: 1, revenue: 1, credit: 1, consolidation: 1,
		redteam: 2, advisor: 3, cfo: 4, ledger: 5
	};

	interface Box {
		x: number;
		y: number;
		w: number;
		h: number;
	}
	type Bend = 'side' | 'back' | 'down' | 'up' | 'bus';
	interface Layout {
		w: number;
		h: number;
		box: Record<Id, Box>;
		bend: (from: Id, to: Id) => Bend;
		captions?: { x: number; text: string }[];
		/** SVG text size in viewBox units, sized to stay at 11px or more once the drawing scales. */
		fs: number;
	}

	// Wide screens run left to right under a row of column captions.
	const T = 36; // caption band
	const row = (r: number) => T + 20 + r * 100;
	const wide: Layout = {
		w: 1100,
		h: T + 20 + 3 * 100 + 64 + 12,
		box: {
			bank: { x: 0, y: row(0), w: 130, h: 64 },
			billing: { x: 0, y: row(1), w: 130, h: 64 },
			bureaus: { x: 0, y: row(2), w: 130, h: 64 },
			books: { x: 0, y: row(3), w: 130, h: 64 },
			bookkeeper: { x: 220, y: row(0), w: 160, h: 64 },
			revenue: { x: 220, y: row(1), w: 160, h: 64 },
			credit: { x: 220, y: row(2), w: 160, h: 64 },
			consolidation: { x: 220, y: row(3), w: 160, h: 64 },
			redteam: { x: 480, y: row(1.5), w: 150, h: 64 },
			advisor: { x: 730, y: row(1.5), w: 140, h: 64 },
			ledger: { x: 970, y: row(0.5), w: 130, h: 64 },
			cfo: { x: 970, y: row(2.5), w: 130, h: 64 }
		},
		fs: 13,
		bend: (from, to) => (from === 'cfo' && to === 'ledger' ? 'up' : 'side'),
		captions: [
			{ x: 0, text: 'Data in' },
			{ x: 220, text: 'Workers propose' },
			{ x: 480, text: 'Two other models critique' },
			{ x: 730, text: 'The Advisor rules' },
			{ x: 970, text: 'You confirm, it posts' }
		]
	};
	// Phones run top to bottom: each source beside its worker, then the gate below. Workers
	// reach the Red Team down a shared wire on the right edge.
	const tall: Layout = {
		w: 360,
		h: 656,
		fs: 14,
		box: {
			bank: { x: 0, y: 0, w: 116, h: 56 },
			billing: { x: 0, y: 80, w: 116, h: 56 },
			bureaus: { x: 0, y: 160, w: 116, h: 56 },
			books: { x: 0, y: 240, w: 116, h: 56 },
			bookkeeper: { x: 140, y: 0, w: 196, h: 56 },
			revenue: { x: 140, y: 80, w: 196, h: 56 },
			credit: { x: 140, y: 160, w: 196, h: 56 },
			consolidation: { x: 140, y: 240, w: 196, h: 56 },
			redteam: { x: 100, y: 360, w: 160, h: 56 },
			advisor: { x: 100, y: 466, w: 160, h: 56 },
			ledger: { x: 0, y: 596, w: 150, h: 56 },
			cfo: { x: 210, y: 596, w: 150, h: 56 }
		},
		bend(from, to) {
			if (to === 'redteam') return 'bus';
			if (from === 'cfo') return 'back';
			return COL[to] === 1 ? 'side' : 'down';
		}
	};

	function wire(L: Layout, from: Id, to: Id) {
		const a = L.box[from], b = L.box[to];
		const bend = L.bend(from, to);
		if (bend === 'down' || bend === 'up') {
			const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2;
			const y1 = bend === 'down' ? a.y + a.h : a.y, y2 = bend === 'down' ? b.y : b.y + b.h;
			const k = (y2 - y1) / 2;
			// A branch's label starts just under its source, on its own side of the split, so two
			// branches from one node never collide and a long label still fits the drawing.
			const anchor = x2 < x1 ? 'end' : x2 > x1 ? 'start' : 'middle';
			const lx = anchor === 'end' ? x1 - 10 : anchor === 'start' ? x1 + 10 : x1;
			return { d: `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`, lx, ly: y1 + 26, anchor };
		}
		if (bend === 'bus') {
			const x1 = a.x + a.w, y1 = a.y + a.h / 2, bx = L.w - 10, x2 = b.x + b.w / 2, y2 = b.y;
			return {
				d: `M${x1} ${y1} C${bx} ${y1} ${bx} ${y1} ${bx} ${y1 + 16} L${bx} ${y2 - 30} C${bx} ${y2 - 10} ${x2} ${y2 - 20} ${x2} ${y2}`,
				lx: bx,
				ly: y2 - 30,
				anchor: 'middle'
			};
		}
		const back = bend === 'back';
		const x1 = back ? a.x : a.x + a.w, x2 = back ? b.x + b.w : b.x;
		const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, k = (x2 - x1) / 2;
		return { d: `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2, anchor: 'middle' };
	}

	const byId = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<Id, GraphNode>;
	const hue = (t: Tone) => (t === 'ledger' ? 'var(--accent-ink)' : `var(--role-${t})`);
	const pct = (v: number, of: number) => `${(v / of) * 100}%`;

	let selected = $state<Id | null>(null);
	let paused = $state(false);
	const still = $derived(prefersReducedMotion.current);
	// The last agent opened stays in the panel while it closes, so the panel can animate shut.
	let shown = $state<Id | null>(null);
	const open = $derived(shown ? byId[shown] : null);
	let trigger: HTMLElement | null = null;
	// The open agent's whole chain lights up: everything that feeds it, and everything its work
	// reaches on the way to the ledger. A wire is lit when it lies on that chain.
	function reach(from: Id, dir: 0 | 1) {
		const seen = new Set<Id>([from]);
		const queue = [from];
		while (queue.length) {
			const at = queue.shift()!;
			for (const [a, b] of EDGES) {
				const [near, far] = dir === 0 ? [a, b] : [b, a];
				if (near === at && !seen.has(far)) seen.add(far), queue.push(far);
			}
		}
		return seen;
	}
	const upstream = $derived(selected ? reach(selected, 1) : new Set<Id>());
	const downstream = $derived(selected ? reach(selected, 0) : new Set<Id>());
	const neighbours = $derived(new Set<Id>([...upstream, ...downstream]));
	const touches = (e: [Id, Id, ...unknown[]], id: Id | null) =>
		id !== null && ((upstream.has(e[0]) && upstream.has(e[1])) || (downstream.has(e[0]) && downstream.has(e[1])));
	const takesIn = $derived(shown ? EDGES.filter(([, b]) => b === shown).map(([a]) => byId[a].title) : []);
	const handsTo = $derived(shown ? EDGES.filter(([a]) => a === shown).map(([, b]) => byId[b].title) : []);

	// Opening brings the graph and the panel into view together once the panel has grown. On wide
	// screens both fit one screen, so nothing moves if they already do; on a phone the panel sits
	// below the whole graph, so its top comes into view. Closing hands focus back to the node.
	let root: HTMLElement;
	function choose(id: Id, el: HTMLElement) {
		if (selected === id) return close();
		selected = shown = id;
		trigger = el;
		const panel = document.getElementById('agent-detail');
		if (!panel) return;
		const behavior = still ? 'auto' : 'smooth';
		const reveal = () => {
			if (!matchMedia('(min-width: 1280px)').matches) return panel.scrollIntoView({ block: 'start', behavior });
			const top = root.getBoundingClientRect().top;
			if (top >= 0 && panel.getBoundingClientRect().bottom <= innerHeight) return;
			// Scrolling down hides the page's sticky header, so a little headroom is enough; scrolling
			// up brings the header back, so leave room for it.
			window.scrollTo({ top: scrollY + top - (top > 0 ? 16 : 88), behavior });
		};
		let done = false;
		const once = () => {
			if (done) return;
			done = true;
			panel.removeEventListener('transitionend', once);
			reveal();
		};
		panel.addEventListener('transitionend', once);
		setTimeout(once, 400);
	}
	function close() {
		selected = null;
		trigger?.focus();
	}
	const linkText = EDGES.map(([a, b, , label]) => `${byId[a].title} to ${byId[b].title}${label ? ` (${label})` : ''}`).join('; ');
</script>

{#snippet avatar(n: GraphNode, size: 'xs' | 'sm' | 'md')}
	<span
		class="avatar inline-grid shrink-0 place-items-center rounded-full font-mono font-medium select-none {size}"
		style="color:{hue(n.tone)};background:color-mix(in srgb, {hue(n.tone)} 14%, transparent)"
		aria-hidden="true">{n.initials}</span
	>
{/snippet}

{#snippet graph(L: Layout, key: string)}
	<!-- On phones the drawing is narrow: nodes show only a title and a small avatar. -->
	{@const compact = key === 'tall'}
	<div class={['relative w-full', !compact && 'scaled']} style="aspect-ratio:{L.w} / {L.h}">
		<svg viewBox="0 0 {L.w} {L.h}" class="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
			{#each L.captions ?? [] as c (c.x)}
				<text x={c.x} y="14" font-size={L.fs} class="fill-ink-3">{c.text}</text>
			{/each}

			{#each EDGES as e (e[0] + e[1])}
				{@const w = wire(L, e[0], e[1])}
				<path
					d={w.d}
					fill="none"
					stroke-width={touches(e, selected) ? 1.5 : 1}
					stroke-dasharray="3 4"
					class={['wire', touches(e, selected) ? 'stroke-ink-2' : 'stroke-ink-3', selected && !touches(e, selected) && 'faint']}
				/>
				{#if e[3]}
					<text
						x={w.lx}
						y={w.ly - 8}
						text-anchor={w.anchor}
						font-size={L.fs}
						style="paint-order:stroke;stroke:var(--surface);stroke-width:5px;stroke-linejoin:round"
						class={['label fill-ink-2 font-mono', selected && !touches(e, selected) && 'faint']}>{e[3]}</text
					>
				{/if}
			{/each}
		</svg>

		{#each NODES as n (n.id)}
			{@const b = L.box[n.id]}
			{@const dim = selected !== null && !neighbours.has(n.id)}
			<div
				class={['node absolute', dim && 'faint']}
				style="left:{pct(b.x, L.w)};top:{pct(b.y, L.h)};width:{pct(b.w, L.w)};height:{pct(b.h, L.h)}"
			>
				{#if n.detail}
					<button
						class={[
							'flex h-full w-full items-center gap-2 rounded-xl border border-line px-2.5 text-left transition-colors duration-150',
							selected === n.id ? 'bg-accent-soft' : 'bg-canvas hover:bg-subtle'
						]}
						aria-expanded={selected === n.id}
						aria-controls="agent-detail"
						onclick={(e) => choose(n.id, e.currentTarget)}
					>
						{@render avatar(n, compact ? 'xs' : 'sm')}
						<span class="flex min-w-0 flex-1 flex-col">
							<span class={['t truncate text-body-sm font-medium', selected === n.id ? 'text-on-accent-soft' : 'text-ink']}>{compact ? (n.short ?? n.title) : n.title}</span>
							{#if !compact}<span class={['s truncate text-caption', selected === n.id ? 'text-on-accent-soft' : 'text-ink-3']}>{n.sub}</span>{/if}
						</span>
					</button>
				{:else}
					<div class={['flex h-full w-full items-center gap-2 rounded-xl border border-line px-2.5', n.initials ? 'bg-canvas' : 'bg-subtle']}>
						{#if n.initials}{@render avatar(n, compact ? 'xs' : 'sm')}{/if}
						<span class="flex min-w-0 flex-col">
							<span class="t truncate text-body-sm font-medium text-ink">{compact ? (n.short ?? n.title) : n.title}</span>
							{#if !compact}<span class="s truncate text-caption text-ink-3">{n.sub}</span>{/if}
						</span>
					</div>
				{/if}
			</div>
		{/each}

		<svg viewBox="0 0 {L.w} {L.h}" class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" use:smil={paused} aria-hidden="true">
			<!-- Chips ride above the nodes in their own layer, so a node never hides one in transit.
			     While an agent is open, only its own chain carries them. -->
			{#if !still}
				{#each EDGES as e (e[0] + e[1])}
					{#if !selected || touches(e, selected)}
						{@const w = wire(L, e[0], e[1])}
						{@const from = byId[e[0]]}
						{@const begin = `${COL[e[0]] * 0.9}s`}
						{#if e[2] && key === 'wide'}
							<g opacity="0">
								<rect x={-e[2].length * 3.75 - 7} y="-10" width={e[2].length * 7.5 + 14} height="20" rx="10" style="fill:{hue(from.tone)}" />
								<text text-anchor="middle" y="4" font-size={L.fs} class="font-mono" style="fill:var(--canvas)">{e[2]}</text>
								<animateMotion dur="1.8s" {begin} repeatCount="indefinite" path={w.d} />
								<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="1.8s" {begin} repeatCount="indefinite" />
							</g>
						{:else}
							<circle r="3.5" style="fill:{hue(from.tone)}" opacity="0">
								<animateMotion dur="1.8s" {begin} repeatCount="indefinite" path={w.d} />
								<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="1.8s" {begin} repeatCount="indefinite" />
							</circle>
						{/if}
					{/if}
				{/each}
			{/if}
		</svg>
	</div>
{/snippet}

{#snippet pause(cls: string)}
	{#if !still}
		<button
			class="btn btn-quiet w-11 shrink-0 px-0 text-ink-3 {cls}"
			aria-label={paused ? 'Play animation' : 'Pause animation'}
			title={paused ? 'Play animation' : 'Pause animation'}
			onclick={() => (paused = !paused)}
		>
			<Icon name={paused ? 'play' : 'pause'} size={16} />
		</button>
	{/if}
{/snippet}

<!-- On wide screens the graph and an open workflow fit one screen together: the panel is compact
     and the pause control sits in the graph's empty bottom-right corner. -->
<div bind:this={root} class="scroll-mt-24">
	<div class="mb-2 flex justify-end xl:hidden">{@render pause('')}</div>

	<p class="sr-only">How work moves between them: {linkText}.</p>
	<div class="relative hidden xl:block">
		{@render graph(wide, 'wide')}
		{@render pause('absolute right-0 bottom-0')}
	</div>
	<div class="mx-auto w-full max-w-md xl:hidden">{@render graph(tall, 'tall')}</div>

	<!-- The open agent's workflow; the panel grows from nothing and is inert while closed. -->
	<div id="agent-detail" role="region" aria-label={open ? `${open.title} workflow` : 'Agent workflow'} class={['expand grid scroll-mt-24', selected && 'on']} inert={!selected}>
		<div class="overflow-hidden">
			{#if open?.detail}
				{@const d = open.detail}
				<div class="mt-4 rounded-xl border border-line bg-canvas p-4">
					<div class="flex items-start justify-between gap-3">
						<div class="flex min-w-0 flex-col gap-1 lg:flex-row lg:items-center lg:gap-4">
							<div class="flex shrink-0 items-center gap-2.5">
								{@render avatar(open, 'sm')}
								<h3 class="font-sans text-subtitle font-medium text-ink">{open.title}</h3>
							</div>
							<p class="text-body-sm text-ink-2">{d.summary}</p>
						</div>
						<button class="btn btn-quiet -mt-2 -mr-2 w-11 shrink-0 px-0 text-ink-3" aria-label="Close {open.title} workflow" onclick={close}>
							<Icon name="x" size={16} />
						</button>
					</div>

					<dl class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-caption">
						<div class="flex gap-1.5"><dt class="text-ink-3">Runs on</dt><dd class="text-ink">{d.model}</dd></div>
						{#if takesIn.length}<div class="flex gap-1.5"><dt class="text-ink-3">Takes in from</dt><dd class="text-ink">{takesIn.join(', ')}</dd></div>{/if}
						{#if handsTo.length}<div class="flex gap-1.5"><dt class="text-ink-3">Hands to</dt><dd class="text-ink">{handsTo.join(', ')}</dd></div>{/if}
					</dl>

					<ol class="steps mt-3 grid gap-2 sm:grid-cols-2" style="--n:{d.steps.length}">
						{#each d.steps as s, i (s.title)}
							<li class="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
								<p class="flex items-baseline gap-2 text-body-sm font-medium text-ink">
									<span class="num text-caption text-ink-3">0{i + 1}</span>{s.title}
								</p>
								<p class="text-caption text-ink-2">{s.detail}</p>
								{#if s.tags}
									<ul role="list" class="mt-auto flex flex-wrap gap-1 pt-1">
										{#each s.tags as t (t)}
											<li class="rounded-sm bg-subtle px-1.5 font-mono text-micro text-ink-2">{t}</li>
										{/each}
									</ul>
								{/if}
							</li>
						{/each}
					</ol>

					{#if d.never}
						<div class="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-6">
							<p class="text-caption text-ink-3">It can never</p>
							<ul role="list" class="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-6">
								{#each d.never as n (n)}
									<li class="flex items-center gap-1.5 text-caption text-ink">
										<Icon name="lock" size={14} class="shrink-0 text-ink-3" />{n}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.avatar.xs {
		width: 22px;
		height: 22px;
		font-size: 8px;
	}
	.avatar.sm {
		width: 28px;
		height: 28px;
		font-size: 10px;
	}
	.avatar.md {
		width: 40px;
		height: 40px;
		font-size: 13px;
	}

	/* On wide screens the node text scales with the drawing (1cqi is 1% of its width), so labels
	   keep their proportion to the pills from a laptop to a large monitor. */
	.scaled {
		container-type: inline-size;
	}
	.scaled .t {
		font-size: clamp(11px, 1.2cqi, 14px);
		line-height: 1.35;
	}
	.scaled .s {
		font-size: clamp(10px, 1.05cqi, 12px);
		line-height: 1.35;
	}
	.scaled .avatar.sm {
		width: clamp(22px, 2.6cqi, 28px);
		height: clamp(22px, 2.6cqi, 28px);
		font-size: clamp(8px, 0.9cqi, 10px);
	}

	/* Everything that is not the open agent or one of its neighbours steps back. */
	.node,
	.wire,
	.label {
		transition: opacity 200ms ease-out;
	}
	.faint {
		opacity: 0.3;
	}
	.node.faint {
		opacity: 0.5;
	}
	.node.faint:focus-within {
		opacity: 1;
	}

	.expand {
		grid-template-rows: 0fr;
		transition: grid-template-rows 260ms cubic-bezier(0.23, 1, 0.32, 1);
	}
	.expand.on {
		grid-template-rows: 1fr;
	}

	@media (min-width: 1024px) {
		.steps {
			grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		}
	}
</style>

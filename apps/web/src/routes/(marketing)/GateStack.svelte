<script lang="ts">
	// Cafoo as an exploded stack: six layers pull apart as the section scrolls into view, each
	// with a numbered part label. Feeds enter at the worker layer; only the gate writes to the
	// ledger. What the agent-workflows section above cannot show is the gate at work, so two
	// calls replay on the plates (a worker's write bounces off the gate; a confirmed Proposal
	// passes it and posts) and a gate log lists every call with its verdict. Under reduced
	// motion it renders fully exploded, the calls stay still and the log does not scroll.
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { smil } from './smil';

	interface Layer {
		name: string;
		title: string;
		lines: [string, string];
		tone: 'plain' | 'gate' | 'ledger';
		dots: string[];
	}

	// Top to bottom in the order a Proposal meets them: a worker agent proposes, the Red Team
	// critiques, the Advisor rules, the CFO confirms anything material, and the reducers check
	// every caller before the ledger changes.
	const layers: Layer[] = [
		{ name: 'AGENTS', title: 'Worker agents propose', lines: ['Bookkeeper, Revenue, Credit & Risk. Each signs in', 'as its own role. They propose, never post.'], tone: 'plain', dots: ['bookkeeper', 'revenue', 'credit'] },
		{ name: 'RED TEAM', title: 'Red Team critiques', lines: ['Grok attacks each Proposal first, then Gemini', 'adds what that critique missed.'], tone: 'plain', dots: ['redteam'] },
		{ name: 'ADVISOR', title: 'Advisor rules', lines: ['Approves or rejects every Proposal and', 'writes down the rationale.'], tone: 'plain', dots: ['advisor'] },
		{ name: 'CFO', title: 'CFO confirms', lines: ['Anything at or above Materiality waits for', 'the CFO, a seat claimed with a one-time secret.'], tone: 'plain', dots: ['cfo'] },
		{ name: 'REDUCERS', title: 'SpacetimeDB reducers check identity', lines: ['Every write checks who is calling. An agent that', 'ignores its prompt still cannot post.'], tone: 'gate', dots: [] },
		{ name: 'LEDGER', title: 'Ledger', lines: ['Journal Lines, Proposals and the audit trail,', 'streamed to the app as they change.'], tone: 'ledger', dots: [] }
	];
	const feeds = [
		{ label: 'Bank feed', chip: '+4,200.00' },
		{ label: 'Billing', chip: 'INV-2291' },
		{ label: 'Owner records', chip: 'owner_check' }
	];

	// Isometric plate geometry (2:1), in viewBox units.
	const CX = 430, A = 150, B = 75, T = 14, BOTTOM = 540, GAP_MIN = 26, GAP_MAX = 84;
	const LABEL_X = 690;

	let progress = $state(0);
	const p = $derived(prefersReducedMotion.current ? 1 : progress);
	const gap = $derived(GAP_MIN + (GAP_MAX - GAP_MIN) * p);
	const cy = (i: number) => BOTTOM - (layers.length - 1 - i) * gap;
	const labelY = (i: number) => BOTTOM - (layers.length - 1 - i) * GAP_MAX;

	const top = (y: number) => `M${CX - A} ${y} L${CX} ${y - B} L${CX + A} ${y} L${CX} ${y + B} Z`;
	const left = (y: number) => `M${CX - A} ${y} L${CX} ${y + B} L${CX} ${y + B + T} L${CX - A} ${y + T} Z`;
	const right = (y: number) => `M${CX} ${y + B} L${CX + A} ${y} L${CX + A} ${y + T} L${CX} ${y + B + T} Z`;
	// Text and dots laid flat on a plate's top face.
	const onTop = (y: number, du = 0, dv = 0) => `matrix(0.82 -0.41 0.82 0.41 ${CX + (du + dv) * 0.82} ${y + (dv - du) * 0.41})`;

	const FILL = {
		plain: { top: 'fill-surface stroke-ink-3', side: 'fill-subtle stroke-ink-3', text: 'fill-ink-3' },
		gate: { top: 'fill-accent-soft stroke-ink-3', side: 'fill-accent-soft stroke-ink-3', text: 'fill-accent-ink' },
		ledger: { top: 'fill-ink stroke-ink', side: 'fill-ink-2 stroke-ink', text: 'fill-canvas' }
	} as const;

	const agentsY = $derived(cy(0));
	const feedY = (n: number) => 150 + n * 64;
	const feedPath = (n: number) => `M150 ${feedY(n)} C230 ${feedY(n)} 220 ${agentsY + 4} ${CX - A} ${agentsY + 4}`;
	const leader = (i: number) => `M${CX + A} ${cy(i)} L${LABEL_X - 24} ${labelY(i)} L${LABEL_X - 8} ${labelY(i)}`;

	// The gate's verdicts. Agents sign in as their own role, so a write they are not allowed is refused by the database
	// whatever their prompt said; only the Advisor (below your threshold) and you (above it) get anything posted.
	type Verdict = 'refused' | 'held' | 'posted';
	interface Call {
		role: string;
		action: string;
		verdict: Verdict;
	}
	const CALLS: Call[] = [
		{ role: 'bookkeeper', action: 'post_entry', verdict: 'refused' },
		{ role: 'advisor', action: 'rule pr-21', verdict: 'posted' },
		{ role: 'revenue', action: 'post_entry', verdict: 'refused' },
		{ role: 'advisor', action: 'rule pr-22', verdict: 'held' },
		{ role: 'redteam', action: 'edit pr-22', verdict: 'refused' },
		{ role: 'cfo', action: 'confirm pr-22', verdict: 'posted' },
		{ role: 'feed', action: 'post_entry', verdict: 'refused' },
		{ role: 'credit', action: 'set_allowance', verdict: 'refused' },
		{ role: 'advisor', action: 'rule pr-23', verdict: 'posted' }
	];
	const VERDICT: Record<Verdict, { text: string; pill: string; ink: string }> = {
		refused: { text: 'refused', pill: 'fill-neg-soft', ink: 'fill-on-neg-soft' },
		held: { text: 'held for you', pill: 'fill-warn-soft', ink: 'fill-on-warn-soft' },
		posted: { text: 'posted', pill: 'fill-pos-soft', ink: 'fill-on-pos-soft' }
	};
	// Role colors exist for the agents and the CFO; the feed uses the neutral one.
	const roleColor = (r: string) => `var(--role-${r === 'feed' ? 'system' : r})`;
	const ROWS = 5;

	// The log scrolls one call at a time while the drawing is on screen.
	let seq = $state(ROWS);
	const log = $derived(Array.from({ length: ROWS }, (_, k) => ({ n: seq - ROWS + k, call: CALLS[(seq - ROWS + k) % CALLS.length] })));
	let onScreen = $state(false);
	onMount(() => {
		if (prefersReducedMotion.current) return;
		const t = setInterval(() => {
			if (onScreen && !document.hidden) seq += 1;
		}, 2400);
		return () => clearInterval(t);
	});
	function watch(node: HTMLElement) {
		const io = new IntersectionObserver(([e]) => (onScreen = e.isIntersecting));
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}

	// The two calls replayed on the plates, on one eight-second loop: a worker calls the database directly, so its write
	// leaves the agents plate and goes around the review layers (it never reaches the Red Team, the Advisor or you),
	// meets the gate and bounces back refused; then a Proposal that passed every layer drops through the gate to post.
	const LOOP = '8s';
	const gateY = $derived(cy(4));
	const ledgerY = $derived(cy(5));
	// Outside the plates' right corners and inside the part labels, so the chip covers neither.
	const BYPASS_X = CX + A + 56;
	const refusedPath = $derived(
		`M${CX + 46} ${cy(0) - 8} C${CX + A + 40} ${cy(0) - 8} ${BYPASS_X} ${cy(0) + 24} ${BYPASS_X} ${cy(1)} L${BYPASS_X} ${cy(3)} C${BYPASS_X} ${gateY - 32} ${CX + A + 40} ${gateY - 8} ${CX + 46} ${gateY - 8}`
	);
	const postedPath = $derived(`M${CX - 46} ${cy(0) - 8} L${CX - 46} ${ledgerY - 8}`);

	function scrub(node: HTMLElement) {
		let raf = 0;
		const update = () => {
			raf = 0;
			const r = node.getBoundingClientRect();
			const vh = window.innerHeight;
			// Fully exploded after the top has travelled 60% of the viewport, whatever the section's height.
			progress = Math.max(0, Math.min(1, (vh * 0.9 - r.top) / (vh * 0.6)));
		};
		const onScroll = () => (raf ||= requestAnimationFrame(update));
		update();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
		return {
			destroy() {
				cancelAnimationFrame(raf);
				window.removeEventListener('scroll', onScroll);
				window.removeEventListener('resize', onScroll);
			}
		};
	}
</script>

{#snippet plates(labels: boolean)}
	{#each layers as _, k (k)}
		{@const i = layers.length - 1 - k}
		{@const L = layers[i]}
		{@const y = cy(i)}
		{@const f = FILL[L.tone]}
		<g>
			<path d={left(y)} class={f.side} stroke-width="1" stroke-linejoin="round" />
			<path d={right(y)} class={f.side} stroke-width="1" stroke-linejoin="round" />
			<path d={top(y)} class={f.top} stroke-width="1" stroke-linejoin="round" />
			<text transform={onTop(y, -56, 34)} class="{f.text} font-mono text-[15px] font-medium" style="letter-spacing:0.12em">{L.name}</text>
			{#each L.dots as role, d (role)}
				<!-- After the name, on the front half of the face: the plate above covers the back half. -->
				<ellipse cx="0" cy="0" rx="6" ry="6" transform={onTop(y, 46 + d * 14, 30)} style="fill:color-mix(in srgb, var(--role-{role}) 22%, transparent);stroke:var(--role-{role})" stroke-width="1.2" />
			{/each}
			{#if L.tone === 'gate'}
				<path transform={onTop(y, 44, 28)} d="M-9 -2h18v14h-18zM-5.5 -2v-4a5.5 5.5 0 0 1 11 0v4" fill="none" class="stroke-accent" stroke-width="1.6" stroke-linejoin="round" />
			{/if}
			{#if !labels}
				<text x={CX + A + 10} y={y + 4} class="fill-ink-3 font-mono text-[13px]">0{i + 1}</text>
			{/if}
		</g>
	{/each}
{/snippet}

{#snippet chip(text: string, role: string)}
	<rect x={-(text.length * 7.2) / 2 - 18} y="-12" width={text.length * 7.2 + 30} height="24" rx="5" class="fill-ink" />
	<circle cx={-(text.length * 7.2) / 2 - 6} cy="0" r="3.5" style="fill:{roleColor(role)}" />
	<text x="6" y="4" text-anchor="middle" class="fill-canvas font-mono text-caption">{text}</text>
{/snippet}

{#snippet verdict(text: string, kind: Verdict)}
	<rect x={-(text.length * 7.2) / 2 - 10} y="-12" width={text.length * 7.2 + 20} height="24" rx="5" class={VERDICT[kind].pill} />
	<text y="4" text-anchor="middle" class="{VERDICT[kind].ink} font-mono text-caption">{text}</text>
{/snippet}

<div use:scrub use:watch>
	<!-- Wide screens: plates, feeds and the parts list in one drawing. -->
	<svg viewBox="0 0 1040 640" class="hidden h-auto w-full lg:block" use:smil role="img" aria-labelledby="stack-title">
		<title id="stack-title">Cafoo’s security layers, in order: worker agents propose, the Red Team critiques, the Advisor rules, the CFO confirms anything material, and SpacetimeDB reducers check every caller before the ledger</title>

		{#each feeds as fd, n (fd.label)}
			<path d={feedPath(n)} fill="none" class="stroke-ink-3" stroke-width="1" stroke-dasharray="3 4" />
			<!-- The chip is drawn before its box so it slides out from under it. -->
			{#if !prefersReducedMotion.current}
				<g opacity="0">
					<rect x={-fd.chip.length * 3.3 - 8} y="-10" width={fd.chip.length * 6.6 + 16} height="20" rx="4" class="fill-ink" />
					<text text-anchor="middle" y="4" class="fill-canvas font-mono text-[11px]">{fd.chip}</text>
					<animateMotion dur="3.2s" begin="{n * 1.1}s" repeatCount="indefinite" path={feedPath(n)} />
					<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="3.2s" begin="{n * 1.1}s" repeatCount="indefinite" />
				</g>
			{/if}
			<g transform="translate(20 {feedY(n) - 18})">
				<rect width="130" height="36" rx="8" class="fill-surface stroke-line" />
				<text x="14" y="23" class="fill-ink text-[13px] font-medium">{fd.label}</text>
			</g>
		{/each}
		<text x="20" y="120" class="fill-ink-3 font-mono text-[11px]">FEEDS · INGEST ONLY</text>

		{@render plates(true)}

		{#if !prefersReducedMotion.current}
			<!-- The gate at work: a worker's direct write skips review and bounces off; a confirmed Proposal passes and posts. -->
			<g aria-hidden="true">
				<path d={top(gateY)} fill="none" class="stroke-neg" stroke-width="2" stroke-linejoin="round" opacity="0">
					<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.21;0.24;0.36;1" dur={LOOP} repeatCount="indefinite" />
				</path>
				<path d={top(gateY)} fill="none" class="stroke-pos" stroke-width="2" stroke-linejoin="round" opacity="0">
					<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.74;0.77;0.84;1" dur={LOOP} repeatCount="indefinite" />
				</path>

				<g opacity="0">
					{@render chip('post_entry', 'bookkeeper')}
					<animateMotion path={refusedPath} keyPoints="0;1;0.45;0.45" keyTimes="0;0.22;0.36;1" calcMode="linear" dur={LOOP} repeatCount="indefinite" />
					<animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.04;0.33;0.38;1" dur={LOOP} repeatCount="indefinite" />
				</g>
				<g transform="translate({CX + 46} {gateY - 8})" opacity="0">
					{@render verdict('refused · agents propose, never post', 'refused')}
					<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.22;0.25;0.44;0.48;1" dur={LOOP} repeatCount="indefinite" />
				</g>

				<g opacity="0">
					{@render chip('pr-22 · confirmed', 'cfo')}
					<animateMotion path={postedPath} keyPoints="0;0;1;1" keyTimes="0;0.5;0.84;1" calcMode="linear" dur={LOOP} repeatCount="indefinite" />
					<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.5;0.53;0.84;0.86;1" dur={LOOP} repeatCount="indefinite" />
				</g>
				<g transform="translate({CX - 46} {ledgerY - 8})" opacity="0">
					{@render verdict('posted · JE-1042', 'posted')}
					<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.84;0.87;0.97;0.995;1" dur={LOOP} repeatCount="indefinite" />
				</g>
			</g>
		{/if}

		<!-- Every call the gate answered, newest last. -->
		<g transform="translate(20 486)">
			<text class="fill-ink-3 font-mono text-caption">Gate log</text>
			{#each log as row, k (row.n)}
				{@const v = VERDICT[row.call.verdict]}
				<g transform="translate(0 {22 + k * 24})" in:fade={{ duration: 300 }}>
					<circle cx="4" cy="-4" r="3.5" style="fill:{roleColor(row.call.role)}" />
					<text x="14" class="fill-ink font-mono text-caption">{row.call.role}</text>
					<text x="98" class="fill-ink-2 font-mono text-caption">{row.call.action}</text>
					<rect x={262 - v.text.length * 7.2 - 12} y="-15" width={v.text.length * 7.2 + 12} height="20" rx="4" class={v.pill} />
					<text x="256" text-anchor="end" class="{v.ink} font-mono text-caption">{v.text}</text>
				</g>
			{/each}
		</g>

		<g style="opacity:{Math.max(0, (p - 0.55) / 0.45)}">
			{#each layers as L, i (L.name)}
				<path d={leader(i)} fill="none" class="stroke-ink-3" stroke-width="0.75" />
				<text x={LABEL_X} y={labelY(i) - 6} class="fill-ink-3 font-mono text-[12px]">0{i + 1}</text>
				<text x={LABEL_X + 26} y={labelY(i) - 6} class="fill-ink text-[15px] font-medium">{L.title}</text>
				<text x={LABEL_X + 26} y={labelY(i) + 13} class="fill-ink-2 text-[12.5px]">{L.lines[0]}</text>
				<text x={LABEL_X + 26} y={labelY(i) + 30} class="fill-ink-2 text-[12.5px]">{L.lines[1]}</text>
			{/each}
		</g>
	</svg>

	<!-- Phones and tablets: the stack alone, then the parts list as text (kept for screen readers on wide screens). -->
	<svg viewBox="250 0 400 640" class="mx-auto h-auto w-full max-w-[420px] lg:hidden" aria-hidden="true">
		{@render plates(false)}
	</svg>
	<!-- Phones and tablets: the gate log under the stack. -->
	<section class="mt-6 lg:hidden" aria-label="Gate log">
		<p class="font-mono text-caption text-ink-3">Gate log</p>
		<ul class="mt-2 flex flex-col divide-y divide-line border-y border-line">
			{#each log as row (row.n)}
				{@const v = VERDICT[row.call.verdict]}
				<li class="flex items-center gap-2 py-2 font-mono text-caption" in:fade={{ duration: 300 }}>
					<span class="size-2 shrink-0 rounded-full" style="background:{roleColor(row.call.role)}"></span>
					<span class="text-ink">{row.call.role}</span>
					<span class="min-w-0 flex-1 truncate text-ink-2">{row.call.action}</span>
					<span class="rounded-sm px-1.5 py-0.5 {row.call.verdict === 'refused' ? 'bg-neg-soft text-on-neg-soft' : row.call.verdict === 'held' ? 'bg-warn-soft text-on-warn-soft' : 'bg-pos-soft text-on-pos-soft'}">{v.text}</span>
				</li>
			{/each}
		</ul>
	</section>

	<div>
		<p class="sr-only">
			The gate checks who is calling. A worker agent that tries to post to the ledger is refused, whatever its prompt says;
			only the Advisor, below your threshold, and you, above it, get a Proposal posted.
		</p>
		<ol class="mt-6 flex flex-col divide-y divide-line border-y border-line lg:sr-only">
			{#each layers as L, i (L.name)}
				<li class="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2 py-4">
					<span class="num text-sm text-ink-3">0{i + 1}</span>
					<div>
						<p class="font-medium">{L.title}</p>
						<p class="text-ink-2">{L.lines[0]} {L.lines[1]}</p>
					</div>
				</li>
			{/each}
		</ol>
	</div>
</div>

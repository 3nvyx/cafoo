<script lang="ts">
	// Cafoo as an exploded stack: six layers pull apart as the section scrolls into view, each
	// with a numbered part label. Feeds enter at the worker layer; only the gate writes to the
	// ledger. Under reduced motion it renders fully exploded and nothing moves.
	import { prefersReducedMotion } from 'svelte/motion';
	import Icon from '#lib/components/Icon.svelte';
	import { smil } from './smil';

	interface Layer {
		name: string;
		title: string;
		lines: [string, string];
		tone: 'plain' | 'gate' | 'ledger';
		dots: string[];
	}

	const layers: Layer[] = [
		{ name: 'CFO APP', title: 'CFO app', lines: ['Simple and Expert mode, live from the ledger.', 'The CFO seat is claimed once, with a one-time secret.'], tone: 'plain', dots: ['cfo'] },
		{ name: 'ADVISOR', title: 'Advisor', lines: ['Rules on every Proposal and writes down why.', 'Anything material goes to the CFO.'], tone: 'plain', dots: ['advisor'] },
		{ name: 'RED TEAM', title: 'Red Team', lines: ['A second model attacks each Proposal', 'before anyone rules on it.'], tone: 'plain', dots: ['redteam'] },
		{ name: 'AGENTS', title: 'Worker agents', lines: ['Bookkeeper, Revenue, Credit & Risk. Each signs in', 'as its own role. They propose, never post.'], tone: 'plain', dots: ['bookkeeper', 'revenue', 'credit'] },
		{ name: 'GATE', title: 'Approval gate', lines: ['Reducers check who is calling. An agent that', 'ignores its prompt still cannot write.'], tone: 'gate', dots: [] },
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
	let paused = $state(false);
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

	const agentsY = $derived(cy(3));
	const feedY = (n: number) => 300 + n * 64;
	const feedPath = (n: number) => `M150 ${feedY(n)} C230 ${feedY(n)} 220 ${agentsY + 4} ${CX - A} ${agentsY + 4}`;
	const leader = (i: number) => `M${CX + A} ${cy(i)} L${LABEL_X - 24} ${labelY(i)} L${LABEL_X - 8} ${labelY(i)}`;

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

<div use:scrub>
	{#if !prefersReducedMotion.current}
		<div class="mb-2 hidden justify-end lg:flex">
			<button class="btn btn-quiet px-2 text-sm text-ink-3" onclick={() => (paused = !paused)}>
				<Icon name={paused ? 'play' : 'pause'} size={16} />{paused ? 'Play animation' : 'Pause animation'}
			</button>
		</div>
	{/if}
	<!-- Wide screens: plates, feeds and the parts list in one drawing. -->
	<svg viewBox="0 0 1040 640" class="hidden h-auto w-full lg:block" use:smil={paused} role="img" aria-labelledby="stack-title">
		<title id="stack-title">Cafoo’s layers: CFO app, Advisor, Red Team, worker agents, the approval gate and the ledger</title>

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
		<text x="20" y="270" class="fill-ink-3 font-mono text-[11px]">FEEDS · INGEST ONLY</text>

		{@render plates(true)}

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
	<div>
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

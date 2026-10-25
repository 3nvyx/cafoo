<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { roleName } from '#lib/labels.js';
	import { appear } from '#lib/motion.js';
	import { latestStep } from '#lib/close-run.js';
	import RoleAvatar from './RoleAvatar.svelte';

	let { periodId }: { periodId?: string } = $props();
	const act = $derived(db.liveActivity());
	const running = $derived(db.connection().closes.find((c) => c.status === 'running' && (!periodId || c.periodYm === periodId)));
	const working = $derived(!!running);
	// The gateway's latest live-close step, in plain words, when it reports steps (live mode only).
	const step = $derived(latestStep(running));
</script>

<!-- Only the headline state is announced; the gateway's step text changes on every tool call. -->
<span class="sr-only" aria-live="polite">{act ? `${roleName(act.role)} · ${act.labelPlain}` : working ? 'Agents are working on the close' : ''}</span>
<div class="min-h-8">
	{#if act}
		{#key act.labelPlain}
			<p class="flex items-center gap-2 text-body-sm text-ink-2" in:appear>
				<RoleAvatar role={act.role} size={24} />
				<span><span class="font-medium text-ink">{roleName(act.role)}</span> · {act.labelPlain}</span>
				<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
			</p>
		{/key}
	{:else if working}
		<p class="flex min-w-0 items-center gap-2 text-body-sm text-ink-2" in:appear>
			<span class="size-2 shrink-0 rounded-full bg-pos"></span>
			<span class="min-w-0 truncate" title={step}>{step ?? 'Agents are working on the close'}</span>
			<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
		</p>
	{/if}
</div>

<style>
	.typing {
		display: inline-flex;
		gap: 3px;
	}
	.typing i {
		width: 4px;
		height: 4px;
		border-radius: 999px;
		background: var(--ink-3);
		animation: blink 1.2s infinite ease-in-out;
	}
	.typing i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.typing i:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.typing {
			display: none;
		}
	}
</style>

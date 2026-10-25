<script lang="ts">
	import type { AgentMessage } from '#lib/data/types.js';
	import { MESSAGE_KIND, criticOf, roleName, timeOnly } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import RoleAvatar from './RoleAvatar.svelte';

	let { m, pinned = false }: { m: AgentMessage; pinned?: boolean } = $props();

	const critic = $derived(m.kind === 'critique' ? criticOf(m.body) : undefined);

	const style = $derived(
		m.kind === 'critique'
			? 'border-l-4 bg-neg-soft/60 py-1 pl-3'
			: m.kind === 'ruling' && !pinned
				? 'rounded-btn bg-accent-soft px-3 py-2'
				: m.kind === 'question'
					? 'border-l-4 border-dashed pl-3'
					: ''
	);
</script>

<div class="flex gap-3">
	<RoleAvatar role={m.senderRole} />
	<div class="min-w-0 flex-1 {style}" style={m.kind === 'critique' || m.kind === 'question' ? `border-color: var(--role-${m.senderRole})` : ''}>
		<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
			<span class="font-medium">{roleName(m.senderRole)}</span>
			{#if critic}
				<span class="text-sm text-ink-3" title={critic.scripted ? 'Scripted Demo mode critique' : undefined}>{critic.name}{critic.scripted ? ' (scripted)' : ''}</span>
			{/if}
			{#if m.kind !== 'statement'}
				<span class="text-[13px] font-semibold tracking-wider uppercase {m.kind === 'critique' ? 'text-neg' : m.kind === 'ruling' ? 'text-accent-ink' : 'text-ink-3'}"
					>{pinned ? 'Ruling, pinned' : MESSAGE_KIND[m.kind]}</span
				>
			{/if}
			<time class="num text-xs text-ink-3" datetime={m.createdAt}>{timeOnly(m.createdAt)}</time>
		</div>
		{#if ui.expert}
			<p class="mt-1 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-ink">{m.body}</p>
			<p class="mt-1 text-sm text-ink-3">{m.summaryPlain}</p>
		{:else}
			<p class="mt-0.5 text-[15px] text-ink">{m.summaryPlain}</p>
		{/if}
	</div>
</div>

<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { reportingText } from '#lib/currency-text.js';
	import type { AgentMessage } from '#lib/data/types.js';
	import { MESSAGE_KIND, criticOf, roleName, timeOnly } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import RoleAvatar from './RoleAvatar.svelte';

	let { m, pinned = false }: { m: AgentMessage; pinned?: boolean } = $props();

	/** Amounts in another currency read reporting currency first, the original in brackets. */
	const ym = $derived(db.proposals().find((p) => p.id === m.proposalId)?.periodId ?? (m.threadId.startsWith('close:') ? m.threadId.slice(6) : ui.periodId));
	const say = (text: string) => reportingText(db, text, ym);
	const critic = $derived(m.kind === 'critique' ? criticOf(m.body) : undefined);

	const style = $derived(
		m.kind === 'critique'
			? 'rounded-r-[12px] border-l-2 bg-error-container/45 py-1.5 pr-3 pl-3'
			: m.kind === 'ruling' && !pinned
				? 'rounded-[12px] bg-surface-container px-3 py-2'
				: m.kind === 'question'
					? 'border-l-2 border-dashed pl-3'
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
				<span class="text-[11px] font-semibold tracking-[0.08em] uppercase {m.kind === 'critique' ? 'text-neg' : m.kind === 'ruling' ? 'text-primary' : 'text-ink-3'}"
					>{pinned ? 'Ruling, pinned' : MESSAGE_KIND[m.kind]}</span
				>
			{/if}
			<time class="num text-xs text-ink-3" datetime={m.createdAt}>{timeOnly(m.createdAt)}</time>
		</div>
		{#if ui.expert}
			<p class="mt-1 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-ink">{say(m.body)}</p>
			<p class="mt-1 text-sm text-ink-3">{say(m.summaryPlain)}</p>
		{:else}
			<p class="mt-0.5 text-[15px] text-ink">{say(m.summaryPlain)}</p>
		{/if}
	</div>
</div>

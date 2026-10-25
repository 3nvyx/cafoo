<script lang="ts">
	// Agent status: each agent's latest message or Proposal, its open Proposals, who is working right now, and the
	// state of the outside providers the agents use (Demo, Configured, Connected; the Settings page's own words).
	import { db } from '#lib/data/index.js';
	import { dateTime, roleName } from '#lib/labels.js';
	import { providerState } from '#lib/providers.js';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { DASHBOARD_ROLES, agentStatus } from './insights.js';

	const agents = $derived(agentStatus(DASHBOARD_ROLES, db.agentMessages(), db.proposals()));
	const working = $derived(db.liveActivity());
	const conn = $derived(db.connection());
	const providers = $derived(db.providers().map((p) => ({ p, s: providerState(p, conn) })));
</script>

<section aria-labelledby="agents-h" class="card flex flex-col gap-4 p-5">
	<div class="flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="agents-h" class="text-subtitle">Agent status</h2>
		<a href="/agents" class="drill text-body-sm text-ink-2">All agents</a>
	</div>

	<ul class="flex flex-col" aria-label="Agents">
		{#each agents as a (a.role)}
			<li class="flex items-start gap-3 border-t border-line py-2 first:border-t-0">
				<RoleAvatar role={a.role} size={28} />
				<div class="flex min-w-0 flex-1 flex-col">
					<div class="flex flex-wrap items-center gap-2">
						<a href="/agents" class="drill text-body-sm font-medium text-ink">{roleName(a.role)}</a>
						{#if working?.role === a.role}<Pill tone="accent">Working now</Pill>{/if}
						{#if a.open}<Pill tone="neutral">{a.open} open</Pill>{/if}
					</div>
					{#if working?.role === a.role}
						<p class="truncate text-caption text-ink-2" title={working.labelPlain}>{working.labelPlain}</p>
					{:else if a.last}
						<p class="truncate text-caption text-ink-2" title={a.last.summary}><span class="num text-ink-3">{dateTime(a.last.at)}</span> · {a.last.summary}</p>
					{:else}
						<p class="text-caption text-ink-3">No activity yet</p>
					{/if}
				</div>
			</li>
		{/each}
	</ul>

	{#if providers.length}
		<div class="flex flex-col gap-2 border-t border-line pt-3">
			<p class="text-caption text-ink-2">Providers</p>
			<ul class="flex flex-wrap gap-2" aria-label="Providers">
				{#each providers as { p, s } (p.id)}
					<li title="{p.purpose}. {s.hint}">
						<a href="/settings" class="inline-flex items-center gap-1.5 text-caption text-ink-2"><span class="text-ink">{p.name}</span><Pill tone={s.tone}>{s.label}</Pill></a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<script lang="ts">
	// Hand Luyten a file. Demo mode loads a bundled sample of the chosen kind, shows what was read from it, and the agent
	// that owns it proposes what follows. Lists this page's recent uploads with their status.
	import { db } from '#lib/data/index.js';
	import type { DocumentKind, DocumentStatus } from '#lib/data/types.js';
	import { DOCUMENT, dateTime, roleName, type Tone } from '#lib/labels.js';
	import { attempt } from '#lib/toast.svelte.js';
	import Icon from './Icon.svelte';
	import Pill from './Pill.svelte';

	let { kinds, title = 'Upload a file' }: { kinds: DocumentKind[]; title?: string } = $props();

	let picked = $state<DocumentKind | null>(null);
	// The picked kind while it is still one of this page's; otherwise the first.
	const kind = $derived(picked && kinds.includes(picked) ? picked : kinds[0]);
	let busy = $state(false);

	const recent = $derived(
		db
			.documents()
			.filter((d) => kinds.includes(d.kind))
			.slice(-5)
			.reverse()
	);

	const STATUS: Record<DocumentStatus, { label: string; tone: Tone }> = {
		parsing: { label: 'Reading', tone: 'neutral' },
		parsed: { label: 'Read', tone: 'pos' },
		needs_review: { label: 'Needs a look', tone: 'warn' },
		applied: { label: 'Done', tone: 'pos' },
		rejected: { label: 'Not used', tone: 'muted' }
	};

	async function upload() {
		busy = true;
		await attempt(() => db.uploadDemoDocument(kind), `${DOCUMENT[kind].label} uploaded. Reading it now.`);
		busy = false;
	}
</script>

<section class="card flex flex-col gap-4 p-5" aria-label={title}>
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div class="flex min-w-0 flex-col gap-1">
			<h2 class="text-subtitle">{title}</h2>
			<p class="text-body-sm text-ink-2">Demo files are bundled samples. Nothing leaves your browser.</p>
		</div>
		<div class="flex flex-wrap items-end gap-2">
			{#if kinds.length > 1}
				<label class="flex flex-col gap-1 text-caption text-ink-2">
					File
					<select class="field text-body-sm" value={kind} onchange={(e) => (picked = e.currentTarget.value as DocumentKind)}>
						{#each kinds as k (k)}
							<option value={k}>{DOCUMENT[k].label} ({DOCUMENT[k].format})</option>
						{/each}
					</select>
				</label>
			{/if}
			<button class="btn" onclick={upload} disabled={busy}>
				<Icon name="arrowUp" size={18} />{busy ? 'Uploading…' : kinds.length > 1 ? 'Upload demo file' : `Upload demo ${DOCUMENT[kind].label.toLowerCase()}`}
			</button>
		</div>
	</div>
	<p class="text-caption text-ink-3">{DOCUMENT[kind].label}: {DOCUMENT[kind].readsPlain}.</p>

	{#if recent.length}
		<ul class="flex flex-col divide-y divide-line border-t border-line" aria-live="polite">
			{#each recent as d (d.id)}
				<li class="flex flex-col gap-1 py-3">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="font-medium">{d.fileName}</span>
						<Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill>
						<span class="text-caption text-ink-3">{DOCUMENT[d.kind].label} · read by {roleName(d.readByRole)} · {dateTime(d.uploadedAt)}</span>
					</div>
					<p class="text-body-sm text-ink-2">{d.summaryPlain}</p>
					{#each d.flagsPlain as f (f)}
						<p class="text-body-sm text-ink-2"><span class="font-medium text-ink">Check:</span> {f}</p>
					{/each}
					{#if d.proposalIds.length}
						<a class="drill text-body-sm text-ink-2" href="/proposals?status=all#proposal-{d.proposalIds[0]}">
							{d.proposalIds.length === 1 ? 'See the Proposal it led to' : `See the ${d.proposalIds.length} Proposals it led to`}
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

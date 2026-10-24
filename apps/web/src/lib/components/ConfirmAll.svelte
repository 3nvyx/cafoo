<script lang="ts">
	// "Confirm all N": confirms every ruling waiting for the CFO, one by one, with a progress toast.
	// Shared by the Launchpad queue and the Proposals page's Needs-your-OK view.
	import { db } from '#lib/data/index.js';
	import type { Proposal } from '#lib/data/types.js';
	import { confirmEffect } from '#lib/proposals.js';
	import { toasts } from '#lib/toast.svelte.js';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Icon from './Icon.svelte';

	/** The Proposals waiting for the CFO. The button shows when there are two or more; `class` styles its wrapper. */
	let { proposals, class: cls = '' }: { proposals: Proposal[]; class?: string } = $props();

	let open = $state(false);
	let busy = $state(false);
	const n = $derived(proposals.length);

	async function confirmAll() {
		const items = proposals.filter((p) => p.status === 'awaiting_cfo');
		if (!items.length) return;
		busy = true;
		const tid = toasts.push(`Confirming 0 of ${items.length}…`, 'info', 0);
		let done = 0;
		let posted = 0;
		const failed: string[] = [];
		for (const p of items) {
			const effect = confirmEffect(p, db);
			try {
				await db.cfoConfirm(p.id);
				done++;
				if (effect.posts) posted++;
			} catch (err) {
				failed.push(err instanceof Error ? err.message : String(err));
			}
			toasts.update(tid, `Confirming ${done + failed.length} of ${items.length}…`);
		}
		busy = false;
		if (failed.length) toasts.update(tid, `Confirmed ${done} of ${items.length}. ${failed.length} failed: ${failed[0]}`, 'error', 8000);
		else {
			const books = posted === 0 ? '' : posted === done ? (done === 1 ? ' The entry is posted.' : ' Their entries are posted.') : ` ${posted} of them posted to the books.`;
			toasts.update(tid, `Confirmed all ${done}.${books}`, 'success', 4200);
		}
	}
</script>

{#if n > 1 || busy}
	<div class={cls}>
		<button class="btn btn-primary" disabled={busy} onclick={() => (open = true)}>
			<Icon name="check" size={18} />{busy ? 'Confirming…' : `Confirm all ${n}`}
		</button>
	</div>
{/if}

<ConfirmDialog
	bind:open
	title="Confirm all {n}?"
	body="Confirm all {n} items the Advisor already approved?"
	confirmLabel="Confirm all {n}"
	onconfirm={() => {
		void confirmAll();
	}}
/>

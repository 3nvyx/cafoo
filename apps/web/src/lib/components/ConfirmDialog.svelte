<script lang="ts">
	// Native <dialog>: focus is trapped and Esc closes it for free.
	import Notice from './Notice.svelte';

	let {
		open = $bindable(false),
		title,
		body,
		confirmLabel = 'Confirm',
		danger = false,
		inputLabel,
		inputPlaceholder = '',
		inputRequired = false,
		notice,
		blocked = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		body: string;
		confirmLabel?: string;
		danger?: boolean;
		inputLabel?: string;
		inputPlaceholder?: string;
		inputRequired?: boolean;
		/** A warning shown inside the dialog, e.g. that what it describes changed underneath it. */
		notice?: string;
		/** Keeps the dialog open but disables confirming, so what was typed is not lost. */
		blocked?: boolean;
		onconfirm: (value: string) => void | Promise<void>;
	} = $props();

	let el: HTMLDialogElement | undefined = $state();
	let value = $state('');
	let busy = $state(false);
	const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;

	$effect(() => {
		if (!el) return;
		if (open && !el.open) {
			value = '';
			el.showModal();
		} else if (!open && el.open) el.close();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (blocked || (inputRequired && !value.trim())) return;
		busy = true;
		try {
			await onconfirm(value.trim());
			open = false;
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	bind:this={el}
	onclose={() => (open = false)}
	aria-labelledby="{id}-t"
	aria-describedby="{id}-b"
	class="m-auto w-[min(460px,calc(100vw-32px))] rounded-lg border border-line bg-surface p-0 text-ink"
>
	<form method="dialog" onsubmit={submit} class="flex flex-col gap-4 p-6 sm:p-7">
		<h2 id="{id}-t" class="text-title">{title}</h2>
		<p id="{id}-b" class="text-body text-ink-2">{body}</p>
		{#if notice}<Notice tone="warn">{notice}</Notice>{/if}
		{#if inputLabel}
			<label class="flex flex-col gap-1.5 text-body-sm font-medium">
				{inputLabel}
				<!-- svelte-ignore a11y_autofocus -->
				<input class="field text-body font-normal" bind:value placeholder={inputPlaceholder} maxlength="160" required={inputRequired} autofocus />
			</label>
		{/if}
		<div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
			<button type="button" class="btn btn-quiet" onclick={() => (open = false)}>Cancel</button>
			<button
				type="submit"
				class="btn {danger ? 'btn-danger' : 'btn-primary'}"
				disabled={busy || blocked || (inputRequired && !value.trim())}>{busy ? 'Working…' : confirmLabel}</button
			>
		</div>
	</form>
</dialog>

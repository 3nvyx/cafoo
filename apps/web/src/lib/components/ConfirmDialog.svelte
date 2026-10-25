<script lang="ts">
	// Native <dialog>: focus is trapped and Esc closes it for free.
	let {
		open = $bindable(false),
		title,
		body,
		confirmLabel = 'Confirm',
		danger = false,
		inputLabel,
		inputPlaceholder = '',
		inputRequired = false,
		warning,
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
		/** A caution shown above the buttons, for something the CFO should see before confirming. */
		warning?: string;
		onconfirm: (value: string) => void | Promise<void>;
	} = $props();

	let el: HTMLDialogElement | undefined = $state();
	let value = $state('');
	let busy = $state(false);
	/** The longest reason the field takes. It shows a count so a long reason is never cut off without the CFO seeing it. */
	const MAX_REASON = 600;
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
		if (inputRequired && !value.trim()) return;
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
	class="m-auto w-[min(460px,calc(100vw-32px))] rounded-[var(--radius-dialog)] border-0 bg-surface-3 p-0 text-ink shadow-[var(--elevation-3)]"
>
	<form method="dialog" onsubmit={submit} class="flex flex-col gap-4 p-6 sm:p-7">
		<h2 id="{id}-t" class="text-2xl">{title}</h2>
		<p id="{id}-b" class="text-ink-2">{body}</p>
		{#if warning}
			<p class="rounded-card bg-warning-container px-3 py-2 text-sm text-on-warning-container" role="alert">{warning}</p>
		{/if}
		{#if inputLabel}
			<label class="flex flex-col gap-1.5 text-sm font-medium">
				{inputLabel}
				<!-- svelte-ignore a11y_autofocus -->
				<textarea class="field min-h-[88px] py-2 text-base font-normal" rows="3" bind:value placeholder={inputPlaceholder} maxlength={MAX_REASON} required={inputRequired} autofocus></textarea>
				<span class="num self-end text-xs font-normal text-ink-3" aria-live="polite">{value.length} / {MAX_REASON}</span>
			</label>
		{/if}
		<div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
			<button type="button" class="btn btn-text" onclick={() => (open = false)}>Cancel</button>
			<button
				type="submit"
				class="btn {danger ? 'btn-danger' : 'btn-primary'}"
				disabled={busy || (inputRequired && !value.trim())}>{busy ? 'Working…' : confirmLabel}</button
			>
		</div>
	</form>
</dialog>

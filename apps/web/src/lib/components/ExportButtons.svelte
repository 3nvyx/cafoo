<script lang="ts">
	// "Download CSV" (and, on the Board Pack, "Open in Google Slides"). Live backend: the agent gateway builds the file.
	// Demo mode: the CSV is built here from the rows on screen, and Slides is disabled because it needs the backend.
	import type { CsvTable } from '#lib/csv.js';
	import { downloadCsv, exportSlides, hasBackend, type Dataset } from '#lib/export.js';
	import { attempt, toasts } from '#lib/toast.svelte.js';
	import Icon from './Icon.svelte';

	let { dataset, period, tables, slides = false, disabled = false }: { dataset: Dataset; period: string; tables: () => CsvTable[]; slides?: boolean; disabled?: boolean } = $props();

	let csvBusy = $state(false);
	let slidesBusy = $state(false);
	const live = $derived(hasBackend());

	async function csv() {
		csvBusy = true;
		await attempt(() => downloadCsv(dataset, period, tables));
		csvBusy = false;
	}

	async function openSlides() {
		slidesBusy = true;
		try {
			const url = await exportSlides(dataset, period);
			// A new tab, opened after the wait, can be blocked; keep the link in a toast too.
			const win = window.open(url, '_blank', 'noopener');
			toasts.push(win ? 'The deck is open in Google Slides.' : `The deck is ready: ${url}`, 'success', win ? 4200 : 12000);
		} catch (err) {
			toasts.error(err);
		} finally {
			slidesBusy = false;
		}
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	<button type="button" class="btn" disabled={disabled || csvBusy} onclick={csv}>
		<Icon name="arrowDown" size={16} />{csvBusy ? 'Preparing…' : 'Download CSV'}
	</button>
	{#if slides}
		<span title={live ? undefined : 'Needs the live backend: Demo mode cannot reach Google Slides.'}>
			<button type="button" class="btn" disabled={!live || disabled || slidesBusy} aria-describedby={live ? undefined : 'slides-note'} onclick={openSlides}>
				<Icon name="slides" size={16} />{slidesBusy ? 'Building deck…' : 'Open in Google Slides'}
			</button>
		</span>
		{#if !live}<span id="slides-note" class="sr-only">Google Slides export needs the live backend.</span>{/if}
	{/if}
</div>

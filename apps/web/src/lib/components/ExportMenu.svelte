<script lang="ts">
	// The Export button: the tables the screen shows right now, saved as CSV or as an Excel workbook. The tables are
	// built on click, so a large grid costs nothing until someone asks for it.
	import { download, type ExportTable } from '#lib/export.js';
	import Icon from './Icon.svelte';

	let { tables, title, compact = false }: { tables: () => ExportTable[]; title: string; compact?: boolean } = $props();

	let menu: HTMLDetailsElement | undefined = $state();
	function save(format: 'csv' | 'xlsx') {
		download(tables(), format, title);
		if (menu) menu.open = false;
	}
	function onpointerdown(e: PointerEvent) {
		if (menu?.open && !menu.contains(e.target as Node)) menu.open = false;
	}
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && menu?.open) {
			menu.open = false;
			menu.querySelector('summary')?.focus();
		}
	}
</script>

<svelte:window {onpointerdown} {onkeydown} />

<details
	class="relative"
	bind:this={menu}
	onfocusout={(e) => {
		if (menu?.open && !menu.contains(e.relatedTarget as Node | null)) menu.open = false;
	}}
>
	<summary
		class="flex cursor-pointer list-none items-center gap-1.5 rounded-md font-medium text-ink-2 hover:bg-subtle hover:text-ink [&::-webkit-details-marker]:hidden {compact
			? 'h-7 px-2.5 text-caption'
			: 'btn text-body-sm'}"
	>
		<Icon name="arrowDown" size={14} />Export
	</summary>
	<div class="absolute right-0 z-40 mt-1 flex w-48 flex-col overflow-hidden rounded-md border border-line bg-surface py-1" role="menu">
		<button type="button" role="menuitem" class="flex min-h-8 items-center px-3 text-left text-body-sm text-ink-2 hover:bg-subtle hover:text-ink" onclick={() => save('xlsx')}>Excel workbook (.xlsx)</button>
		<button type="button" role="menuitem" class="flex min-h-8 items-center px-3 text-left text-body-sm text-ink-2 hover:bg-subtle hover:text-ink" onclick={() => save('csv')}>CSV (.csv)</button>
	</div>
</details>

<script lang="ts">
	import { page } from '$app/state';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import Nav from '#lib/components/Nav.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { appear } from '#lib/motion.js';
	import { isTyping, ui } from '#lib/ui.svelte.js';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// The Tables page is a spreadsheet: it takes the whole pane and scrolls inside its own grid, so its header can stick.
	const bleed = $derived(page.url.pathname === '/dash-bar' || page.url.pathname.startsWith('/dash-bar/'));

	function onkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			ui.paletteOpen = !ui.paletteOpen;
			return;
		}
		if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || ui.paletteOpen) return;
		if (e.key === 'Escape') ui.navOpenMobile = false;
	}

	$effect(() => {
		void page.url.pathname;
		ui.navOpenMobile = false;
	});
</script>

<svelte:window onkeydown={onkey} />

<a href="#main" class="sr-only z-50 rounded-btn bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>

<div class="flex {bleed ? 'h-dvh' : 'min-h-dvh'}">
	<aside
		class="sticky top-0 z-20 hidden h-dvh shrink-0 border-r border-line bg-canvas transition-[width] duration-200 lg:block {ui.navCollapsed ? 'w-[72px]' : 'w-[248px]'}"
	>
		<Nav compact={ui.navCollapsed} />
	</aside>

	{#if ui.navOpenMobile}
		<div class="fixed inset-0 z-40 lg:hidden">
			<button class="absolute inset-0 bg-black/40" aria-label="Close navigation" transition:appear onclick={() => (ui.navOpenMobile = false)}></button>
			<aside
				class="absolute inset-y-0 left-0 w-[min(280px,85vw)] border-r border-line bg-canvas"
				transition:fly={{ x: -280, duration: prefersReducedMotion.current ? 0 : 200 }}
				aria-label="Navigation"
			>
				<Nav drawer />
			</aside>
		</div>
	{/if}

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<main id="main" class={bleed ? 'flex min-h-0 w-full flex-1 flex-col pb-20 lg:pb-0' : 'mx-auto w-full max-w-[1200px] flex-1 px-4 pt-6 pb-24 sm:pt-8 lg:px-8 lg:pb-8'}>
			{@render children()}
		</main>
	</div>
</div>

<!-- Phones have no sidebar, so this opens the drawer. Bottom corner: in thumb reach and clear of page headings; main's bottom padding (on every page, the Tables page too) keeps it off the last row. -->
<!-- Stays mounted under the drawer's backdrop, so focus has somewhere to be while the drawer is open. -->
<button
	class="btn fixed right-4 bottom-4 z-30 mb-[env(safe-area-inset-bottom)] size-12 rounded-full border-line px-0 shadow-lg lg:hidden"
	aria-label="Open navigation"
	aria-expanded={ui.navOpenMobile}
	onclick={() => (ui.navOpenMobile = true)}
>
	<Icon name="menu" />
</button>

<CommandPalette />

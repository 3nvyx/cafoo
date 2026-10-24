<script lang="ts">
	// App shell. Phones: top app bar, bottom navigation bar, and a modal drawer behind "More". Tablets: a navigation
	// rail. Desktops: a navigation drawer that collapses to the rail.
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import BottomNav from '#lib/components/BottomNav.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Nav from '#lib/components/Nav.svelte';
	import SeatBanner from '#lib/components/SeatBanner.svelte';
	import TopBar from '#lib/components/TopBar.svelte';
	import { appear } from '#lib/motion.js';
	import { isTyping, ui } from '#lib/ui.svelte.js';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const wide = new MediaQuery('min-width: 1024px');
	const expanded = $derived(wide.current && !ui.navCollapsed);

	function onkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			ui.paletteOpen = !ui.paletteOpen;
			return;
		}
		if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || ui.paletteOpen) return;
		if (e.key.toLowerCase() === 'e') {
			e.preventDefault();
			ui.toggleMode();
		}
		if (e.key === 'Escape') ui.navOpenMobile = false;
	}

	$effect(() => {
		void page.url.pathname;
		ui.navOpenMobile = false;
	});
</script>

<svelte:window onkeydown={onkey} />

<a href="#main" class="sr-only z-50 rounded-full bg-primary px-4 py-2 text-on-primary focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>

<div class="flex min-h-dvh">
	<aside class="sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-surface transition-[width] duration-200 md:block {expanded ? 'w-[256px]' : 'w-[88px]'}">
		<Nav variant={expanded ? 'drawer' : 'rail'} />
	</aside>

	{#if ui.navOpenMobile}
		<div class="fixed inset-0 z-40">
			<button class="absolute inset-0 bg-[var(--scrim)]" aria-label="Close navigation" transition:appear onclick={() => (ui.navOpenMobile = false)}></button>
			<aside
				class="absolute inset-y-0 left-0 w-[min(300px,85vw)] rounded-r-[var(--radius-card)] bg-surface-3 shadow-[var(--elevation-3)]"
				transition:fly={{ x: -300, duration: prefersReducedMotion.current ? 0 : 220 }}
				aria-label="Navigation"
			>
				<button class="btn btn-quiet btn-icon absolute top-3 right-3" aria-label="Close navigation" onclick={() => (ui.navOpenMobile = false)}>
					<Icon name="x" />
				</button>
				<Nav />
			</aside>
		</div>
	{/if}

	<div class="flex min-w-0 flex-1 flex-col">
		<TopBar canCollapse={wide.current} />
		<SeatBanner />
		<main id="main" class="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-6 pb-28 sm:pt-10 md:pb-12 lg:px-10">
			{@render children()}
		</main>
	</div>
</div>

<BottomNav />
<CommandPalette />

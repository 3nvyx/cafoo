<script lang="ts">
	import { page } from '$app/state';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Nav from '#lib/components/Nav.svelte';
	import TopBar from '#lib/components/TopBar.svelte';
	import { appear } from '#lib/motion.js';
	import { isTyping, ui } from '#lib/ui.svelte.js';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

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

<a href="#main" class="sr-only z-50 rounded-btn bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>

<div class="flex min-h-dvh">
	<aside
		class="sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-canvas transition-[width] duration-200 lg:block {ui.navCollapsed ? 'w-[72px]' : 'w-[232px]'}"
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
				<button class="btn btn-quiet absolute top-3 right-3 w-11 px-0" aria-label="Close navigation" onclick={() => (ui.navOpenMobile = false)}>
					<Icon name="x" />
				</button>
				<Nav />
			</aside>
		</div>
	{/if}

	<div class="flex min-w-0 flex-1 flex-col">
		<TopBar />
		<main id="main" class="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:py-8 lg:px-8">
			{@render children()}
		</main>
	</div>
</div>

<CommandPalette />

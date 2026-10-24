<script lang="ts">
	// Material 3 navigation bar for phones: the four most-used destinations plus "More", which opens the drawer.
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { NAV, isActive } from '#lib/nav.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon from './Icon.svelte';

	const items = NAV.filter((n) => n.primary);
	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	// "More" is the active tab when the page is one of the destinations behind it.
	const elsewhere = $derived(!items.some((n) => isActive(page.url.pathname, n.href)));
</script>

<nav
	aria-label="Main"
	class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface-container-low pb-[env(safe-area-inset-bottom)] md:hidden"
>
	{#each items as it (it.href)}
		{@const on = isActive(page.url.pathname, it.href)}
		<a href={it.href} aria-current={on ? 'page' : undefined} class="flex min-h-[72px] flex-col items-center justify-center gap-1 text-[12px] font-medium">
			<span class="state relative grid h-8 w-14 place-items-center rounded-full transition-colors duration-200 {on ? 'bg-secondary-container text-on-secondary-container' : 'text-ink-2'}">
				<Icon name={it.icon} />
				{#if it.href === '/proposals' && waiting > 0}
					<span class="num absolute -top-1 right-1 grid min-w-[18px] place-items-center rounded-full bg-error px-1 text-[11px] leading-[18px] text-on-error" aria-label="{waiting} need your OK">{waiting}</span>
				{/if}
			</span>
			<span class={on ? 'text-ink' : 'text-ink-2'}>{it.label}</span>
		</a>
	{/each}
	<button type="button" class="flex min-h-[72px] flex-col items-center justify-center gap-1 text-[12px] font-medium" aria-haspopup="dialog" onclick={() => (ui.navOpenMobile = true)}>
		<span class="state grid h-8 w-14 place-items-center rounded-full {elsewhere ? 'bg-secondary-container text-on-secondary-container' : 'text-ink-2'}"><Icon name="menu" /></span>
		<span class={elsewhere ? 'text-ink' : 'text-ink-2'}>More</span>
	</button>
</nav>

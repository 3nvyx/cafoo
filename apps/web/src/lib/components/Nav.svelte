<script lang="ts">
	// Material 3 navigation in two shapes: a rail (icon in a pill indicator, label underneath) and a drawer (one row
	// per destination, the active one in a pill). The bottom bar on phones is BottomNav.svelte.
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { MARKETING, NAV, isActive } from '#lib/nav.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon from './Icon.svelte';
	import Wordmark from './Wordmark.svelte';

	let { variant = 'drawer' }: { variant?: 'drawer' | 'rail' } = $props();

	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	const active = (href: string) => isActive(page.url.pathname, href);
</script>

{#if variant === 'rail'}
	<nav aria-label="Main" class="flex h-full flex-col items-center gap-1 overflow-y-auto px-2 py-3">
		<div class="mb-3"><Wordmark compact /></div>
		{#each NAV as it (it.href)}
			<a href={it.href} aria-current={active(it.href) ? 'page' : undefined} class="group flex w-full flex-col items-center gap-1 py-1 text-[12px] font-medium">
				<span
					class="state relative grid h-8 w-14 place-items-center rounded-full transition-colors duration-200 {active(it.href)
						? 'bg-secondary-container text-on-secondary-container'
						: 'text-ink-2 group-hover:text-ink'}"
				>
					<Icon name={it.icon} />
					{#if it.href === '/proposals' && waiting > 0}
						<span class="num absolute -top-1 right-1.5 grid min-w-[18px] place-items-center rounded-full bg-error px-1 text-[11px] leading-[18px] text-on-error" aria-label="{waiting} need your OK"
							>{waiting}</span
						>
					{/if}
				</span>
				<span class="text-center leading-tight {active(it.href) ? 'text-ink' : 'text-ink-2'}">{it.label}</span>
			</a>
		{/each}
		<div class="mt-auto flex w-full flex-col gap-1 border-t border-line pt-3">
			{#each MARKETING as it (it.href)}
				<a href={it.href} class="group flex w-full flex-col items-center gap-1 py-1 text-[12px] font-medium text-ink-2">
					<span class="state grid h-8 w-14 place-items-center rounded-full group-hover:text-ink"><Icon name={it.icon} /></span>
					{it.label}
				</a>
			{/each}
		</div>
	</nav>
{:else}
	<nav aria-label="Main" class="flex h-full flex-col gap-0.5 overflow-y-auto px-3 py-3">
		<div class="mb-4 px-2"><Wordmark /></div>
		{#each NAV as it (it.href)}
			<a
				href={it.href}
				onclick={() => (ui.navOpenMobile = false)}
				aria-current={active(it.href) ? 'page' : undefined}
				class="state flex min-h-[48px] items-center gap-3 rounded-full px-4 text-[15px] transition-colors duration-200 {active(it.href)
					? 'bg-secondary-container font-semibold text-on-secondary-container'
					: 'font-medium text-ink-2 hover:text-ink'}"
			>
				<Icon name={it.icon} />
				<span class="flex-1">{it.label}</span>
				{#if it.href === '/proposals' && waiting > 0}
					<span class="num grid min-w-6 place-items-center rounded-full bg-error px-1.5 text-xs leading-6 text-on-error" aria-label="{waiting} need your OK">{waiting}</span>
				{/if}
			</a>
		{/each}
		<div class="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
			<button
				type="button"
				class="state flex min-h-[48px] items-center gap-3 rounded-full px-4 text-left text-[15px] font-medium text-ink-2 hover:text-ink sm:hidden"
				onclick={() => {
					ui.navOpenMobile = false;
					ui.paletteOpen = true;
				}}><Icon name="search" />Search</button
			>
			{#each MARKETING as it (it.href)}
				<a href={it.href} class="state flex min-h-[48px] items-center gap-3 rounded-full px-4 text-[15px] font-medium text-ink-2 hover:text-ink">
					<Icon name={it.icon} />{it.label}
				</a>
			{/each}
		</div>
	</nav>
{/if}

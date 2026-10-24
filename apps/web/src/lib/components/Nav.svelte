<script lang="ts">
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon, { type IconName } from './Icon.svelte';

	const items: { href: string; label: string; icon: IconName }[] = [
		{ href: '/', label: 'Launchpad', icon: 'home' },
		{ href: '/proposals', label: 'Proposals', icon: 'inbox' },
		{ href: '/agents', label: 'Agents', icon: 'chat' },
		{ href: '/close', label: 'Close', icon: 'checklist' },
		{ href: '/ledger', label: 'Ledger', icon: 'book' },
		{ href: '/reports', label: 'Board Pack', icon: 'chart' },
		{ href: '/customers', label: 'Customers', icon: 'users' },
		{ href: '/vendors', label: 'Vendors', icon: 'truck' },
		{ href: '/settings', label: 'Settings', icon: 'sliders' }
	];

	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	const isActive = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
	let { compact = false }: { compact?: boolean } = $props();
</script>

<nav aria-label="Main" class="flex h-full flex-col gap-1 p-3">
	<a href="/" class="mb-4 flex min-h-[44px] items-center gap-2.5 px-2.5" aria-label="Cafoo home">
		<span class="grid size-7 shrink-0 place-items-center rounded-btn bg-accent font-display text-[15px] font-medium text-on-accent">C</span>
		{#if !compact}<span class="font-display text-lg font-medium tracking-tight">Cafoo</span>{/if}
	</a>
	{#each items as it (it.href)}
		<a
			href={it.href}
			onclick={() => (ui.navOpenMobile = false)}
			aria-current={isActive(it.href) ? 'page' : undefined}
			title={compact ? it.label : undefined}
			class="relative flex min-h-[44px] items-center gap-3 rounded-btn px-2.5 text-[15px] transition-colors duration-150 {isActive(it.href)
				? 'bg-subtle font-medium text-ink'
				: 'text-ink-2 hover:bg-subtle hover:text-ink'}"
		>
			<Icon name={it.icon} />
			{#if !compact}<span class="flex-1">{it.label}</span>{/if}
			{#if it.href === '/proposals' && waiting > 0}
				<span
					class="num grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs leading-5 text-on-accent {compact ? 'absolute top-1 right-1' : ''}"
					aria-label="{waiting} need your OK">{waiting}</span
				>
			{/if}
		</a>
	{/each}
	<div class="mt-auto flex flex-col gap-1 border-t border-line pt-3">
		<button
			type="button"
			class="flex min-h-[44px] items-center gap-3 rounded-btn px-2.5 text-left text-[15px] text-ink-2 hover:bg-subtle hover:text-ink sm:hidden"
			onclick={() => {
				ui.navOpenMobile = false;
				ui.paletteOpen = true;
			}}><Icon name="search" />Search</button
		>
		<a href="/pitch" class="flex min-h-[44px] items-center gap-3 rounded-btn px-2.5 text-[15px] text-ink-2 hover:bg-subtle hover:text-ink" title={compact ? 'Pitch' : undefined}>
			<Icon name="slides" />{#if !compact}Pitch{/if}
		</a>
		<a href="/pricing" class="flex min-h-[44px] items-center gap-3 rounded-btn px-2.5 text-[15px] text-ink-2 hover:bg-subtle hover:text-ink" title={compact ? 'Pricing' : undefined}>
			<Icon name="tag" />{#if !compact}Pricing{/if}
		</a>
	</div>
</nav>

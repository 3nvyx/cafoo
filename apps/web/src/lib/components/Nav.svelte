<script lang="ts">
	// The dashboard sidebar: brand, Search and the collapse toggle on top, grouped destinations that can fold away,
	// and the CFO profile pinned to the bottom. Collapsed to icons, the top holds one button, so Search becomes a row.
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon, { type IconName } from './Icon.svelte';
	import ProfileMenu from './ProfileMenu.svelte';
	import Wordmark from './Wordmark.svelte';

	// A row either navigates (href) or runs an action (onclick); both render through the same snippet.
	interface Item {
		label: string;
		icon: IconName;
		href?: string;
		onclick?: () => void;
	}

	const primary: Item[] = [
		{ href: '/dashboard', label: 'Dashboard', icon: 'home' },
		{ href: '/proposals', label: 'Proposals', icon: 'inbox' },
		{ href: '/agents', label: 'Agents', icon: 'chat' },
		{ href: '/close', label: 'Close', icon: 'checklist' }
	];
	const sections: { title: string; items: Item[] }[] = [
		{
			title: 'Books',
			items: [
				{ href: '/ledger', label: 'Ledger', icon: 'book' },
				{ href: '/reports', label: 'Board Pack', icon: 'chart' }
			]
		},
		{
			title: 'Counterparties',
			items: [
				{ href: '/customers', label: 'Customers', icon: 'users' },
				{ href: '/vendors', label: 'Vendors', icon: 'truck' }
			]
		},
		{
			title: 'Governance',
			items: [{ href: '/charters', label: 'Charters', icon: 'shield' }]
		},
		{
			title: 'Data',
			items: [{ href: '/dash-bar', label: 'Dash bar', icon: 'database' }]
		}
	];

	let { compact = false, drawer = false }: { compact?: boolean; drawer?: boolean } = $props();

	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	const isActive = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

	const shortcut = `${isMac ? '⌘' : 'Ctrl'} K`;
	const search: Item = { label: 'Search', icon: 'search', onclick: () => (ui.paletteOpen = true) };
	function openSearch() {
		ui.navOpenMobile = false;
		ui.paletteOpen = true;
	}

	let folded = $state<Record<string, boolean>>({});
	// 44px rows on touch screens, the denser 36px on desktop. No focus ring: a focused row takes the
	// hover fill instead, so keyboard users still see where they are.
	const row =
		'relative flex min-h-11 items-center gap-3 rounded-card px-2.5 text-left text-[15px] transition-colors duration-150 outline-none focus-visible:bg-subtle focus-visible:text-ink lg:min-h-9';
</script>

{#snippet link(it: Item)}
	{@const active = it.href ? isActive(it.href) : false}
	<!-- Always an <a> or a <button>, both interactive; the checker cannot see through `this`. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svelte:element
		this={it.href ? 'a' : 'button'}
		href={it.href}
		type={it.href ? undefined : 'button'}
		onclick={() => {
			ui.navOpenMobile = false;
			it.onclick?.();
		}}
		aria-current={active ? 'page' : undefined}
		aria-label={compact ? it.label : undefined}
		title={compact ? it.label : undefined}
		class="{row} {compact ? 'justify-center' : ''} {active ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:bg-subtle hover:text-ink'}"
	>
		<Icon name={it.icon} size={18} />
		{#if !compact}<span class="flex-1 truncate">{it.label}</span>{/if}
		{#if it.href === '/proposals' && waiting > 0}
			<span
				class="num grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs leading-5 text-on-accent {compact ? 'absolute top-0.5 right-0.5' : ''}"
				aria-label="{waiting} need your OK">{waiting}</span
			>
		{/if}
	</svelte:element>
{/snippet}

<nav aria-label="Main" class="flex h-full flex-col">
	<div class="flex h-16 shrink-0 items-center gap-1 px-3 {compact ? 'justify-center' : 'justify-between'}">
		{#if !compact}
			<a href="/dashboard" class="flex min-h-[44px] items-center rounded-card px-2" aria-label="Cafoo Dashboard"><Wordmark size={22} /></a>
		{/if}
		<div class="flex items-center gap-0.5">
			{#if !compact}
				<button
					class="btn btn-quiet {drawer ? 'w-11' : 'w-10'} px-0 text-ink-3 hover:text-ink"
					aria-label="Search"
					aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
					title="Search ({shortcut})"
					onclick={openSearch}
				>
					<Icon name="search" size={18} />
				</button>
			{/if}
			{#if drawer}
				<button class="btn btn-quiet w-11 px-0" aria-label="Close navigation" onclick={() => (ui.navOpenMobile = false)}><Icon name="x" /></button>
			{:else}
				<button class="btn btn-quiet w-10 px-0 text-ink-3 hover:text-ink" aria-label={compact ? 'Expand navigation' : 'Collapse navigation'} onclick={() => ui.toggleNav()}>
					<Icon name="panel" size={18} />
				</button>
			{/if}
		</div>
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
		<div class="flex flex-col gap-px">
			{#if compact}{@render link(search)}{/if}
			{#each primary as it (it.href)}{@render link(it)}{/each}
		</div>

		{#each sections as s (s.title)}
			<section class="group flex flex-col gap-px" aria-label={compact ? s.title : undefined}>
				{#if compact}
					<span class="mx-auto mb-1 h-px w-6 bg-line" aria-hidden="true"></span>
				{:else}
					<button
						type="button"
						class="flex min-h-11 items-center gap-1 rounded-card px-2.5 text-left text-[13px] font-medium text-ink-3 hover:text-ink-2 lg:min-h-8"
						aria-expanded={!folded[s.title]}
						onclick={() => (folded[s.title] = !folded[s.title])}
					>
						{s.title}
						<Icon
							name="chevronDown"
							size={14}
							class="opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 {folded[s.title] ? '-rotate-90 opacity-100' : ''}"
						/>
					</button>
				{/if}
				{#if compact || !folded[s.title]}
					{#each s.items as it (it.href)}{@render link(it)}{/each}
				{/if}
			</section>
		{/each}
	</div>

	<div class="shrink-0 px-3 pt-1 pb-3">
		<ProfileMenu {compact} />
	</div>
</nav>

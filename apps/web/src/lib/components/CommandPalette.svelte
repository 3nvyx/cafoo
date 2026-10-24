<script lang="ts">
	// ⌘K: jump to a Customer, Vendor or Account.
	import { goto } from '$app/navigation';
	import { db } from '#lib/data/index.js';
	import { ui } from '#lib/ui.svelte.js';
	import { drill } from '#lib/labels.js';
	import Icon from './Icon.svelte';

	let el: HTMLDialogElement | undefined = $state();
	let q = $state('');
	let active = $state(0);

	interface Hit {
		kind: 'Customer' | 'Vendor' | 'Account';
		label: string;
		hint: string;
		href: string;
	}

	const all = $derived<Hit[]>([
		...db.customers().map((c) => ({ kind: 'Customer' as const, label: c.name, hint: c.domain, href: `/customers/${c.id}` })),
		...db.vendors().map((v) => ({ kind: 'Vendor' as const, label: v.name, hint: v.category, href: `/vendors/${v.id}` })),
		...db.accounts().map((a) => ({ kind: 'Account' as const, label: a.name, hint: a.code, href: drill({ account: a.code }, 'all') }))
	]);

	const hits = $derived.by(() => {
		const s = q.trim().toLowerCase();
		const list = s ? all.filter((h) => h.label.toLowerCase().includes(s) || h.hint.toLowerCase().includes(s)) : all;
		return list.slice(0, 12);
	});

	$effect(() => {
		if (!el) return;
		if (ui.paletteOpen && !el.open) {
			q = '';
			active = 0;
			el.showModal();
		} else if (!ui.paletteOpen && el.open) el.close();
	});

	$effect(() => {
		void q;
		active = 0;
	});

	function go(h: Hit) {
		ui.paletteOpen = false;
		goto(h.href);
	}

	function onkey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, hits.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter' && hits[active]) {
			e.preventDefault();
			go(hits[active]);
		}
	}
</script>

<dialog
	bind:this={el}
	onclose={() => (ui.paletteOpen = false)}
	aria-label="Search customers, vendors and accounts"
	class="mx-auto mt-[12vh] w-[min(560px,calc(100vw-32px))] rounded-card border border-line bg-surface p-0 text-ink"
>
	<div class="flex items-center gap-2 border-b border-line px-4">
		<Icon name="search" class="text-ink-3" />
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="h-14 flex-1 bg-transparent text-base outline-none"
			placeholder="Search customers, vendors, accounts"
			bind:value={q}
			onkeydown={onkey}
			autofocus
			role="combobox"
			aria-expanded="true"
			aria-controls="palette-list"
			aria-activedescendant={hits[active] ? `hit-${active}` : undefined}
		/>
		<kbd class="hidden rounded border border-line px-1.5 font-mono text-xs text-ink-3 sm:inline">Esc</kbd>
	</div>
	<ul id="palette-list" role="listbox" class="max-h-[50vh] overflow-y-auto p-2">
		{#each hits as h, i (h.kind + h.href)}
			<li role="option" id="hit-{i}" aria-selected={i === active}>
				<button
					type="button"
					class="flex min-h-[44px] w-full items-center gap-3 rounded-btn px-3 text-left {i === active ? 'bg-subtle' : ''}"
					onmouseenter={() => (active = i)}
					onclick={() => go(h)}
				>
					<span class="w-[72px] shrink-0 text-xs text-ink-3">{h.kind}</span>
					<span class="flex-1 truncate">{h.label}</span>
					<span class="truncate font-mono text-xs text-ink-3">{h.hint}</span>
				</button>
			</li>
		{:else}
			<li class="px-3 py-6 text-center text-ink-3">Nothing matches “{q}”.</li>
		{/each}
	</ul>
</dialog>

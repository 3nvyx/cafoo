<script lang="ts">
	// The signed-in person at the foot of the sidebar. There is no sign-in yet, so this is a
	// fictitious CFO profile; the menu holds the links that used to sit loose in the nav.
	import Icon, { type IconName } from './Icon.svelte';

	const PROFILE = { name: 'Avery Lin', role: 'CFO · Cafoo Inc', email: 'avery@cafoo.example', initials: 'AL' };

	let { compact = false }: { compact?: boolean } = $props();

	let open = $state(false);
	let root: HTMLElement;
	let trigger: HTMLButtonElement;

	const items: { href: string; label: string; icon: IconName; newTab?: boolean }[] = [
		{ href: '/settings', label: 'Settings', icon: 'sliders' },
		{ href: '/pitch', label: 'Pitch deck', icon: 'slides' },
		{ href: '/', label: 'Cafoo website', icon: 'globe', newTab: true }
	];

	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}
</script>

<!-- Safari does not focus a clicked button, so focusout alone would miss some outside clicks. -->
<svelte:window onclick={(e) => open && !root.contains(e.target as Node) && close()} />

<!-- Escape is handled here, not on the window, so it never reaches the layout's handler that closes the mobile drawer. -->
<div
	bind:this={root}
	class="relative"
	role="presentation"
	onkeydown={(e) => {
		if (open && e.key === 'Escape') {
			e.stopPropagation();
			close(true);
		}
	}}
	onfocusout={(e) => open && !root.contains(e.relatedTarget as Node | null) && close()}
>
	<button
		bind:this={trigger}
		type="button"
		class="flex min-h-12 w-full items-center gap-2.5 rounded-card px-2 text-left hover:bg-subtle {open ? 'bg-subtle' : ''} {compact ? 'justify-center' : ''}"
		aria-expanded={open}
		aria-controls="profile-menu"
		aria-label={compact ? `Profile: ${PROFILE.name}` : undefined}
		onclick={() => (open = !open)}
	>
		<span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-xs font-medium text-accent-ink" aria-hidden="true">{PROFILE.initials}</span>
		{#if !compact}
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="truncate text-[15px] leading-5">{PROFILE.name}</span>
				<span class="truncate text-xs leading-4 text-ink-3">{PROFILE.role}</span>
			</span>
		{/if}
	</button>

	<!-- After the button in the DOM so Tab moves into it; positioned above it on screen. -->
	{#if open}
		<div id="profile-menu" class="card absolute bottom-full left-0 z-50 mb-2 w-[240px] p-1.5 shadow-lg">
			<div class="px-2.5 pt-1.5 pb-2">
				<p class="truncate text-sm font-medium">{PROFILE.name}</p>
				<p class="truncate text-xs text-ink-3">{PROFILE.email}</p>
			</div>
			<ul class="flex flex-col gap-px border-t border-line pt-1.5">
				{#each items as it (it.href)}
					<li>
						<a
							href={it.href}
							target={it.newTab ? '_blank' : undefined}
							rel={it.newTab ? 'noopener' : undefined}
							class="flex min-h-11 items-center gap-3 rounded-card px-2.5 text-sm text-ink-2 hover:bg-subtle hover:text-ink lg:min-h-10"
							onclick={() => close()}
						>
							<Icon name={it.icon} size={18} />{it.label}{#if it.newTab}<span class="sr-only"> (opens in a new tab)</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
			<p class="mt-1.5 border-t border-line px-2.5 pt-2 pb-1 text-xs text-ink-3">Demo profile. Sign-in comes later.</p>
		</div>
	{/if}
</div>

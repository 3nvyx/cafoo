<script lang="ts">
	import type { PostedByRole } from '#lib/data/types.js';
	import { ROLE } from '#lib/labels.js';

	let { role, size = 32 }: { role: PostedByRole; size?: number } = $props();
	const r = $derived(ROLE[role] ?? ROLE.system);
	// Only agent roles have their own color; everything else uses the neutral one.
	const tone = $derived(role in ROLE && role !== 'seed' ? role : 'system');
</script>

<span
	class="inline-grid shrink-0 place-items-center rounded-full font-mono font-medium select-none"
	style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.34)}px;color:var(--role-{tone});background:color-mix(in srgb, var(--role-{tone}) 14%, transparent);"
	title={r.name}
	aria-hidden="true">{r.initials}</span
>

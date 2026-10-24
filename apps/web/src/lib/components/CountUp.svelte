<script lang="ts">
	// Animates a money figure toward its new value. Instant when reduced motion is on.
	import { Tween, prefersReducedMotion } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { formatMoney, toNumber } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';

	let { minor, compact = false, whole = true }: { minor: Minor; compact?: boolean; whole?: boolean } = $props();

	const tween = new Tween(0, { duration: 900, easing: cubicOut });

	$effect(() => {
		const target = toNumber(minor);
		tween.set(target, { duration: prefersReducedMotion.current ? 0 : 900 });
	});

	const shown = $derived(formatMoney(Math.round(tween.current * 100).toString(), { compact, whole }));
</script>

<span class="num">{shown}</span>

<script lang="ts">
	// Animates a money figure toward its new value. Instant when reduced motion is on or the page is hidden.
	import { Tween, prefersReducedMotion } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { formatMoney, toNumber } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';

	let { minor, compact = false, whole = true, currency }: { minor: Minor; compact?: boolean; whole?: boolean; currency?: string } = $props();

	const tween = new Tween(0, { duration: 900, easing: cubicOut });

	$effect(() => {
		const target = toNumber(minor);
		// A hidden page gets no animation frames, so a tween would sit at its old value: jump straight there instead.
		const still = prefersReducedMotion.current || document.hidden;
		tween.set(target, { duration: still ? 0 : 900 });
	});

	const shown = $derived(formatMoney(Math.round(tween.current * 100).toString(), { compact, whole, currency }));
</script>

<span class="num">{shown}</span>

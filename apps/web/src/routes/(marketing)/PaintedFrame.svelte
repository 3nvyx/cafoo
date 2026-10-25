<script lang="ts">
	// A rounded panel lined with the painted sky, so the hero's brushwork shows up again further down
	// the page as a frame around content, never as a texture behind running text. Whatever goes
	// inside sets the size; pass padding through `class` to decide how much paint shows. The shader
	// is heavy, so the sky mounts only once the frame comes within 400px of the viewport.
	import type { Snippet } from 'svelte';
	import PaintedSky from './PaintedSky.svelte';

	let { seed = 11, class: cls = '', children }: { seed?: number; class?: string; children: Snippet } = $props();
	let near = $state(false);

	function whenNear(node: HTMLElement) {
		const io = new IntersectionObserver(
			([e]) => {
				if (!e.isIntersecting) return;
				near = true;
				io.disconnect();
			},
			{ rootMargin: '400px 0px' }
		);
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}
</script>

<div use:whenNear class="relative isolate overflow-hidden rounded-3xl {cls}">
	{#if near}<div class="absolute inset-0 -z-10"><PaintedSky {seed} /></div>{/if}
	{@render children()}
</div>

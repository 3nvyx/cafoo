<script lang="ts">
	import '../app.css';
	import Toaster from '#lib/components/Toaster.svelte';
	import { ui } from '#lib/ui.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	ui.init();
</script>

<svelte:head>
	<title>Cafoo</title>
</svelte:head>

{@render children()}
<Toaster />

<script lang="ts">
	// Self-hosted, open-licensed fonts: Newsreader (display serif), Instrument Sans (interface), IBM Plex Mono (figures).
	import '@fontsource-variable/newsreader/opsz.css';
	import '@fontsource-variable/instrument-sans/wght.css';
	import '@fontsource/ibm-plex-mono/400.css';
	import '@fontsource/ibm-plex-mono/500.css';
	import '@fontsource/ibm-plex-mono/600.css';
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

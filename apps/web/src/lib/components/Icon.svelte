<script lang="ts" module>
	// Simple 24px stroke icons drawn for this app.
	export const PATHS = {
		home: 'M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z',
		inbox: 'M4 13.5 6.5 5h11l2.5 8.5V19H4zM4 13.5h4.5l1 2h5l1-2H20',
		chat: 'M4 5h16v11H10l-4 3.5V16H4z',
		checklist: 'M10 7h10M10 12h10M10 17h10M4 7l1.2 1.2L7.5 6M4 12l1.2 1.2L7.5 11M4 17l1.2 1.2L7.5 16',
		book: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H19v13H6.5A1.5 1.5 0 0 0 5 18.5zM5 18.5A1.5 1.5 0 0 0 6.5 20H19',
		chart: 'M4 20h16M6.5 20v-6M11 20V8M15.5 20v-9M20 20V5',
		users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M21.5 20a6.5 6.5 0 0 0-4-6',
		truck: 'M3 6h11v10H3zM14 9.5h3.5L21 13v3h-7M6.5 19.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM17 19.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z',
		sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
		search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.5-4.5',
		menu: 'M4 7h16M4 12h16M4 17h16',
		x: 'M6 6l12 12M18 6 6 18',
		chevronLeft: 'M15 5l-7 7 7 7',
		chevronRight: 'M9 5l7 7-7 7',
		chevronDown: 'M5 9l7 7 7-7',
		lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
		play: 'M7 5v14l12-7z',
		pause: 'M8 5v14M16 5v14',
		arrowRight: 'M5 12h14M13 6l6 6-6 6',
		check: 'M5 12.5l4.5 4.5L19 7.5',
		alert: 'M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01',
		slides: 'M3.5 5h17v11h-17zM12 16v4M8 20h8',
		tag: 'M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5zM8 8.01V8',
		undo: 'M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2',
		panel: 'M4 5h16v14H4zM9 5v14',
		arrowUp: 'M12 19V5M6 11l6-6 6 6',
		arrowDown: 'M12 5v14M6 13l6 6 6-6',
		external: 'M14 4h6v6M20 4l-9 9M19 14v5H5V5h5',
		globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let { name, size = 20, class: cls = '' }: { name: IconName; size?: number; class?: string } = $props();
</script>

<svg
	class={cls}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"><path d={PATHS[name]} /></svg
>

// Unit tests run on plain Vite, without the SvelteKit plugin: that plugin writes the dev server's generated env
// (.svelte-kit/generated/dev/env) from the test process's environment, which would switch a running live dev server
// (PUBLIC_DATA_SOURCE=spacetime) to Demo mode. The plain Svelte plugin only compiles runes, so the Demo data source
// (a .svelte.ts class) can be tested without it.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte({ configFile: false })],
	test: { include: ['src/**/*.test.ts'] }
});

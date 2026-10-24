// Unit tests run on plain Vite, without the SvelteKit plugin: that plugin writes the dev server's generated env
// (.svelte-kit/generated/dev/env) from the test process's environment, which would switch a running live dev server
// (PUBLIC_DATA_SOURCE=spacetime) to Demo mode. The tests cover pure modules, so they need none of it.
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.test.ts'] }
});

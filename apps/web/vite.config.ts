import adapter from '@sveltejs/adapter-auto';
import staticAdapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// GitHub Pages serves the site under /<repo>; scripts/build-pages.mjs sets this and builds a static SPA.
const pagesBase = process.env.PAGES_BASE;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: pagesBase ? staticAdapter({ pages: 'build-pages', fallback: '404.html', strict: false }) : adapter(),
			paths: pagesBase ? { base: pagesBase } : undefined,
			// The prerendered landing page links to root paths; build-pages.mjs prefixes them after the build.
			prerender: pagesBase ? { handleHttpError: 'ignore' } : undefined,

			// The generated env lives here, so two dev servers with different PUBLIC_* values need different folders
			// (the demo's launch config sets its own); otherwise the last one started switches the other's data.
			outDir: process.env.CAFOO_KIT_OUT_DIR || '.svelte-kit'
		})
	]
});

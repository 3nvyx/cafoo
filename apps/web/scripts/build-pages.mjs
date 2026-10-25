// Builds the web app in Demo mode as a static SPA for GitHub Pages, served under /<repo>.
// The app writes root paths such as href="/dashboard" and url(/logos/...) directly, so after the
// build every such path is prefixed with the base. Each top-level route also gets its own
// index.html, so GitHub Pages answers it with 200 instead of the 404 fallback.
// Usage: node scripts/build-pages.mjs [/base]   (default /luyten); output in build-pages/.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? '/luyten';
const out = 'build-pages';

// Top-level route folders (route groups such as (app) unwrapped) and the static files and folders.
const routes = [];
const collect = (dir) => {
	for (const name of readdirSync(dir)) {
		if (!statSync(join(dir, name)).isDirectory()) continue;
		if (name.startsWith('(')) collect(join(dir, name));
		else if (!name.startsWith('[')) routes.push(name);
	}
};
collect('src/routes');
const prefixes = [...routes, ...readdirSync('static')].map((p) => p.replace(/[.]/g, '\\.'));

execSync('pnpm exec vite build', { stdio: 'inherit', env: { ...process.env, PAGES_BASE: base, PUBLIC_DATA_SOURCE: 'mock' } });

// A root path starts right after a quote, a backtick or "(" (CSS url()). "/" alone only as an href.
const rootPath = new RegExp(`(["'\`(])/(?=(?:${prefixes.join('|')})(?:[/"'\`?#)$]|$))`, 'g');
const homeHref = /(href=\\?["']|'href',\s*')\/(?=\\?["'])/g;
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.(html|js|css)$/.test(name)) {
			const text = readFileSync(path, 'utf8');
			const next = text.replace(rootPath, `$1${base}/`).replace(homeHref, `$1${base}/`);
			if (next !== text) writeFileSync(path, next);
		}
	}
};
walk(out);

// Prerendered pages (the landing page) keep their own HTML; every other route gets the SPA shell.
const shell = (dir) => {
	mkdirSync(dir, { recursive: true });
	if (!existsSync(join(dir, 'index.html')) && !existsSync(`${dir}.html`)) copyFileSync(join(out, '404.html'), join(dir, 'index.html'));
};
shell(out);
for (const route of routes) shell(join(out, route));
// Jekyll would hide the _app folder.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Built ${out}/ for ${base} with ${routes.length} routes.`);

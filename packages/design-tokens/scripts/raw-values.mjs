// Scans apps/web/src for values that bypass the design tokens. Shared by the
// vitest check (tests/raw-values.test.ts) and the baseline script.
// Four kinds are counted per file:
//   raw-colour     hex, rgb(), hsl(), oklch() literals in a value position, and named colours on fill/stroke/color
//   bracket-size   arbitrary values carrying a px/rem/em number, e.g. text-[13px], grid-cols-[1fr_110px], [font-size:13px]
//   palette-class  Tailwind's built-in palette, e.g. bg-red-500, text-gray-600, bg-black/40
//   unknown-class  a colour, text-size or radius utility whose value is neither a token nor a Tailwind non-colour
//                  value, e.g. bg-primary-container, text-sm, rounded-2xl
// .css files are scanned for raw-colour only: class names do not occur there and CSS properties look like them.
// <style> blocks and style="" attributes in .svelte files are likewise scanned for raw-colour only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, '..');
export const WEB_SRC = resolve(PACKAGE_ROOT, '../../apps/web/src');
export const CSS_FILE = resolve(PACKAGE_ROOT, 'css/cafoo-tokens.css');
export const BASELINE_FILE = resolve(here, 'raw-values-baseline.json');

/** Brand artwork: colour math that is the design, not UI. One reason per entry. */
export const ALLOWLIST = {
	'lib/components/Wordmark.svelte': 'chrome-effect gradient stops of the wordmark',
	'routes/(marketing)/PaintedSky.svelte': 'painterly WebGL shader palette',
	'routes/(marketing)/PaintedFrame.svelte': 'frame around the painted hero',
	'routes/(marketing)/River.svelte': 'streamline glints of the page river',
	'routes/(marketing)/Swirls.svelte': 'brushwork vortices',
};

export const KINDS = ['raw-colour', 'bracket-size', 'palette-class', 'unknown-class'];

// Longest first, so border-b-line is read as border-b + line, and ring-offset-canvas as ring-offset + canvas.
const COLOUR_PREFIXES = [
	'bg', 'text', 'border', 'border-t', 'border-r', 'border-b', 'border-l', 'border-x', 'border-y', 'border-s', 'border-e',
	'ring', 'ring-offset', 'fill', 'stroke', 'from', 'via', 'to', 'outline', 'decoration', 'accent', 'caret', 'shadow',
	'divide', 'placeholder', 'inset-ring', 'inset-shadow',
].sort((a, b) => b.length - a.length);
const VARIANT = '(?:[a-z0-9-]+:)*';
const PALETTE_NAMES =
	'(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)';

// In markup a hex only counts in a value position (after : = ( , [ or a quote), so href="#add-row" and
// "Invoice #1042" do not. In CSS (stylesheets, <style> blocks, style attributes) any hex counts: `solid #000`.
const RE_COLOUR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/.source;
const RE_NAMED =
	/\b(?:fill|stroke|color|background(?:-color)?)\s*[:=]\s*["']?(?:white|black|red|green|blue|gr[ae]y|yellow|orange|purple|pink|silver|navy|teal)\b/.source;
const RE_RAW_COLOUR = new RegExp(`(?<=[:=(,\\["'\`]\\s?)#[0-9a-fA-F]{3,8}(?![\\w-])|${RE_COLOUR_FN}|${RE_NAMED}`, 'gi');
const RE_RAW_COLOUR_CSS = new RegExp(`#[0-9a-fA-F]{3,8}(?![\\w-])|${RE_COLOUR_FN}|${RE_NAMED}`, 'gi');
// Fragment references are not colours: url(#clip), href="#section", querySelector('#id').
const RE_FRAGMENT_REF = /url\(\s*#[^)]*\)|href\s*=\s*["']#[^"']*["']|querySelector(?:All)?\(\s*["'`]#[^"'`]*["'`]\s*\)/g;
const RE_BRACKET_SIZE = /(?<![\w])-?\[[^\]\n]*\d(?:\.\d+)?(?:px|rem|em)\b[^\]\n]*\]/g;
const RE_PALETTE = new RegExp(
	`(?<![\\w-])${VARIANT}(?:${COLOUR_PREFIXES.join('|')})-${PALETTE_NAMES}(?:-\\d{2,3})?(?:/\\d{1,3})?(?![\\w-])`,
	'g',
);
// Gradient stops (from/via/to) are left out here: as prose words ("to-do", "from-scratch") they are far more
// common than as classes. The palette regex above still catches from-red-500.
const CLASS_PREFIXES = [...COLOUR_PREFIXES.filter((p) => !['from', 'via', 'to'].includes(p)), 'rounded'].sort(
	(a, b) => b.length - a.length,
);
const RE_COLOUR_CLASS = new RegExp(
	`(?<![\\w-])${VARIANT}(${CLASS_PREFIXES.join('|')})-([a-z0-9]+(?:-[a-z0-9]+)*)(?:/\\d{1,3})?(?![\\w-])`,
	'g',
);
const RE_STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/g;
const RE_STYLE_ATTR = /\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g;
const RADIUS_SIDE = /^(?:ss|se|ee|es|tl|tr|br|bl|[trblse])-/;

/** Tailwind values for the colour-capable utilities that are not colours. */
const NON_COLOUR_VALUES = {
	common: new Set(['transparent', 'current', 'inherit', 'none', 'auto', 'color']),
	// Tailwind's size names (text-xs … text-9xl) are deliberately absent: the theme switches them off.
	text: new Set([
		'left', 'right', 'center', 'justify', 'start', 'end', 'balance', 'pretty', 'wrap', 'nowrap', 'clip', 'ellipsis',
		'anchor', 'decoration', 'shadow', 'rendering', 'transform', 'overflow', 'indent', 'underline', 'align',
	]),
	bg: new Set([
		'cover', 'contain', 'fixed', 'local', 'scroll', 'center', 'top', 'bottom', 'left', 'right', 'repeat', 'no-repeat',
		'clip-border', 'clip-padding', 'clip-content', 'clip-text', 'origin-border', 'origin-padding', 'origin-content',
		'gradient-to-t', 'gradient-to-tr', 'gradient-to-r', 'gradient-to-br', 'gradient-to-b', 'gradient-to-bl',
		'gradient-to-l', 'gradient-to-tl', 'linear-to-t', 'linear-to-tr', 'linear-to-r', 'linear-to-br', 'linear-to-b',
		'linear-to-bl', 'linear-to-l', 'linear-to-tl', 'radial', 'conic', 'blend-normal', 'blend-multiply', 'blend-screen',
		'blend-overlay', 'blend-darken', 'blend-lighten', 'blend-difference', 'blend-exclusion', 'blend-hue',
		'blend-saturation', 'blend-color', 'blend-luminosity', 'position', 'size', 'image', 'repeat-x', 'repeat-y',
		'repeat-round', 'repeat-space',
	]),
	border: new Set([
		'solid', 'dashed', 'dotted', 'double', 'hidden', 'collapse', 'separate', 'spacing', 'x', 'y', 's', 'e', 't', 'r',
		'b', 'l', 'x-reverse', 'y-reverse', 'radius', 'width', 'style', 'box', 'image',
	]),
	divide: new Set(['x', 'y', 'x-reverse', 'y-reverse', 'solid', 'dashed', 'dotted', 'double', 'hidden']),
	ring: new Set(['inset', 'offset', 'width', 'offset-width']),
	'ring-offset': new Set([]),
	outline: new Set(['solid', 'dashed', 'dotted', 'double', 'hidden', 'offset', 'width', 'style']),
	shadow: new Set(['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner', 'inset']),
	decoration: new Set(['solid', 'double', 'dotted', 'dashed', 'wavy', 'slice', 'clone', 'from-font', 'auto', 'thickness', 'style', 'line']),
	fill: new Set(['rule', 'opacity', 'mode', 'available']),
	stroke: new Set(['width', 'linejoin', 'linecap', 'dasharray', 'dashoffset', 'miterlimit', 'opacity']),
	accent: new Set(['auto']),
	caret: new Set([]),
	placeholder: new Set(['shown', 'opacity']),
	from: new Set([]),
	via: new Set([]),
	to: new Set([]),
	'inset-ring': new Set([]),
	'inset-shadow': new Set(['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'none']),
	// Tailwind's size names (rounded-xs, rounded-2xl …) are deliberately absent: the theme switches them off.
	rounded: new Set(['full', 'none']),
};
const NUMERIC_OR_FRACTION = /^(?:\d+(?:\.\d+)?|\d+\/\d+|px|full)$/;

export function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === 'module_bindings' || entry === 'node_modules') continue;
			walk(full, out);
		} else if (/\.(svelte|ts|css)$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
			out.push(full);
		}
	}
	return out.sort();
}

/** Token class names from the generated CSS: everything declared as --color-* in its @theme block. */
export function tokenColourNames(css = readFileSync(CSS_FILE, 'utf8')) {
	const names = new Set();
	for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(m[1]);
	return names;
}

function basePrefix(prefix) {
	if (prefix.startsWith('border-')) return 'border';
	if (prefix === 'ring-offset') return 'ring';
	return prefix;
}

function isNonColourValue(prefix, value) {
	const base = basePrefix(prefix);
	if (NON_COLOUR_VALUES.common.has(value)) return true;
	if (NON_COLOUR_VALUES[base]?.has(value)) return true;
	if (NUMERIC_OR_FRACTION.test(value)) return true;
	if (base === 'border' && /^(?:[xystrbl]|[xy]-reverse|spacing(?:-[xy])?)-\d+$/.test(value)) return true;
	if (base === 'bg' && /^(?:linear|conic|radial)-/.test(value)) return true;
	if (base === 'text' && /^decoration-/.test(value)) return true; // CSS property names quoted in scripts
	if (base === 'divide' && /^[xy]-\d+$/.test(value)) return true;
	if ((base === 'ring' || base === 'outline') && /^offset-\d+$/.test(value)) return true;
	return false;
}

/** Count violations of each kind in one source string. `kind` is 'css' for stylesheets, else 'markup'. */
export function scan(source, tokenNames, kind = 'markup') {
	const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
	const samples = Object.fromEntries(KINDS.map((k) => [k, []]));
	const hit = (kind, text) => {
		counts[kind]++;
		if (samples[kind].length < 5 && !samples[kind].includes(text)) samples[kind].push(text);
	};
	if (kind === 'css') {
		for (const m of source.matchAll(RE_RAW_COLOUR_CSS)) hit('raw-colour', m[0]);
		return { counts, samples };
	}
	// <style> bodies and style="" attributes are CSS: looser colour rule, no class scanning (CSS properties would read as classes).
	const styles = [...source.matchAll(RE_STYLE_BLOCK), ...source.matchAll(RE_STYLE_ATTR)].map((m) => m[0]).join('\n');
	for (const m of styles.matchAll(RE_RAW_COLOUR_CSS)) hit('raw-colour', m[0]);
	const markup = source.replace(RE_STYLE_BLOCK, ' ').replace(RE_STYLE_ATTR, ' ');
	for (const m of markup.replace(RE_FRAGMENT_REF, ' ').matchAll(RE_RAW_COLOUR)) hit('raw-colour', m[0]);
	for (const m of markup.matchAll(RE_BRACKET_SIZE)) hit('bracket-size', m[0]);
	for (const m of markup.matchAll(RE_PALETTE)) hit('palette-class', m[0]);
	for (const m of markup.matchAll(RE_COLOUR_CLASS)) {
		const [whole, prefix, value] = m;
		if (RE_PALETTE.test(whole)) {
			RE_PALETTE.lastIndex = 0;
			continue; // already counted as palette-class
		}
		RE_PALETTE.lastIndex = 0;
		if (prefix === 'rounded') {
			const radius = value.replace(RADIUS_SIDE, '');
			if (tokenNames.has(`rounded:${radius}`) || isNonColourValue('rounded', radius)) continue;
			hit('unknown-class', whole);
			continue;
		}
		if (tokenNames.has(value)) continue;
		// Tailwind's type scale (text-caption etc.) is a token too: --text-* in the theme.
		if (prefix === 'text' && tokenNames.has(`text:${value}`)) continue;
		if (isNonColourValue(prefix, value)) continue;
		hit('unknown-class', whole);
	}
	return { counts, samples };
}

/** Token names the scan accepts: colour names, "text:<step>" for the type scale and "rounded:<name>" for radii. */
export function acceptedNames(css = readFileSync(CSS_FILE, 'utf8')) {
	const at = css.indexOf('@theme inline {');
	if (at === -1) throw new Error(`${CSS_FILE} has no @theme block; run: pnpm -F @cafoo/design-tokens build`);
	const theme = css.slice(at);
	const names = tokenColourNames(theme);
	for (const m of theme.matchAll(/--text-([a-z0-9-]+?)(?:--[a-z-]+)?\s*:/g)) names.add(`text:${m[1]}`);
	for (const m of theme.matchAll(/--radius-([a-z0-9-]+)\s*:/g)) names.add(`rounded:${m[1]}`);
	return names;
}

export function scanWebSource(css) {
	const names = acceptedNames(css);
	const result = {};
	for (const file of walk(WEB_SRC)) {
		// Forward slashes on every platform, so Windows paths match the committed baseline's keys.
		const rel = relative(WEB_SRC, file).split('\\').join('/');
		if (ALLOWLIST[rel]) continue;
		const { counts, samples } = scan(readFileSync(file, 'utf8'), names, file.endsWith('.css') ? 'css' : 'markup');
		if (Object.values(counts).some((n) => n > 0)) result[rel] = { counts, samples };
	}
	return result;
}

export function readBaseline() {
	return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

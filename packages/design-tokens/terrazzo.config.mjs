// Terrazzo build: DTCG token files -> css/luyten-tokens.css.
// Only the semantic tier reaches the CSS. Aliases are inlined to literals, so
// primitives (palette ramps, sizes, font stacks) never exist as CSS variables.
// scripts/build.mjs runs this, then appends the Tailwind @theme block.
import { defineConfig } from '@terrazzo/cli';
import css from '@terrazzo/plugin-css';
import { transformCSSValue } from '@terrazzo/token-tools/css';

/** Resolve a token to a literal, following aliases instead of emitting var(). */
const literal = (token, options) => transformCSSValue(token, { ...options, transformAlias: (t) => literal(t, options) });

/** color.canvas -> --canvas; role.advisor -> --role-advisor; type.body -> --type-body; shape.md -> --shape-md */
const variableName = (token) => '--' + token.id.replace(/^color\./, '').replace(/\./g, '-');

const PRIMITIVES = ['palette.**', 'size.**', 'font.**'];
/** Tokens that do not change with the mode need no dark block. */
const MODELESS = ['type.**', 'shape.**'];

export default defineConfig({
	tokens: ['./tokens/primitives.tokens.json', './tokens/semantic.tokens.json'],
	outDir: process.env.LUYTEN_TOKENS_OUT ?? './css/',
	plugins: [
		css({
			filename: 'luyten-tokens.css',
			legacyHex: true,
			exclude: PRIMITIVES,
			variableName,
			transform: literal,
			permutations: [
				{ input: { tzMode: 'light' }, prepare: (c) => `:root {\n${c}\n}` },
				{ input: { tzMode: 'dark' }, exclude: MODELESS, prepare: (c) => `:root[data-theme='dark'] {\n${c}\n}` },
				{
					input: { tzMode: 'dark' },
					exclude: MODELESS,
					prepare: (c) => `@media (prefers-color-scheme: dark) {\n\t:root:not([data-theme='light']) {\n${c}\n\t}\n}`,
				},
			],
		}),
	],
});

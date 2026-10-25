// A small reader for the token files, independent of Terrazzo, so the checks
// judge the source itself. Handles aliases ({a.b.c}), $extensions.mode and both
// colour forms (hex string, or DTCG object with a hex fallback).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
export const TOKEN_FILES = ['tokens/primitives.tokens.json', 'tokens/semantic.tokens.json'];
export const MODES = ['light', 'dark'];

/** @typedef {{ id: string, path: string[], $type?: string, $value: unknown, $description?: string, $extensions?: Record<string, unknown>, file: string }} Token */

const RESERVED = new Set(['$value', '$type', '$description', '$extensions', '$deprecated', '$comment']);

/** @returns {Map<string, Token>} */
export function loadTokens(files = TOKEN_FILES) {
	const tokens = new Map();
	for (const file of files) {
		const json = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, file), 'utf8'));
		walk(json, [], undefined, file, tokens);
	}
	return tokens;
}

function walk(node, path, inheritedType, file, out) {
	if (node === null || typeof node !== 'object') return;
	const type = node.$type ?? inheritedType;
	if ('$value' in node) {
		out.set(path.join('.'), {
			id: path.join('.'),
			path,
			$type: type,
			$value: node.$value,
			$description: node.$description,
			$extensions: node.$extensions,
			file,
		});
		return;
	}
	for (const [key, child] of Object.entries(node)) {
		if (RESERVED.has(key) || key.startsWith('$')) continue;
		walk(child, [...path, key], type, file, out);
	}
}

const ALIAS = /^\{([^}]+)\}$/;

export function aliasTarget(value) {
	return typeof value === 'string' ? (ALIAS.exec(value)?.[1] ?? null) : null;
}

/** The raw (possibly aliased) value a token has in a mode: its mode override, else its default $value. */
export function valueIn(token, mode) {
	const modes = token.$extensions?.mode;
	return modes && mode in modes ? modes[mode] : token.$value;
}

/** Follow aliases until a literal, in the given mode. Throws on a dangling or circular reference. */
export function resolveValue(tokens, id, mode, seen = []) {
	const token = tokens.get(id);
	if (!token) throw new Error(`token "${id}" does not exist (referenced from ${seen.at(-1) ?? 'the test'})`);
	if (seen.includes(id)) throw new Error(`circular alias: ${[...seen, id].join(' -> ')}`);
	const raw = valueIn(token, mode);
	const target = aliasTarget(raw);
	if (target) return resolveValue(tokens, target, mode, [...seen, id]);
	return raw;
}

export function toHex(value, id) {
	if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
	if (value && typeof value === 'object' && typeof value.hex === 'string') {
		const hex = value.hex.toLowerCase();
		const alpha = typeof value.alpha === 'number' && value.alpha < 1 ? Math.round(value.alpha * 255).toString(16).padStart(2, '0') : '';
		return hex + alpha;
	}
	throw new Error(`"${id}" is not a 6-digit hex colour (got ${JSON.stringify(value)})`);
}

/** CSS variable name the build gives a semantic token: color.x -> --x, role.x -> --role-x, type.x -> --type-x. */
export function cssName(id) {
	return '--' + id.replace(/^color\./, '').replace(/\./g, '-');
}

export function relativeLuminance(hex) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
	const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
}

// The Charter editor's pure helpers. The gateway's eval runner (apps/agents/src/charter/coverage.ts) is the authority
// on whether a version only tightens the gate, and the module refuses to publish without a passing full eval; these
// helpers only read charter text the same way and point out problems before a draft is saved.
import type { CharterCatalog, CharterEval, CharterMappingEntry, CharterMappingTarget, CharterParamSpec, CharterRole, CharterTemplate, CharterVersion } from './data/types';

export const CHARTER_ROLES: CharterRole[] = ['bookkeeper', 'revenue', 'credit', 'consolidation', 'redteam', 'advisor'];

/** Roles that propose, which the '*' templates (amount cap, narrower kinds) apply to. */
const WORKERS = new Set(['bookkeeper', 'revenue', 'credit', 'consolidation']);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const SECTIONS: Record<string, string> = { May: 'May', 'Must never': 'Must never', Escalates: 'Escalates', 'Plain summary rule': 'Plain summary' };

export interface CharterLine {
	label: string;
	text: string;
}

/**
 * A Charter's numbered lines in document order ("May 1", "Must never 2", "Escalates 3"), then the Plain summary rule,
 * by the same algorithm as the eval harness (packages/eval-harness/src/charter.ts charterLines): `## May`,
 * `## Must never`, `## Escalates` hold numbered lines, `## Plain summary rule` is one line, any other heading ends a
 * section.
 */
export function parseCharterLines(bodyMd: string): CharterLine[] {
	const out: CharterLine[] = [];
	let section: string | undefined;
	let plain: string | undefined;
	for (const raw of bodyMd.split('\n')) {
		const heading = /^##\s+(.+?)\s*$/.exec(raw);
		if (heading) {
			section = SECTIONS[heading[1]!];
			continue;
		}
		if (!section || !raw.trim()) continue;
		if (section === 'Plain summary') {
			plain = squash(`${plain ?? ''} ${raw}`);
			continue;
		}
		const numbered = /^(\d+)\.\s+(.*)$/.exec(raw);
		if (numbered) out.push({ label: `${section} ${numbered[1]}`, text: squash(numbered[2]!) });
	}
	if (plain) out.push({ label: 'Plain summary', text: plain });
	return out;
}

/** The Built-in Charter's lines and what each maps to, by label. */
export function shippedTargets(catalog: CharterCatalog, role: string): Map<string, CharterMappingTarget> {
	return new Map((catalog.builtin[role]?.mapping ?? []).map((e) => [e.label, e.target]));
}

/** Templates a line may map to: on a shipped rule line, its own rule or a template that tightens it; on a new line, the role's templates. */
export function templatesFor(catalog: CharterCatalog, role: string, label: string): CharterTemplate[] {
	const shipped = shippedTargets(catalog, role).get(label);
	const applies = (t: CharterTemplate) => t.role === role || (t.role === '*' && WORKERS.has(role));
	if (shipped?.kind === 'rule') return catalog.templates.filter((t) => t.id === shipped.template || (!t.id.startsWith('builtin:') && applies(t) && t.tightensLine === label));
	if (shipped) return [];
	return catalog.templates.filter((t) => !t.id.startsWith('builtin:') && applies(t));
}

/** Eval scenarios a new line may map to: the role's charters-suite scenarios. */
export function scenariosFor(catalog: CharterCatalog, role: string) {
	return catalog.scenarios.filter((s) => s.agent === role);
}

/** A param's starting value as the gateway expects it (bp and int as numbers, minor as a string of minor units). */
export function defaultParam(p: CharterParamSpec): unknown {
	if (p.type === 'kinds') return Array.isArray(p.default) ? [...p.default] : [];
	if (p.type === 'minor') return p.default !== undefined ? String(p.default) : p.min !== undefined ? String(p.min) : '0';
	if (p.type === 'bp' || p.type === 'int') return typeof p.default === 'number' ? p.default : (p.min ?? 0);
	return p.default ?? '';
}

export function templateTarget(t: CharterTemplate): CharterMappingTarget {
	if (!t.params.length) return { kind: 'rule', template: t.id };
	return { kind: 'rule', template: t.id, params: Object.fromEntries(t.params.map((p) => [p.name, defaultParam(p)])) };
}

/**
 * The mapping for an edited body: each line keeps the target it had (by label), a shipped line falls back to its shipped
 * target, and a new line starts on the role's first template, or its first scenario. The text is always the line's own.
 */
export function remap(catalog: CharterCatalog, role: string, bodyMd: string, previous: CharterMappingEntry[]): CharterMappingEntry[] {
	const prev = new Map(previous.map((e) => [e.label, e.target]));
	const shipped = shippedTargets(catalog, role);
	return parseCharterLines(bodyMd).map((l) => {
		const target = prev.get(l.label) ?? shipped.get(l.label) ?? firstNewTarget(catalog, role);
		return { label: l.label, text: l.text, target };
	});
}

function firstNewTarget(catalog: CharterCatalog, role: string): CharterMappingTarget {
	const t = templatesFor(catalog, role, '__new__')[0];
	if (t) return templateTarget(t);
	const s = scenariosFor(catalog, role)[0];
	return s ? { kind: 'scenario', scenario: s.id } : { kind: 'custom_scenario', yaml: '' };
}

/**
 * Problems the editor can see before saving: lines nobody mapped, shipped lines removed or mapped to something that
 * could loosen them, a shipped rule on a new line, and template params outside their range. Plain sentences. The full
 * check (scenario variables, custom scenarios, probes) is the eval's.
 */
export function editorProblems(catalog: CharterCatalog, role: string, bodyMd: string, mapping: CharterMappingEntry[]): string[] {
	const problems: string[] = [];
	const lines = parseCharterLines(bodyMd);
	const labels = new Map<string, number>();
	for (const l of lines) labels.set(l.label, (labels.get(l.label) ?? 0) + 1);
	for (const [l, n] of labels) if (n > 1) problems.push(`The charter has ${n} lines numbered ${l}; number each section's lines once.`);
	const shipped = shippedTargets(catalog, role);
	for (const label of shipped.keys()) if (!labels.has(label)) problems.push(`${label} is a shipped line; you may reword it but not remove it, because a custom Charter can only make the gate stricter.`);
	const mapped = new Map(mapping.map((e) => [e.label, e]));
	for (const l of lines) {
		const e = mapped.get(l.label);
		if (!e) {
			problems.push(`${l.label} is not mapped to a rule or a scenario.`);
			continue;
		}
		const sh = shipped.get(l.label);
		const t = e.target;
		if (sh?.kind === 'rule' && !(t.kind === 'rule' && templatesFor(catalog, role, l.label).some((x) => x.id === t.template))) problems.push(`${l.label} keeps its shipped rule, or a template that tightens it.`);
		if (sh?.kind === 'scenario' && !(t.kind === 'scenario' && t.scenario === sh.scenario)) problems.push(`${l.label} keeps its shipped scenario ${sh.scenario}.`);
		if (!sh && t.kind === 'rule' && t.template.startsWith('builtin:')) problems.push(`${l.label} is a new line; shipped rules stay on their own lines.`);
		if (t.kind === 'custom_scenario' && !t.yaml.trim()) problems.push(`${l.label}: the custom scenario is empty.`);
		if (t.kind === 'rule') {
			const tpl = catalog.templates.find((x) => x.id === t.template);
			if (!tpl) problems.push(`${l.label} maps to a rule template that does not exist (${t.template}).`);
			else for (const p of tpl.params) problems.push(...paramProblems(l.label, p, t.params?.[p.name]));
		}
	}
	return problems;
}

function paramProblems(label: string, p: CharterParamSpec, v: unknown): string[] {
	if (p.type === 'kinds') return Array.isArray(v) && v.length ? [] : [`${label}: choose at least one Proposal kind.`];
	if (p.type === 'bp' || p.type === 'int' || p.type === 'minor') {
		const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
		if (!Number.isFinite(n)) return [`${label}: ${p.labelPlain.toLowerCase()} must be a whole number.`];
		if (p.min !== undefined && n < p.min) return [`${label}: ${p.labelPlain.toLowerCase()} must be at least ${showParam(p, p.min)}.`];
		if (p.max !== undefined && n > p.max) return [`${label}: ${p.labelPlain.toLowerCase()} must be at most ${showParam(p, p.max)}.`];
	}
	return [];
}

/** A param bound as the CFO reads it: a percentage for bp, dollars for minor. */
export function showParam(p: CharterParamSpec, n: number): string {
	if (p.type === 'bp') return `${n / 100}%`;
	if (p.type === 'minor') return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: n % 100 ? 2 : 0 })}`;
	return String(n);
}

/** The latest eval of a version: by time, then by id. */
export function latestEval(evals: CharterEval[], versionId: string): CharterEval | undefined {
	return evals
		.filter((e) => e.charterVersionId === versionId)
		.reduce<CharterEval | undefined>((a, b) => (!a || b.ranAt > a.ranAt || (b.ranAt === a.ranAt && idAfter(b.id, a.id)) ? b : a), undefined);
}

/** Ids are whole numbers (live) or same-prefix counters (Demo mode): longer is later, then string order. */
const idAfter = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b);

/** Whether the CFO may publish: the version is not live and its latest eval is a passing full eval (the module's rule). */
export function publishable(v: CharterVersion, evals: CharterEval[]): boolean {
	const e = latestEval(evals, v.id);
	return v.status !== 'live' && !!e && e.passed && e.mode === 'dry_run';
}

export function parseMapping(json: string): CharterMappingEntry[] {
	try {
		const v = JSON.parse(json) as unknown;
		return Array.isArray(v) ? (v as CharterMappingEntry[]) : [];
	} catch {
		return [];
	}
}

// What the Charters page shows for a role: the Charter in force read into its sections, and the tools the role may
// call grouped by source. The catalog comes from the agent gateway; the copy bundled for Demo mode
// (mock/seed/charters.json, kept equal to the gateway by apps/agents/test/charter-tools.test.ts) stands in when the
// gateway is offline or too old to report tools, so the page is never empty.
import bundled from './data/mock/seed/charters.json';
import { parseCharterLines, type CharterLine } from './charter';
import type { CharterCatalog, CharterTool, CharterToolSource } from './data/types';

export const BUNDLED_CATALOG = bundled as unknown as CharterCatalog;

export interface CharterView {
	/** The paragraph before the numbered sections: who the agent is and what it does. */
	intro: string;
	may: CharterLine[];
	mustNever: CharterLine[];
	escalates: CharterLine[];
	plain: string;
}

/** A Charter's text read into the sections the page shows. */
export function charterView(bodyMd: string): CharterView {
	const lines = parseCharterLines(bodyMd);
	const pick = (prefix: string) => lines.filter((l) => l.label.startsWith(`${prefix} `));
	const intro = bodyMd
		.split(/\n##\s/)[0]!
		.split('\n')
		.filter((l) => l.trim() && !/^#\s/.test(l))
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/`/g, '')
		.trim();
	return { intro, may: pick('May'), mustNever: pick('Must never'), escalates: pick('Escalates'), plain: lines.find((l) => l.label === 'Plain summary')?.text ?? '' };
}

export interface ToolGroup {
	source: CharterToolSource;
	label: string;
	tools: CharterTool[];
}

/** The role's tools grouped by source in the catalog's order, from the live catalog or the bundled copy. */
export function toolGroups(catalog: CharterCatalog | null, role: string): { groups: ToolGroup[]; bundled: boolean } {
	const live = catalog?.tools;
	const t = live ?? BUNDLED_CATALOG.tools;
	if (!t) return { groups: [], bundled: false };
	const tools = t.byRole[role] ?? [];
	const groups = (Object.keys(t.sources) as CharterToolSource[])
		.map((source) => ({ source, label: t.sources[source], tools: tools.filter((x) => x.source === source) }))
		.filter((g) => g.tools.length);
	return { groups, bundled: !live };
}

/** The Built-in Charter text for a role, from the live catalog or the bundled copy. */
export function builtinBody(catalog: CharterCatalog | null, role: string): { bodyMd: string; bundled: boolean } {
	const live = catalog?.builtin[role]?.bodyMd;
	return live ? { bodyMd: live, bundled: false } : { bodyMd: BUNDLED_CATALOG.builtin[role]?.bodyMd ?? '', bundled: true };
}

/**
 * Charter markdown to labelled lines, by the same algorithm as test/coverage.test.ts (and the web editor's
 * parseCharterLines): `## May`, `## Must never`, `## Escalates` sections hold numbered lines ("1. ..."), and the
 * `## Plain summary rule` section is one line, its paragraphs squashed together. Any other heading ends a section.
 * The parser itself lives in @luyten/eval-harness, which judges charters by the same lines.
 */
import { charterLines as sharedCharterLines } from '@luyten/eval-harness';
import type { CharterLine } from '../harness';

export { squash } from '@luyten/eval-harness';

export interface ParsedLine {
  label: CharterLine;
  /** The line's words with whitespace squashed; list numbers removed. */
  text: string;
}

/** The charter's lines in document order, the Plain summary rule last. A label written twice appears twice. */
export const charterLines = (bodyMd: string): ParsedLine[] => sharedCharterLines(bodyMd) as ParsedLine[];

const WORD: Record<string, string> = { May: 'may', 'Must never': 'never', Escalates: 'escalates' };

/** The rule id a line's rule gets: `<role>.<may|never|escalates>.<n>`, or `<role>.plain`. Undefined for a malformed label. */
export function ruleIdFor(role: string, label: string): string | undefined {
  if (label === 'Plain summary') return `${role}.plain`;
  const m = /^(May|Must never|Escalates) ([1-9]\d*)$/.exec(label);
  return m ? `${role}.${WORD[m[1]!]}.${m[2]}` : undefined;
}

/** Whether a string is a charter line label. */
export const isLabel = (label: unknown): label is CharterLine => typeof label === 'string' && ruleIdFor('x', label) !== undefined;

const KNOWN_SECTIONS = new Set(['May', 'Must never', 'Escalates', 'Plain summary rule']);

/**
 * Non-blank lines the parser does not read but the agent's prompt would: prose, bullets, wrapped lines or sub-headings
 * inside May, Must never and Escalates, and anything under a heading that is not a charter section. Only the intro above
 * the first section and the Plain summary rule's paragraphs may be free text. Line numbers are 1-based.
 */
export function strayLines(bodyMd: string): { line: number; text: string; problem: string }[] {
  const out: { line: number; text: string; problem: string }[] = [];
  let section: string | undefined;
  bodyMd.split('\n').forEach((raw, i) => {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      section = KNOWN_SECTIONS.has(heading[1]!) ? heading[1]! : 'other';
      if (section === 'other') out.push({ line: i + 1, text: raw.trim(), problem: 'is not a charter section (May, Must never, Escalates, Plain summary rule)' });
      return;
    }
    if (section === undefined || section === 'Plain summary rule' || !raw.trim()) return;
    if (section === 'other') out.push({ line: i + 1, text: raw.trim(), problem: 'sits under a heading that is not a charter section' });
    else if (!/^\d+\.\s+\S/.test(raw)) out.push({ line: i + 1, text: raw.trim(), problem: `is in ${section} but is not a numbered line` });
  });
  return out;
}

/**
 * The worked example of a custom charter: the Bookkeeper's batch line raised from seventy-five to ninety percent
 * (May 2 mapped to batch_min_confidence at 9000). The charter smoke test publishes it; the tests build on it.
 */
import { builtinCharter } from './active';
import { defaultMapping } from './build';
import type { CharterMappingEntry } from './types';

export const NINETY_PERCENT_LINE =
  'You may propose many matches in one batch only when every match in it is at least ninety percent confident; propose each less certain match on its own so it gets its own ruling.';

export function ninetyPercentDraft(): { role: 'bookkeeper'; bodyMd: string; mapping: CharterMappingEntry[]; summaryPlain: string } {
  const bodyMd = builtinCharter('bookkeeper').bodyMd.replace(/^2\. You may propose many matches.*$/m, `2. ${NINETY_PERCENT_LINE}`);
  if (!bodyMd.includes(NINETY_PERCENT_LINE)) throw new Error('the shipped Bookkeeper charter no longer has the batch line this example edits');
  const mapping = defaultMapping('bookkeeper', bodyMd).map(e => (e.label === 'May 2' ? { ...e, target: { kind: 'rule' as const, template: 'batch_min_confidence', params: { minScoreBp: 9000 } } } : e));
  return { role: 'bookkeeper', bodyMd, mapping, summaryPlain: 'Batch bank matches only when every match is at least ninety percent confident.' };
}

/** Run one close from the command line: `pnpm -F @luyten/agents close -- 2026-09`. */
import { runScriptedClose } from './scripted/close';
import { Cast } from './stdb';

const ym = process.argv.slice(2).find(a => /^\d{4}-\d{2}$/.test(a));
if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
  console.error('usage: close <YYYY-MM>');
  process.exit(2);
}
const cast = await Cast.connectAll();
const result = await runScriptedClose(cast, ym);
console.log(JSON.stringify(result));
process.exit(0);

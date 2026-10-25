/**
 * The close month for scripts: CLOSE_PERIOD, or 2026-09 when it is unset or empty (.env.example ships it empty).
 * Its own module, reading nothing at load, so the smoke scripts can import it statically before they set their
 * environment and dynamically import everything that reads env.ts.
 */
export function closePeriod(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLOSE_PERIOD?.trim() || '2026-09';
}

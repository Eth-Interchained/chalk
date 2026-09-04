/**
 * Watch-loop configuration.
 *
 * `deep` decides whether each watch tick also pulls play CONTEXT (participation
 * + charting → football_play_context) alongside the play-by-play. For a live
 * season the tick touches a week of games at a time, so the extra source calls
 * are small and the context is the whole point of watching — hence DEEP IS THE
 * DEFAULT. Opt out with CHALK_WATCH_DEEP=0 (or false/no/off) when a source is
 * throttling; `--deep` on the command line always wins.
 */
const OFF = new Set(["0", "false", "no", "off"]);

export function resolveWatchDeep(flag: unknown, env: string | undefined): boolean {
  if (flag === true) return true;
  if (env !== undefined && env !== "") return !OFF.has(env.trim().toLowerCase());
  return true;
}

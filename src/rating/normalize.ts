/**
 * Normalization — percentile rank, v1.0.0.
 *
 * percentile(value, population) = (below + 0.5 * ties) / n, in [0, 1].
 *   - "below" counts strictly smaller population values
 *   - ties split the difference so the subject's own value (which IS in the
 *     population) sits at the midpoint of its tie group
 *   - the subject's own value is expected to be in the population; if it is
 *     not, the formula still behaves (it just ranks against outsiders)
 *   - empty population -> null
 *
 * Direction is applied by the caller: for lower_is_better metrics the score is
 * 1 - percentile.
 *
 * Why percentile rank and not z-score: percentile is bounded, robust to a
 * single 2-for-2 outlier team, and reads as "better than X% of the league",
 * which is the sentence a fan says out loud. Z-scores assume roughly normal
 * metric distributions — third-down conversion over 32 teams is not that.
 */
export function percentileRank(value: number, population: readonly number[]): number | null {
  const n = population.length;
  if (n === 0) return null;
  let below = 0;
  let ties = 0;
  for (const v of population) {
    if (v < value) below++;
    else if (v === value) ties++;
  }
  return (below + 0.5 * ties) / n;
}

/** Percentile in 0..100, rounded to one decimal. */
export function percentile100(value: number, population: readonly number[]): number | null {
  const p = percentileRank(value, population);
  return p === null ? null : Math.round(p * 1000) / 10;
}

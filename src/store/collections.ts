/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
/**
 * Collection registry — the only place collection names live.
 *
 * Spec §4 suggests dotted names (football.raw.plays). NQL treats `.` as a
 * field-path separator, so we use `football_raw_plays` style: same taxonomy,
 * unambiguous in queries.
 */
export const COLL = {
  // Immutable provider records, one document version per observed payload.
  raw_games: "football_raw_games",
  raw_plays: "football_raw_plays",
  raw_players: "football_raw_players",
  raw_rosters: "football_raw_rosters",
  raw_participation: "football_raw_participation",
  raw_charting: "football_raw_charting",

  // Normalized football records — CHALK's own schema, derived_from raw hashes.
  games: "football_games",
  plays: "football_plays",
  players: "football_players",
  participation: "football_participation",
  charting: "football_charting",

  // Deterministic outputs.
  analyses: "football_analyses",
  metrics: "football_metrics",
  tendencies: "football_tendencies",
  comparisons: "football_comparisons",
  ratings: "football_ratings",
  rating_definitions: "football_rating_definitions",
  rankings: "football_rankings",

  // Interpretation + humans.
  observations: "football_observations",
  annotations: "football_annotations",
  saved_queries: "football_saved_queries",
  predictions: "football_predictions",

  // Observability.
  ingest_events: "football_ingest_events",
  /** Persisted Home payloads: the store is the cache, so a restart costs milliseconds, not a 30s recompute. */
  home_snapshots: "football_home_snapshots",
  source_changes: "football_source_changes",
  query_events: "football_query_events",
  model_events: "football_model_events",
} as const;

export type CollectionKey = keyof typeof COLL;

/**
 * Open API — CHALK serves its own OpenAPI 3.1 document at /api/v1/openapi.json.
 * Every analysis, rating, play and observation is addressable by id; every
 * number in the UI is reachable through these routes.
 */
export function openapiDocument(baseUrl: string) {
  const ok = (ref: string) => ({ "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } } });
  const q = (name: string, type: string, required = false, description?: string) => ({ name, in: "query", required, schema: { type }, description });
  const p = (name: string, description?: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
  return {
    openapi: "3.1.0",
    info: {
      title: "CHALK — Sports-Rater Football Intelligence API",
      version: "0.6.0",
      description:
        "Deterministic football analytics over an NEDB provenance store. The database knows. Deterministic code calculates. The model interprets. Provenance proves. Every analysis, rating, play and model observation is addressable and traceable to raw source records.",
      license: { name: "BUSL-1.1" },
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: "system" }, { name: "teams" }, { name: "games" }, { name: "plays" }, { name: "analyses" },
      { name: "tendencies" }, { name: "comparisons" }, { name: "ratings" }, { name: "ask" }, { name: "provenance" }, { name: "ingest" }, { name: "fans" },
    ],
    paths: {
      "/api/v1/health": { get: { tags: ["system"], summary: "CHALK + NEDB health, head, seq, model config", responses: ok("Health") } },
      "/api/v1/meta": { get: { tags: ["system"], summary: "Teams, seasons ingested, defaults, definitions", responses: ok("Meta") } },
      "/api/v1/teams": { get: { tags: ["teams"], summary: "Teams with ingested plays", responses: ok("Teams") } },
      "/api/v1/games": { get: { tags: ["games"], summary: "Games", parameters: [q("season", "integer"), q("team", "string"), q("week", "integer")], responses: ok("Games") } },
      "/api/v1/games/{game_id}": { get: { tags: ["games"], summary: "Game with both teams' third-down summaries", parameters: [p("game_id")], responses: ok("GameDetail") } },
      "/api/v1/games/{game_id}/plays": { get: { tags: ["plays"], summary: "Normalized plays for a game", parameters: [p("game_id"), q("team", "string"), q("down", "integer")], responses: ok("Plays") } },
      "/api/v1/plays/{play_id}": { get: { tags: ["plays", "provenance"], summary: "One play: normalized + raw source record + lineage", parameters: [p("play_id", "GAME_ID:PLAY_ID")], responses: ok("PlayDetail") } },
      "/api/v1/analyses/third-down": {
        get: {
          tags: ["analyses"],
          summary: "Third-down analysis (deterministic, persisted, cached by content id)",
          parameters: [q("team", "string", true), q("season", "integer"), q("game_id", "string"), q("side", "string", false, "offense|defense"), q("opponent", "string"), q("exclude_garbage_time", "boolean"), q("exclude_penalties", "boolean"), q("week_min", "integer"), q("week_max", "integer")],
          responses: ok("ThirdDownResponse"),
        },
      },
      "/api/v1/analyses/scan": { get: { tags: ["analyses"], summary: "Situation scan — which situations hurt/help a team most", parameters: [q("team", "string", true), q("season", "integer"), q("game_id", "string"), q("side", "string"), q("league", "boolean", false, "also compare each bucket to the league")], responses: ok("Scan") } },
      "/api/v1/analyses/{id}": { get: { tags: ["analyses", "provenance"], summary: "Stored analysis by id", parameters: [p("id")], responses: ok("Stored") } },
      "/api/v1/analyses/{id}/evidence": { get: { tags: ["analyses", "provenance"], summary: "Evidence plays for a stored analysis", parameters: [p("id")], responses: ok("Plays") } },
      "/api/v1/tendencies": { post: { tags: ["tendencies"], summary: "Tendency for a situation filter vs team baseline", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SituationFilter" } } } }, responses: ok("Tendency") } },
      "/api/v1/comparisons": { post: { tags: ["comparisons"], summary: "Deterministic A/B over two situation filters", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { a: { $ref: "#/components/schemas/SituationFilter" }, b: { $ref: "#/components/schemas/SituationFilter" } }, required: ["a", "b"] } } } }, responses: ok("Comparison") } },
      "/api/v1/ratings/third-down": { get: { tags: ["ratings"], summary: "Third Down Rating (0-100) with formula, normalization, population, sample", parameters: [q("team", "string", true), q("season", "integer"), q("definition", "string", false, "rating definition id"), q("side", "string")], responses: ok("Rating") } },
      "/api/v1/ratings/third-down/league": { get: { tags: ["ratings"], summary: "League table under a definition", parameters: [q("season", "integer"), q("definition", "string"), q("side", "string")], responses: ok("League") } },
      "/api/v1/ratings/compare": { get: { tags: ["ratings"], summary: "Explain why two definitions disagree on a team", parameters: [q("team", "string", true), q("season", "integer"), q("a", "string", true), q("b", "string", true)], responses: ok("RatingCompare") } },
      "/api/v1/ratings/{subject}": { get: { tags: ["ratings"], summary: "Rating for a subject: offense | defense | red-zone | explosiveness | ball-security (third-down has its own route). Snapshot with formula, normalization, population, sample, plus the team's metric profile.", parameters: [p("subject"), q("team", "string", true), q("season", "integer"), q("definition", "string")], responses: ok("Rating") } },
      "/api/v1/ratings/{subject}/trend": { get: { tags: ["ratings"], summary: "Any subject's rating week over week, as known then", parameters: [p("subject"), q("team", "string", true), q("season", "integer"), q("definition", "string")], responses: ok("Trend") } },
      "/api/v1/rankings": { get: { tags: ["ratings"], summary: "Power rankings under a definition (default offense), with movement vs the as-known-then snapshot one week earlier, risers and fallers", parameters: [q("season", "integer"), q("definition", "string")], responses: ok("Rankings") } },
      "/api/v1/ratings/third-down/trend": { get: { tags: ["ratings"], summary: "Rating week over week, as known then (only plays through each week, for the team and the league)", parameters: [q("team", "string", true), q("season", "integer"), q("definition", "string"), q("side", "string")], responses: ok("Trend") } },
      "/api/v1/badges": { get: { tags: ["ratings"], summary: "Deterministic league-relative badges earned by a team, with qualification rules", parameters: [q("team", "string", true), q("season", "integer")], responses: ok("Badges") } },
      "/api/v1/reports/opponent": { get: { tags: ["analyses", "tendencies"], summary: "Opponent report: tendencies by situation with formation/personnel context, weak and strong spots", parameters: [q("team", "string", true), q("opponent", "string", false, "defaults to the team's next scheduled opponent"), q("season", "integer"), q("side", "string", false, "offense (their offense, default) | defense")], responses: ok("OpponentReport") } },
      "/api/v1/teams/{team}/home": { get: { tags: ["teams", "ratings"], summary: "Home composite: rating, trend, badges, recent form, last game + deviation, next game + opponent snapshot, weakest situations", parameters: [p("team"), q("season", "integer"), q("definition", "string")], responses: ok("Home") } },
      "/api/v1/fans/ratings": { post: { tags: ["fans"], summary: "Fan rates a team on a subject (0-100). No account: body carries fan_id (sha256 of nickname:salt, computed on the device) + handle nick#xxxxxx. Stored caused_by the CHALK snapshot; re-rating replaces. Returns consensus.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["fan_id", "handle", "team", "season", "subject", "score"], properties: { fan_id: { type: "string" }, handle: { type: "string" }, team: { type: "string" }, season: { type: "integer" }, subject: { type: "string" }, score: { type: "integer" }, snapshot_id: { type: "string" }, chalk_score: { type: "number" } } } } } }, responses: ok("FanWrite") } },
      "/api/v1/fans/reactions": { post: { tags: ["fans"], summary: "like | agree | disagree on any football_* or sr_* record", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["fan_id", "handle", "target_coll", "target_id", "reaction"], properties: { fan_id: { type: "string" }, handle: { type: "string" }, target_coll: { type: "string" }, target_id: { type: "string" }, reaction: { type: "string", enum: ["like", "agree", "disagree"] } } } } } }, responses: ok("FanWrite") } },
      "/api/v1/fans/posts": { post: { tags: ["fans"], summary: "A take (<=280 chars, no links), optionally attached to a team/game/record", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["fan_id", "handle", "text"], properties: { fan_id: { type: "string" }, handle: { type: "string" }, text: { type: "string" }, team: { type: "string" }, game_id: { type: "string" }, target_coll: { type: "string" }, target_id: { type: "string" } } } } } }, responses: ok("FanWrite") } },
      "/api/v1/feed": { get: { tags: ["fans"], summary: "Newest-first feed of fan posts and ratings (the hash chain, rendered)", parameters: [q("team", "string"), q("limit", "integer"), q("include", "string", false, "comma list of post,rating,reaction")], responses: ok("Feed") } },
      "/api/v1/fans/consensus": { get: { tags: ["fans"], summary: "Fan mean/median per subject vs CHALK's score", parameters: [q("team", "string", true), q("season", "integer"), q("subject", "string")], responses: ok("Consensus") } },
      "/api/v1/fans/{fan_id}": { get: { tags: ["fans", "provenance"], summary: "A fan's chain, walked tip -> first write with prev-link verification", parameters: [p("fan_id")], responses: ok("FanChain") } },
      "/api/v1/identicon/{fan_id}.svg": { get: { tags: ["fans"], summary: "Deterministic identicon", parameters: [p("fan_id"), q("size", "integer")], responses: { "200": { description: "image/svg+xml" } } } },
      "/api/v1/rating-definitions": {
        get: { tags: ["ratings"], summary: "Built-in + custom rating definitions", responses: ok("Definitions") },
        post: { tags: ["ratings"], summary: "Create a custom rating profile (weights normalized, stored versioned in NEDB)", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RatingDefinitionInput" } } } }, responses: ok("Definition") },
      },
      "/api/v1/ask": {
        post: {
          tags: ["ask"],
          summary: "Ask CHALK. Server-Sent Events: plan, evidence, token*, observation, done",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { question: { type: "string" }, team: { type: "string" }, season: { type: "integer" }, game_id: { type: "string" }, play_id: { type: "string" } }, required: ["question"] } } } },
          responses: { "200": { description: "text/event-stream" } },
        },
      },
      "/api/v1/plan": { post: { tags: ["ask"], summary: "Plan only — see the validated query plan without executing", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } } }, responses: ok("Plan") } },
      "/api/v1/observations/{id}": { get: { tags: ["provenance"], summary: "Stored model observation", parameters: [p("id")], responses: ok("Stored") } },
      "/api/v1/provenance/{coll}/{id}": { get: { tags: ["provenance"], summary: "TRACE caused_by from any stored record — the full lineage tree down to raw source rows", parameters: [p("coll"), p("id")], responses: ok("Provenance") } },
      "/api/v1/ingest/status": { get: { tags: ["ingest"], summary: "Recent ingest runs and source changes", responses: ok("IngestStatus") } },
      "/api/v1/verify": { get: { tags: ["system", "provenance"], summary: "NEDB tamper-evidence verification over the whole store", responses: ok("Verify") } },
    },
    components: {
      schemas: {
        Health: { type: "object" },
        Meta: { type: "object" },
        Teams: { type: "object" },
        Games: { type: "object" },
        GameDetail: { type: "object" },
        Plays: { type: "object" },
        PlayDetail: { type: "object" },
        ThirdDownResponse: { type: "object" },
        Scan: { type: "object" },
        Stored: { type: "object" },
        Tendency: { type: "object" },
        Comparison: { type: "object" },
        Rating: { type: "object" },
        League: { type: "object" },
        RatingCompare: { type: "object" },
        Definitions: { type: "object" },
        Definition: { type: "object" },
        Plan: { type: "object" },
        Trend: { type: "object" },
        Rankings: { type: "object" },
        FanWrite: { type: "object" },
        Feed: { type: "object" },
        Consensus: { type: "object" },
        FanChain: { type: "object" },
        Badges: { type: "object" },
        OpponentReport: { type: "object" },
        Home: { type: "object" },
        Provenance: { type: "object" },
        IngestStatus: { type: "object" },
        Verify: { type: "object" },
        SituationFilter: {
          type: "object",
          required: ["team"],
          properties: {
            team: { type: "string" }, side: { type: "string", enum: ["offense", "defense"] }, season: { type: "integer" }, game_id: { type: "string" },
            game_ids: { type: "array", items: { type: "string" } }, opponent: { type: "string" }, week_min: { type: "integer" }, week_max: { type: "integer" },
            down: { type: "array", items: { type: "integer" } }, distance_min: { type: "integer" }, distance_max: { type: "integer" },
            distance_bucket: { type: "array", items: { type: "string", enum: ["short", "medium", "long", "very_long"] } },
            quarter: { type: "array", items: { type: "integer" } }, half: { type: "array", items: { type: "integer" } },
            score_state: { type: "array", items: { type: "string", enum: ["leading", "trailing", "tied"] } }, neutral_only: { type: "boolean" },
            score_diff_min: { type: "integer" }, score_diff_max: { type: "integer" }, field_zone: { type: "array", items: { type: "string", enum: ["own", "opp", "red_zone"] } },
            goal_to_go: { type: "boolean" }, home: { type: "boolean" }, divisional: { type: "boolean" }, play_types: { type: "array", items: { type: "string" } },
            snaps_only: { type: "boolean" }, exclude_kneels: { type: "boolean" }, exclude_spikes: { type: "boolean" }, exclude_no_play: { type: "boolean" },
            exclude_penalties: { type: "boolean" }, exclude_garbage_time: { type: "boolean" },
          },
        },
        RatingDefinitionInput: {
          type: "object",
          required: ["name", "components"],
          properties: {
            name: { type: "string" }, version: { type: "string" }, notes: { type: "string" }, min_sample: { type: "integer" },
            components: { type: "array", items: { type: "object", required: ["metric", "weight"], properties: { metric: { type: "string" }, weight: { type: "number" }, direction: { type: "string", enum: ["higher_is_better", "lower_is_better"] } } } },
          },
        },
      },
    },
  };
}

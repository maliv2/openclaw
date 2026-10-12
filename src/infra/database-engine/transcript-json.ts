import { expressionBuilder, sql, type AliasableExpression, type Expression } from "kysely";
import { isPostgresSqlConnection } from "../sql-connection.js";

export function transcriptJsonSource(
  database: object,
  value: Expression<string | null>,
): AliasableExpression<string | null> {
  const eb = expressionBuilder();
  /* kysely-allow-raw: Engine-owned bounded JSON scalar projection. */
  return isPostgresSqlConnection(database)
    ? eb.fn<string | null>("json_extract_path_text", [sql`${value}::json`, eb.val("source")])
    : eb.fn<string | null>("json_extract", [value, eb.val("$.source")]);
}

export function transcriptJsonParticipants(
  database: object,
  value: Expression<string | null>,
  sequence: Expression<number>,
): AliasableExpression<string> {
  /* kysely-allow-raw: Engine-owned ordered JSON aggregation, returned as text on both engines. */
  return isPostgresSqlConnection(database)
    ? sql<string>`coalesce(array_to_json(array_agg(${value} order by ${sequence}))::text, '[]')`
    : expressionBuilder().fn<string>("json_group_array", [value]);
}

export function transcriptJsonNotes(
  database: object,
  value: Expression<string | null>,
): AliasableExpression<string | null> {
  const eb = expressionBuilder();
  /* kysely-allow-raw: Drop the duplicated transcript before the byte guard and row transfer. */
  return isPostgresSqlConnection(database)
    ? sql<string | null>`(${value}::jsonb - 'transcript')::text`
    : eb.fn<string | null>("json_remove", [value, eb.val("$.transcript")]);
}

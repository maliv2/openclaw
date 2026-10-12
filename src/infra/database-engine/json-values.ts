import type { DatabaseSync } from "node:sqlite";
import { sql, type Expression } from "kysely";
import { getNodeSqliteKysely } from "../kysely-sync.js";
import { isPostgresSqlConnection } from "../sql-connection.js";

/** Expand a caller-owned string map without changing JSON values into quoted text. */
export function jsonObjectTextEntries(db: DatabaseSync, value: string) {
  /* kysely-allow-raw: PostgreSQL requires a typed JSON input. */
  const postgres = isPostgresSqlConnection(db);
  return getNodeSqliteKysely(db).fn<{ key: string; value: string }>(
    postgres ? "json_each_text" : "json_each",
    [postgres ? sql`${value}::json` : sql.val(value)],
  );
}

/** Read a string from a caller-owned JSON tuple. */
export function jsonArrayTextElement(
  db: DatabaseSync,
  value: Expression<string | null>,
  index: number,
) {
  /* kysely-allow-raw: PostgreSQL requires a typed JSON input. */
  return isPostgresSqlConnection(db)
    ? getNodeSqliteKysely(db).fn<string>("json_extract_path_text", [
        sql`${value}::json`,
        sql.val(String(index)),
      ])
    : getNodeSqliteKysely(db).fn<string>("json_extract", [value, sql.val(`$[${index}]`)]);
}

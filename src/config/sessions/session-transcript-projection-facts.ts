import type { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

/** Small projection metadata; transcript bodies stay with the history reader. */
export type SessionTranscriptProjectionFacts = {
  cold: boolean;
  generation: string | undefined;
  updatedAt: number | null;
  hasUnclassified: boolean;
  latestIndexedReset: { active_position: number; event_type: "reset"; seq: number } | null;
  hasUnindexedPrefix: boolean;
  latestSeq: number | null;
  state?: SessionTranscriptProjectionState;
};

export type SessionTranscriptProjectionReceipt = {
  path: string;
  sessionId: string;
  writeToken: string;
  writeScopes: Parameters<typeof readSqliteDatabaseScopedWriteToken>[1];
  facts: SessionTranscriptProjectionFacts;
};

export function projectSessionTranscriptFacts(
  actor: SessionActorStoredState,
): SessionTranscriptProjectionFacts {
  const { active, coldArchive, identities, navigation, projection } = actor.transcript;
  let latestIndexedReset: SessionTranscriptProjectionFacts["latestIndexedReset"] = null;
  let hasUnindexedPrefix = true;
  for (const identity of identities.values()) {
    hasUnindexedPrefix &&= identity.seq !== navigation[0]?.seq;
    const row = active.get(identity.seq);
    if (
      identity.event_type === "reset" &&
      row &&
      (!latestIndexedReset || identity.seq > latestIndexedReset.seq)
    ) {
      latestIndexedReset = {
        active_position: row.active_position,
        event_type: "reset",
        seq: identity.seq,
      };
    }
  }
  return {
    cold: Boolean(coldArchive),
    generation: actor.hot.transcript.version.generation ?? undefined,
    updatedAt: actor.hot.transcript.version.updatedAt,
    hasUnclassified: projection?.hasUnclassifiedEvents ?? false,
    latestIndexedReset,
    hasUnindexedPrefix,
    latestSeq: navigation.at(-1)?.seq ?? null,
    state: projection && {
      activeEventCount: projection.activeEventCount,
      activeMessageCount: projection.activeMessageCount,
      indexedSeq: projection.indexedSeq,
      leafEventId: projection.leafEventId,
      needsRebuild: projection.needsRebuild,
    },
  };
}

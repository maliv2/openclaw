import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  SkillWorkshopChangeNoticeSkill,
  SkillWorkshopNoticeAction,
} from "../../shared/skill-workshop-change-notice.js";
import { SKILL_WORKSHOP_CHANGE_NOTICE_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
import type { WorkshopChange } from "./changes.kernel.js";

const log = createSubsystemLogger("skills/workshop");

/**
 * A background Workshop run fails only when the model or runtime failed. Tool errors — a refused
 * write, a gated tool, a patch that did not match — are the model's to handle, not run failures.
 */
export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}

const ACTION_VERB: Record<WorkshopChange["action"], SkillWorkshopNoticeAction> = {
  create: "created",
  patch: "updated",
  write_file: "updated",
  remove_file: "updated",
  archive: "archived",
  restore: "restored",
};

/** The notice keeps a creation or latest edit; undo keeps the version before the first edit. */
function formatWorkshopChangeNotice(
  agentId: string,
  runId: string,
  changes: readonly WorkshopChange[],
) {
  const bySkill = new Map<string, { first: WorkshopChange; notice: WorkshopChange }>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    const group = bySkill.get(change.skillName);
    if (!group) {
      bySkill.set(change.skillName, { first: change, notice: change });
    } else if (group.notice.action !== "create") {
      group.notice = change;
    }
  }
  const skills = [...bySkill.values()].map(({ notice: change }) => {
    const skill: SkillWorkshopChangeNoticeSkill = {
      name: change.skillName,
      action: ACTION_VERB[change.action],
    };
    const summary = change.summary.trim();
    if (summary) {
      skill.summary = summary;
    }
    return skill;
  });
  const parts = skills.map(
    ({ name, action, summary }) => `${action} \`${name}\`${summary ? ` (${summary})` : ""}`,
  );
  const text = `💾 Learned: ${parts.join("; ")}. Say "undo" to revert this skill change.`;
  // No prior version means the review created the skill, so undo archives it.
  const reverts = [...bySkill.values()].map(({ first: { skillName, versionId } }) =>
    versionId
      ? `skill_workshop action=restore name=${skillName} version=${versionId}`
      : `skill_workshop action=archive name=${skillName} reason="undo"`,
  );
  return {
    text,
    marker: { kind: SKILL_WORKSHOP_CHANGE_NOTICE_KIND, agentId, runId, skills },
    undoContext: `A background skill review just changed your learned skills: ${text} If the user asks to undo or revert it, call ${reverts.join("; then ")}.`,
  };
}

/**
 * Appends a notice transcript row shown by the Control UI, including for channel sessions.
 * Channels get no message. The next foreground turn still gets a system event naming the
 * exact revert call, even if the user has not seen the notice.
 * A conversation reset or replaced since the review started gets none of it.
 */
export async function postWorkshopChangeNotice(params: {
  config: OpenClawConfig;
  /** The reviewed session generation; the notice belongs to it, not to a later reset. */
  generation: SessionDeliveryGeneration;
  runId: string;
  changes: readonly WorkshopChange[];
}): Promise<void> {
  if (params.changes.length === 0) {
    return;
  }
  const { generation } = params;
  const { agentId, sessionKey } = generation;
  const isReviewedGeneration = () => {
    const current = loadSessionEntryReadOnly({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    return (
      current?.sessionId === generation.sessionId &&
      (current.lifecycleRevision ?? null) === generation.lifecycleRevision
    );
  };
  if (!isReviewedGeneration()) {
    log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
    return;
  }
  const { text, marker, undoContext } = formatWorkshopChangeNotice(
    agentId,
    params.runId,
    params.changes,
  );
  enqueueSystemEvent(undoContext, {
    sessionKey: resolveSystemEventQueueKey(sessionKey, agentId),
  });
  const idempotencyKey = `skill-workshop-notice:${params.runId}`;
  try {
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.runtime.js");
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      expectedSessionId: generation.sessionId,
      expectedLifecycleRevision: generation.lifecycleRevision,
      text,
      idempotencyKey,
      deliveryMirror: marker,
      config: params.config,
    });
    if (!appended.ok) {
      throw new Error(appended.reason);
    }
  } catch (error) {
    if (!isReviewedGeneration()) {
      log.debug(`skill workshop notice skipped: session ${sessionKey} was reset`);
      return;
    }
    // The system event above still carries the change to the next turn.
    log.warn(`skill workshop notice delivery failed: ${String(error)}`);
  }
}

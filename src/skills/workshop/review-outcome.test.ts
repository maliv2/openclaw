import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
  sendDurableMessageBatchCore: vi.fn(async () => ({ status: "sent" })),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true })),
  enqueueSystemEvent: vi.fn(() => true),
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
vi.mock("../../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatchCore,
}));
vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("assertSkillReviewRunSucceeded", () => {
  it("does not fail a review whose tool calls were denied or errored", () => {
    const warning = setReplyPayloadMetadata(
      { isError: true, text: "⚠️ skill_workshop failed: View it first." },
      { toolErrorWarning: { toolName: "skill_workshop" } },
    );
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          toolSummary: {
            calls: 3,
            tools: ["sessions_yield", "skill_workshop"],
            failures: 1,
            unresolvedError: { toolName: "skill_workshop" },
          },
        },
        payloads: [warning],
      }),
    ).not.toThrow();
  });

  it("fails on model or runtime errors", () => {
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1, error: { kind: "retry_limit", message: "model retries exhausted" } },
      }),
    ).toThrow("model retries exhausted");
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1 },
        payloads: [{ isError: true, text: "LLM request failed: 529 overloaded" }],
      }),
    ).toThrow("529 overloaded");
    expect(() => assertSkillReviewRunSucceeded({ meta: { durationMs: 1, aborted: true } })).toThrow(
      "aborted",
    );
  });
});

describe("postWorkshopChangeNotice", () => {
  const change = (overrides: Partial<WorkshopChange>): WorkshopChange => ({
    id: "c1",
    agentId: "main",
    skillName: "actual-budget-operations",
    action: "patch",
    actor: "review",
    summary: "tightened reconciliation step",
    createdAtMs: 1,
    ...overrides,
  });
  const generation = (sessionKey: string) => ({
    agentId: "main",
    storePath: "/tmp/sessions.json",
    sessionKey,
    sessionId: "reviewed-session",
    lifecycleRevision: "reviewed-revision",
  });
  const reviewId = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
  const runId = `skill-workshop-review:${reviewId}`;
  const post = (changes: WorkshopChange[], sessionKey = "agent:main:telegram:direct:42") =>
    postWorkshopChangeNotice({
      config: {},
      generation: generation(sessionKey),
      runId,
      changes,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reviewed-revision",
    });
  });

  it("stays quiet when the review changed nothing", async () => {
    await post([]);
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      sessionKey: "agent:main:telegram:direct:42",
      deliveryContext: { channel: "telegram", to: "42" },
    },
    { sessionKey: "agent:main:webchat:test", deliveryContext: undefined },
  ])(
    "keeps the notice in the Control UI transcript for $sessionKey",
    async ({ sessionKey, deliveryContext }) => {
      mocks.loadSessionEntryReadOnly.mockReturnValue({
        sessionId: "reviewed-session",
        lifecycleRevision: "reviewed-revision",
        deliveryContext,
      });
      await post(
        [
          change({ id: "c2", versionId: "20260101T000000002Z-patch", createdAtMs: 2 }),
          change({ id: "c1", versionId: "20260101T000000001Z-patch", createdAtMs: 1 }),
          change({
            id: "c3",
            skillName: "release-notes",
            action: "create",
            summary: "drafting release notes",
            createdAtMs: 3,
          }),
          change({ id: "c4", skillName: "release-notes", versionId: "v-typo", createdAtMs: 4 }),
        ],
        sessionKey,
      );

      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledExactlyOnceWith({
        agentId: "main",
        sessionKey,
        storePath: "/tmp/sessions.json",
        expectedSessionId: "reviewed-session",
        expectedLifecycleRevision: "reviewed-revision",
        text: '💾 Learned: updated `actual-budget-operations` (tightened reconciliation step); created `release-notes` (drafting release notes). Say "undo" to revert this skill change.',
        idempotencyKey: `skill-workshop-notice:${runId}`,
        deliveryMirror: {
          kind: "skill-workshop-change",
          agentId: "main",
          runId,
          skills: [
            {
              name: "actual-budget-operations",
              action: "updated",
              summary: "tightened reconciliation step",
            },
            { name: "release-notes", action: "created", summary: "drafting release notes" },
          ],
        },
        config: {},
      });
      expect(mocks.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        'A background skill review just changed your learned skills: 💾 Learned: updated `actual-budget-operations` (tightened reconciliation step); created `release-notes` (drafting release notes). Say "undo" to revert this skill change. If the user asks to undo or revert it, call skill_workshop action=restore name=actual-budget-operations version=20260101T000000001Z-patch; then skill_workshop action=archive name=release-notes reason="undo".',
        { sessionKey },
      );
    },
  );

  it("leaves a conversation reset since the review started untouched", async () => {
    // A Gateway reset keeps the sessionId and rotates the lifecycle revision.
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reset-revision",
    });
    await post([change({})]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });
});

import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { noteDoctorAgentDatabasePathHealth } from "../commands/doctor-agent-database-paths.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

it("refuses an aggregate session write before creating or registering a physical database", async () => {
  await withOpenClawTestState({ label: "sentinel-path-producer" }, async (state) => {
    expect(() =>
      replaceSessionEntrySync(
        {
          agentId: "ops",
          env: state.env,
          storePath: state.statePath("(multiple)"),
          sessionKey: "agent:ops:main",
        },
        { sessionId: "refused", updatedAt: 1 },
      ),
    ).toThrow("Multiple session stores do not identify a physical database path");
    expect(
      fs.readdirSync(state.stateDir).filter((entry) => entry.startsWith("(multiple)")),
    ).toEqual([]);
    expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
  });
});

it("repairs empty sentinel registrations on every platform without losing sessions or retained data", async () => {
  await withOpenClawTestState({ label: "sentinel-path-repair" }, async (state) => {
    const cfg = { agents: { entries: { main: {}, ops: {} } } };
    const canonical = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
    const scope = {
      agentId: "ops",
      env: state.env,
      storePath: canonical.path,
      sessionKey: "agent:ops:survivor",
    };
    replaceSessionEntrySync(scope, { sessionId: "survivor", updatedAt: 1 });
    const emptyPath = state.statePath("(multiple).ops.sqlite");
    openOpenClawAgentDatabase({ agentId: "ops", path: emptyPath, env: state.env });
    const retainedPath = state.statePath("(multiple).sqlite");
    const retained = openOpenClawAgentDatabase({
      agentId: "main",
      path: retainedPath,
      env: state.env,
    });
    const retainedScope = {
      agentId: "main",
      env: state.env,
      storePath: retained.path,
      sessionKey: "agent:main:retained",
    };
    replaceSessionEntrySync(retainedScope, { sessionId: "retained", updatedAt: 1 });
    await closeOpenClawAgentDatabasesAsync();

    const warnings = await noteDoctorAgentDatabasePathHealth({
      env: state.env,
      cfg,
      shouldRepair: true,
    });
    expect(fs.existsSync(emptyPath)).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("contains retained data")]);
    expect(fs.existsSync(retainedPath)).toBe(true);
    const registry = openOpenClawStateDatabase({ env: state.env });
    expect(registry.db.prepare("SELECT path FROM agent_databases ORDER BY path").all()).toEqual([
      { path: "(multiple).sqlite" },
      { path: path.join("agents", "ops", "agent", "openclaw-agent.sqlite") },
    ]);
    expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
      sessionId: "survivor",
      updatedAt: 1,
    });
    expect(loadExactSessionEntryReadOnly(retainedScope)?.entry).toMatchObject({
      sessionId: "retained",
      updatedAt: 1,
    });
    const backupName = fs
      .readdirSync(state.stateDir)
      .find((entry) => entry.startsWith("agent-database-path-repair-"));
    expect(backupName).toBeDefined();
    const backupDir = path.join(state.stateDir, backupName!);
    expect(fs.existsSync(path.join(backupDir, path.basename(emptyPath)))).toBe(true);
    const backup = openNodeSqliteDatabase(path.join(backupDir, "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(backup.prepare("SELECT COUNT(*) AS count FROM agent_databases").get()).toEqual({
        count: 3,
      });
    } finally {
      backup.close();
    }
  });
});

it("preserves an explicitly configured sentinel-named custom database", async () => {
  await withOpenClawTestState({ label: "configured-sentinel-path" }, async (state) => {
    const filename = state.statePath("(multiple).sqlite");
    openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: filename });
    await closeOpenClawAgentDatabasesAsync();
    expect(
      await noteDoctorAgentDatabasePathHealth({
        env: state.env,
        cfg: { session: { store: filename } },
        shouldRepair: true,
      }),
    ).toEqual([]);
    expect(fs.existsSync(filename)).toBe(true);
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("SELECT COUNT(*) AS count FROM agent_databases")
        .get(),
    ).toEqual({ count: 1 });
  });
});

it("retains the registration when file removal fails so Doctor can retry", async () => {
  await withOpenClawTestState({ label: "sentinel-path-retry" }, async (state) => {
    const filename = state.statePath("(multiple).sqlite");
    openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: filename });
    await closeOpenClawAgentDatabasesAsync();
    const remove = fs.rmSync;
    const failure = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === `${filename}-wal`) {
        throw Object.assign(new Error("synthetic unlink refusal"), { code: "EACCES" });
      }
      return remove(target, options);
    });
    try {
      expect(
        await noteDoctorAgentDatabasePathHealth({ env: state.env, cfg: {}, shouldRepair: true }),
      ).toEqual([expect.stringContaining("synthetic unlink refusal")]);
    } finally {
      failure.mockRestore();
    }
    expect(fs.existsSync(filename)).toBe(true);
    const registry = openOpenClawStateDatabase({ env: state.env });
    expect(registry.db.prepare("SELECT COUNT(*) AS count FROM agent_databases").get()).toEqual({
      count: 1,
    });
    expect(
      await noteDoctorAgentDatabasePathHealth({ env: state.env, cfg: {}, shouldRepair: true }),
    ).toEqual([]);
    expect(fs.existsSync(filename)).toBe(false);
    expect(registry.db.prepare("SELECT COUNT(*) AS count FROM agent_databases").get()).toEqual({
      count: 0,
    });
  });
});

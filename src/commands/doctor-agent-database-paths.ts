import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  repairOpenClawAgentDatabasePathAliases,
  repairOpenClawSentinelAgentDatabasePaths,
  type AgentDatabasePathRepairReport,
} from "../state/openclaw-agent-db-path-repair.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

/** Repair inventory aliases only before an updater captures its exact-path baseline. */
export async function noteDoctorAgentDatabasePathHealth(params: {
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  cfg: OpenClawConfig;
}): Promise<string[]> {
  if (!params.shouldRepair) {
    return [];
  }
  const report: AgentDatabasePathRepairReport = runOpenClawStateWriteTransaction(
    (database) =>
      isUpdateDoctorLintPass(params.env)
        ? {
            repaired: 0,
            warnings: [
              "Skipped agent database path repair during update Doctor. Run openclaw doctor --fix after the update finishes.",
            ],
          }
        : repairOpenClawAgentDatabasePathAliases(database),
    { env: params.env },
    { operationLabel: "doctor.agent-database-paths" },
  );
  if (report.hasSentinelPaths) {
    try {
      const repaired = await withDoctorSqliteMaintenanceLock({
        env: params.env,
        operation: "agent database path repair",
        run: () => repairOpenClawSentinelAgentDatabasePaths(params.cfg, params.env),
      });
      report.repaired += repaired.repaired;
      report.warnings.push(...repaired.warnings);
      report.backupDirectory = repaired.backupDirectory;
    } catch (error) {
      report.warnings.push(
        `Agent database path repair did not finish: ${formatErrorMessage(error)}`,
      );
    }
  }
  if (report.repaired > 0) {
    invalidateRegisteredAgentDatabasesMemo({ env: params.env });
    note(
      `Repaired ${report.repaired} agent database path registration(s).${report.backupDirectory ? ` Backup: ${report.backupDirectory}` : ""}`,
      "Doctor changes",
    );
  }
  if (report.warnings.length > 0) {
    note(report.warnings.join("\n"), "Doctor warnings");
  }
  return report.warnings;
}

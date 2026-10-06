import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { applyRestorePlan, readCurrentRestoreState, RESTORE_SETTING_DEFAULTS, RestoreApplicationError, validateRestorableEditorData, type RestoreChoice } from '@/lib/restoring/apply';
import { createRestorePlan, type RestorableEditorData, type RestorePlan } from '@/lib/restoring/plan';
import { decodeBackupCommit } from '@/lib/editor-runtime/restore-backup';
import type { RestoreResolution } from '@/lib/restoring/plan';

export type { RestoreResolution };

const SAFE_PLAN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class RestorePlanNotFoundError extends Error {
  constructor() {
    super('Restore plan not found.');
    this.name = 'RestorePlanNotFoundError';
  }
}

function plansRoot(): string {
  return path.join(getRuntimeDataRootPath(), 'workflow', 'restore-plans');
}

function planFilePath(planId: string): string {
  if (!SAFE_PLAN_ID.test(planId)) throw new RestorePlanNotFoundError();
  return path.join(plansRoot(), planId, 'plan.json');
}

/**
 * A plan may only offer choices the apply step accepts. Applying an unsupported or inconsistent
 * backup fails validation, so such a backup must be refused while the plan is still read-only.
 */
function assertPlanApplicableBackup(data: RestorableEditorData): void {
  try {
    validateRestorableEditorData(data);
  } catch (error) {
    throw new RestoreApplicationError(
      422,
      'INVALID_BACKUP',
      error instanceof Error ? error.message : '备份数据无法用于恢复。',
    );
  }
}

export async function createStoredRestorePlan(backupCommit: string): Promise<{ plan: RestorePlan; planId: string }> {
  // Decoding and validating happen before anything is written, so an unsupported or corrupt
  // backup cannot leave a half-created plan behind.
  const current = await readCurrentRestoreState();
  const backup = await decodeBackupCommit(backupCommit);
  assertPlanApplicableBackup(backup.data);
  const plan = createRestorePlan(current.data, backup.data, {
    currentRevision: current.revision,
    backupCommit: backup.commit,
  });

  const planId = randomUUID();
  const filePath = planFilePath(planId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomically(filePath, plan, { mode: 0o600 });
  return { plan, planId };
}

export function readStoredRestorePlan(planId: string): RestorePlan {
  const filePath = planFilePath(planId);
  if (!fs.existsSync(filePath)) throw new RestorePlanNotFoundError();
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RestorePlan;
}

/** The plan DTO deliberately omits absolute paths and internal digests not needed for review. */
export function toRestorePlanDto(plan: RestorePlan) {
  return {
    binding: {
      currentRevision: plan.binding.currentRevision,
      backupCommit: plan.binding.backupCommit,
    },
    added: plan.added,
    identical: plan.identical,
    conflicts: plan.conflicts.map((conflict) => ({
      conflictId: conflict.conflictId,
      kind: conflict.kind,
      summary: conflict.summary,
      resolutions: conflict.resolutions,
      subject: conflict.subject,
    })),
  };
}

export async function applyStoredRestorePlan(planId: string, baseRevision: string, choices: RestoreChoice[]) {
  const plan = readStoredRestorePlan(planId);
  if (baseRevision !== plan.binding.currentRevision) {
    throw new RestoreApplicationError(409, 'REVISION_CONFLICT', '恢复计划基线已变化，请重新生成计划。');
  }
  if (plan.conflicts.some((conflict) => !choices.some((choice) => choice.conflictId === conflict.conflictId))) {
    throw new RestoreApplicationError(422, 'INVALID_SELECTION', '尚未选择全部恢复冲突。');
  }
  return applyRestorePlan(plan, choices, {
    readCurrent: readCurrentRestoreState,
    readBackup: (commit: string) => decodeBackupCommit(commit),
  });
}

export { RESTORE_SETTING_DEFAULTS };

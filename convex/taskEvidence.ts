import { ConvexError, v, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { nonEmpty } from "./validation";

export type EvidenceTaskType = "jd" | "one_time";

export const MAX_EVIDENCE_FILES = 5;
export const MAX_EVIDENCE_TEXT_LENGTH = 5_000;
// Upload URLs and their claims are short-lived. Evidence uses the same claim
// table and TTL as task attachments so expired evidence uploads cannot be
// submitted long after the URL stopped working.
export const TASK_UPLOAD_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

// Deleting one evidence row costs up to two index queries per file plus one
// blob-ref query (11 at the 5-file cap), and a transaction may read 4,096
// index ranges. 50 rows keeps the worst case near 550; the purge re-schedules.
const EVIDENCE_DELETE_BATCH = 50;
const ACTIVE_EVIDENCE_LIMIT = 10;

export const evidenceFileInputValidator = v.object({
  storageId: v.id("_storage"),
  fileName: v.string(),
  claimId: v.id("taskUploadClaims"),
});
export const evidenceInputValidator = v.object({
  text: v.optional(v.string()),
  files: v.optional(v.array(evidenceFileInputValidator)),
});

export type EvidenceInput = Infer<typeof evidenceInputValidator>;
type EvidenceFile = Doc<"taskEvidence">["files"][number];

/**
 * True when a submission carries the evidence already recorded for the task,
 * so a retried completion stays idempotent. Upload claims are consumed on save,
 * so identity is the normalized text plus the stored blobs.
 */
export function evidenceMatchesSubmission(row: Doc<"taskEvidence">, evidence: EvidenceInput) {
  if ((row.text ?? "") !== (evidence.text?.trim() ?? "")) return false;
  const files = evidence.files ?? [];
  const submitted = new Set(files.map((file) => file.storageId));
  // Stored files are unique (validation rejects duplicates), so a repeated id
  // is a different payload even when it only names blobs the task owns.
  if (submitted.size !== files.length) return false;
  if (files.length !== row.files.length) return false;
  const stored = new Set(row.files.map((file) => file.storageId));
  return files.every((file) => stored.has(file.storageId));
}

export type ValidatedEvidence = {
  text?: string;
  files: (EvidenceFile & { claimId: Id<"taskUploadClaims"> })[];
};

/**
 * True when a blob is already owned by task data. Cleanup paths must consult
 * this before deleting storage; evidence files live in an array, so the
 * indexed child table supplies the storageId lookup.
 */
export async function isBlobReferenced(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">) {
  const [attached, evidenced] = await Promise.all([
    ctx.db.query("taskAttachments").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).first(),
    ctx.db.query("taskEvidenceBlobs").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).first(),
  ]);
  return Boolean(attached || evidenced);
}

/**
 * Turns client evidence into the stored shape. Storage metadata is the source
 * of truth for content type and size, and every file must come from an
 * unexpired claim owned by the acting member in this company that has already
 * been bound to this exact blob.
 */
export async function validateEvidenceInput(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    membershipId: Id<"companyMemberships">;
    evidence: EvidenceInput;
    now: number;
  },
): Promise<ValidatedEvidence> {
  const text = args.evidence.text?.trim() ?? "";
  const files = args.evidence.files ?? [];
  if (text.length > MAX_EVIDENCE_TEXT_LENGTH) {
    throw new ConvexError(`Evidence text must be ${MAX_EVIDENCE_TEXT_LENGTH} characters or fewer.`);
  }
  if (files.length > MAX_EVIDENCE_FILES) {
    throw new ConvexError(`Evidence can include at most ${MAX_EVIDENCE_FILES} files.`);
  }
  if (!text && files.length === 0) throw new ConvexError("Evidence is required to complete this task.");

  const seenStorageIds = new Set<string>();
  const seenClaimIds = new Set<Id<"taskUploadClaims">>();
  const validated: ValidatedEvidence["files"] = [];
  for (const file of files) {
    if (seenStorageIds.has(file.storageId)) throw new ConvexError("Duplicate evidence files are not allowed.");
    seenStorageIds.add(file.storageId);
    if (seenClaimIds.has(file.claimId)) throw new ConvexError("Each evidence file needs its own upload.");
    seenClaimIds.add(file.claimId);

    const claim = await ctx.db.get(file.claimId);
    if (!claim || claim.companyId !== args.companyId || claim.membershipId !== args.membershipId) {
      throw new ConvexError("Evidence upload claim not found.");
    }
    // An unbound claim is not proof that this blob came from its upload URL;
    // binding happens through bindEvidenceUploadClaim before submission.
    if (claim.storageId !== file.storageId) {
      throw new ConvexError("Evidence upload claim is bound to a different file.");
    }
    if (args.now - claim.createdAt > TASK_UPLOAD_CLAIM_TTL_MS) {
      throw new ConvexError("Evidence upload claim expired. Upload the file again.");
    }
    const metadata = await ctx.db.system.get("_storage", file.storageId);
    if (!metadata) throw new ConvexError("Uploaded file not found.");
    if (await isBlobReferenced(ctx, file.storageId)) throw new ConvexError("This file is already attached.");

    validated.push({
      storageId: file.storageId,
      fileName: nonEmpty(file.fileName, "File name"),
      contentType: metadata.contentType ?? "application/octet-stream",
      size: metadata.size ?? 0,
      claimId: file.claimId,
    });
  }
  return { text: text || undefined, files: validated };
}

/** Inserts the evidence row and consumes its upload claims in the caller's transaction. */
export async function storeTaskEvidence(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    taskType: EvidenceTaskType;
    taskId: string;
    cycleStart?: number;
    createdByMembershipId: Id<"companyMemberships">;
    now: number;
    evidence: ValidatedEvidence;
  },
) {
  const files: EvidenceFile[] = args.evidence.files.map((file) => ({
    storageId: file.storageId,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
  }));
  const evidenceId = await ctx.db.insert("taskEvidence", {
    companyId: args.companyId,
    taskType: args.taskType,
    taskId: args.taskId,
    ...(args.cycleStart !== undefined ? { cycleStart: args.cycleStart } : {}),
    ...(args.evidence.text !== undefined ? { text: args.evidence.text } : {}),
    files,
    createdByMembershipId: args.createdByMembershipId,
    createdAt: args.now,
  });
  for (const file of files) {
    await ctx.db.insert("taskEvidenceBlobs", { evidenceId, storageId: file.storageId });
  }
  for (const claimId of new Set(args.evidence.files.map((file) => file.claimId))) {
    await ctx.db.delete(claimId);
  }
}

/** The submitted evidence for a JD cycle, or for a one-time task's completion. */
export async function activeTaskEvidence(
  ctx: QueryCtx | MutationCtx,
  taskType: EvidenceTaskType,
  taskId: string,
  cycleStart?: number,
) {
  if (taskType === "jd") {
    if (cycleStart === undefined) return null;
    return await ctx.db
      .query("taskEvidence")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", taskId).eq("cycleStart", cycleStart))
      .filter((q) => q.eq(q.field("retiredAt"), undefined))
      .first();
  }
  return await ctx.db
    .query("taskEvidence")
    .withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId))
    .filter((q) => q.and(q.eq(q.field("retiredAt"), undefined), q.eq(q.field("cycleStart"), undefined)))
    .first();
}

/** Marks the evidence for a superseded JD cycle as history. */
export async function retireTaskEvidenceAtCycle(
  ctx: MutationCtx,
  taskId: Id<"jdTasks">,
  cycleStart: number,
  now: number,
) {
  const active = await activeTaskEvidence(ctx, "jd", taskId, cycleStart);
  if (active) await ctx.db.patch(active._id, { retiredAt: now });
}

async function deleteEvidenceRow(ctx: MutationCtx, row: Doc<"taskEvidence">) {
  for (const file of row.files) {
    // Evidence files cannot also be attachments or other evidence, but legacy
    // data may overlap; never delete a blob another row still references.
    const [attached, otherEvidence] = await Promise.all([
      ctx.db.query("taskAttachments").withIndex("by_storageId", (q) => q.eq("storageId", file.storageId)).first(),
      ctx.db
        .query("taskEvidenceBlobs")
        .withIndex("by_storageId", (q) => q.eq("storageId", file.storageId))
        .filter((q) => q.neq(q.field("evidenceId"), row._id))
        .first(),
    ]);
    if (!attached && !otherEvidence) await ctx.storage.delete(file.storageId);
  }
  const blobRefs = await ctx.db
    .query("taskEvidenceBlobs")
    .withIndex("by_evidenceId", (q) => q.eq("evidenceId", row._id))
    .take(EVIDENCE_DELETE_BATCH);
  for (const ref of blobRefs) await ctx.db.delete(ref._id);
  await ctx.db.delete(row._id);
}

/** Removes a task's active evidence when it leaves Completed. */
export async function deleteActiveTaskEvidence(
  ctx: MutationCtx,
  taskType: EvidenceTaskType,
  taskId: string,
  cycleStart?: number,
) {
  const rows = taskType === "jd"
    ? cycleStart === undefined
      ? []
      : await ctx.db
        .query("taskEvidence")
        .withIndex("by_task_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", taskId).eq("cycleStart", cycleStart))
        .filter((q) => q.eq(q.field("retiredAt"), undefined))
        .take(ACTIVE_EVIDENCE_LIMIT)
    : await ctx.db
      .query("taskEvidence")
      .withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId))
      .filter((q) => q.and(q.eq(q.field("retiredAt"), undefined), q.eq(q.field("cycleStart"), undefined)))
      .take(ACTIVE_EVIDENCE_LIMIT);
  for (const row of rows) await deleteEvidenceRow(ctx, row);
}

/** Deletes one bounded batch of a task's evidence rows and their blobs. */
export async function deleteTaskEvidenceBatch(
  ctx: MutationCtx,
  taskType: EvidenceTaskType,
  taskId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("taskEvidence")
    .withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId))
    .take(EVIDENCE_DELETE_BATCH);
  if (!rows.length) return false;
  for (const row of rows) await deleteEvidenceRow(ctx, row);
  return true;
}

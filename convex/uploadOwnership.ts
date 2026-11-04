import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type Ctx = QueryCtx | MutationCtx;

/**
 * Every place a stored blob can be owned, across features. Upload claims are
 * cleanup tokens, so binding and cleanup must consult this shared boundary
 * instead of only one feature's tables.
 */
export async function isStorageBlobContentReferenced(
  ctx: Ctx,
  storageId: Id<"_storage">,
) {
  const [taskAttachment, taskEvidence, fleetFuel, fleetService] = await Promise.all([
    ctx.db
      .query("taskAttachments")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("taskEvidenceBlobs")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("fleetFuelEntries")
      .withIndex("by_photoStorageId", (q) => q.eq("photoStorageId", storageId))
      .first(),
    ctx.db
      .query("fleetServiceEntries")
      .withIndex("by_photoStorageId", (q) => q.eq("photoStorageId", storageId))
      .first(),
  ]);
  return Boolean(taskAttachment || taskEvidence || fleetFuel || fleetService);
}

/** True when another upload claim already names this blob. */
export async function isStorageBlobClaimed(
  ctx: Ctx,
  storageId: Id<"_storage">,
  except?: {
    taskClaimId?: Id<"taskUploadClaims">;
    fleetClaimId?: Id<"fleetUploadClaims">;
  },
) {
  const [taskClaims, fleetClaims] = await Promise.all([
    ctx.db
      .query("taskUploadClaims")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .take(2),
    ctx.db
      .query("fleetUploadClaims")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .take(2),
  ]);
  return (
    taskClaims.some((claim) => claim._id !== except?.taskClaimId) ||
    fleetClaims.some((claim) => claim._id !== except?.fleetClaimId)
  );
}

export async function isStorageBlobOwned(ctx: Ctx, storageId: Id<"_storage">) {
  return (
    (await isStorageBlobContentReferenced(ctx, storageId)) ||
    (await isStorageBlobClaimed(ctx, storageId))
  );
}

/** A claim may only own a blob uploaded after the claim was issued. */
export function storagePredatesClaim(
  metadata: { _creationTime: number },
  claimCreatedAt: number,
) {
  return metadata._creationTime < claimCreatedAt;
}

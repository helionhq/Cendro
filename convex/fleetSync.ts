import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { EMPTY_TRACKER_RESPONSE_MESSAGE, fetchTrackerVehicles, trackerSafeMessage } from "./fleetTracker";

export type CompanySyncResult = {
  connected: boolean;
  ok: boolean;
  lastSyncAt: number | null;
  error: string | null;
  vehicleCount: number;
  counts: {
    inserted: number;
    updated: number;
    unchanged: number;
    missing: number;
    present: number;
  } | null;
};

/**
 * One tracker fetch per company. A failure is recorded as a short, secret-safe
 * message and returned; callers decide whether that blocks them. Trip logging
 * deliberately ignores the failure and falls back to the last synced reading.
 */
export async function fetchAndApplyCompanyVehicles(
  ctx: ActionCtx,
  companyId: Id<"companies">,
): Promise<CompanySyncResult> {
  const source = await ctx.runQuery(internal.fleetInternal.getSyncSource, { companyId });
  if (!source.connection) {
    return {
      connected: false,
      ok: false,
      lastSyncAt: null,
      error: "Connect the tracker first.",
      vehicleCount: 0,
      counts: null,
    };
  }

  let parsed: Awaited<ReturnType<typeof fetchTrackerVehicles>>;
  try {
    parsed = await fetchTrackerVehicles(source.connection.secretKey);
  } catch (error) {
    const message = trackerSafeMessage(error);
    await ctx.runMutation(internal.fleetInternal.recordSyncFailure, {
      companyId,
      message,
      now: Date.now(),
    });
    return {
      connected: true,
      ok: false,
      lastSyncAt: source.connection.lastSyncAt,
      error: message,
      vehicleCount: 0,
      counts: null,
    };
  }

  // A database failure here is not a tracker failure; let the caller handle it
  // rather than recording a misleading sync error.
  const now = Date.now();
  const applied: {
    inserted: number;
    updated: number;
    unchanged: number;
    missing: number;
    present: number;
    emptyResponse: boolean;
  } = await ctx.runMutation(internal.fleetInternal.applyTrackerSync, {
    companyId,
    now,
    vehicles: parsed.vehicles,
  });
  if (applied.emptyResponse) {
    // The mutation wrote nothing: no missing markers and no lastSyncAt change.
    await ctx.runMutation(internal.fleetInternal.recordSyncFailure, {
      companyId,
      message: EMPTY_TRACKER_RESPONSE_MESSAGE,
      now,
    });
    return {
      connected: true,
      ok: false,
      lastSyncAt: source.connection.lastSyncAt,
      error: EMPTY_TRACKER_RESPONSE_MESSAGE,
      vehicleCount: 0,
      counts: null,
    };
  }
  return {
    connected: true,
    ok: true,
    lastSyncAt: now,
    error: null,
    vehicleCount: parsed.vehicles.length,
    counts: applied,
  };
}

export const syncAllTrackers = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; succeeded: number; failed: number }> => {
    const page: {
      connections: { companyId: Id<"companies">; secretKey: string }[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.fleetInternal.listConnectionsPage, {
      cursor: args.cursor ?? null,
    });

    let succeeded = 0;
    let failed = 0;
    for (const connection of page.connections) {
      // One company's failure (tracker or database) must not block the rest.
      try {
        const result = await fetchAndApplyCompanyVehicles(ctx, connection.companyId);
        if (result.ok) succeeded += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fleetSync.syncAllTrackers, {
        cursor: page.continueCursor,
      });
    }
    return { processed: page.connections.length, succeeded, failed };
  },
});

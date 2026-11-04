import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { nonEmpty } from "./validation";
import { takeWithOverflow } from "./queryLimits";
import { trackerVehicleValidator, type TrackerVehicle, EMPTY_TRACKER_RESPONSE_MESSAGE } from "./fleetTracker";

export const MAX_FLEET_VEHICLES = 500;
export const MAX_FLEET_DRIVERS = 200;
export const MAX_OPEN_TRIPS = 200;
export const MAX_FLEET_PHOTO_BYTES = 10 * 1024 * 1024;
export const FLEET_UPLOAD_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const FUEL_INSIGHT_SCAN_LIMIT = 2_000;
export const MAX_ALERTS = 100;
export const MAX_DESTINATION = 200;

export function metersToKm(meters: number | null | undefined) {
  return meters == null ? null : meters / 1000;
}

export async function loadCompanyVehicles(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
) {
  return await takeWithOverflow(
    (limit) =>
      ctx.db
        .query("fleetVehicles")
        .withIndex("by_company", (q) => q.eq("companyId", companyId))
        .take(limit),
    MAX_FLEET_VEHICLES,
  );
}

export async function loadOpenTrips(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) {
  return await takeWithOverflow(
    (limit) =>
      ctx.db
        .query("fleetTrips")
        .withIndex("by_companyId_and_status_and_departedAt", (q) =>
          q.eq("companyId", companyId).eq("status", "open"),
        )
        .order("desc")
        .take(limit),
    MAX_OPEN_TRIPS,
  );
}

async function loadLatestService(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"fleetVehicles">,
) {
  return await ctx.db
    .query("fleetServiceEntries")
    .withIndex("by_vehicleId_and_servicedAt", (q) => q.eq("vehicleId", vehicleId))
    .order("desc")
    .first();
}

export async function loadLatestServices(
  ctx: QueryCtx | MutationCtx,
  vehicles: readonly Doc<"fleetVehicles">[],
) {
  const latest = new Map<Id<"fleetVehicles">, Doc<"fleetServiceEntries"> | null>();
  for (const vehicle of vehicles) latest.set(vehicle._id, await loadLatestService(ctx, vehicle._id));
  return latest;
}

async function hasEntryBlobReference(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">,
) {
  const [fuel, service] = await Promise.all([
    ctx.db
      .query("fleetFuelEntries")
      .withIndex("by_photoStorageId", (q) => q.eq("photoStorageId", storageId))
      .first(),
    ctx.db
      .query("fleetServiceEntries")
      .withIndex("by_photoStorageId", (q) => q.eq("photoStorageId", storageId))
      .first(),
  ]);
  return Boolean(fuel || service);
}

/** A blob already owned by a fleet entry cannot be claimed by a new save. */
export async function isFleetEntryBlobReferenced(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">,
) {
  return await hasEntryBlobReference(ctx, storageId);
}

/**
 * True when a blob is still owned by a fleet entry or another upload claim.
 * Cleanup must check this before deleting storage.
 */
export async function isFleetBlobReferenced(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">,
) {
  const [entryReference, claim] = await Promise.all([
    hasEntryBlobReference(ctx, storageId),
    ctx.db
      .query("fleetUploadClaims")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first(),
  ]);
  return entryReference || Boolean(claim);
}

async function upsertTrackerVehicles(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  incoming: readonly TrackerVehicle[],
  now: number,
) {
  const byRegistration = new Map<string, TrackerVehicle>();
  for (const vehicle of incoming) byRegistration.set(vehicle.registrationNumber, vehicle);

  const existingVehicles: Doc<"fleetVehicles">[] = [];
  for await (const vehicle of ctx.db
    .query("fleetVehicles")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))) {
    existingVehicles.push(vehicle);
  }
  const existingByRegistration = new Map(
    existingVehicles.map((vehicle) => [vehicle.registrationNumber, vehicle]),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const [registrationNumber, incomingVehicle] of byRegistration) {
    const existing = existingByRegistration.get(registrationNumber);
    if (!existing) {
      await ctx.db.insert("fleetVehicles", {
        companyId,
        registrationNumber,
        ...(incomingVehicle.odometerMeters !== undefined ? { odometerMeters: incomingVehicle.odometerMeters } : {}),
        ...(incomingVehicle.lat !== undefined ? { lat: incomingVehicle.lat } : {}),
        ...(incomingVehicle.lng !== undefined ? { lng: incomingVehicle.lng } : {}),
        ...(incomingVehicle.address !== undefined ? { address: incomingVehicle.address } : {}),
        ...(incomingVehicle.speed !== undefined ? { speed: incomingVehicle.speed } : {}),
        ...(incomingVehicle.ignitionOn !== undefined ? { ignitionOn: incomingVehicle.ignitionOn } : {}),
        ...(incomingVehicle.recordedAt !== undefined ? { recordedAt: incomingVehicle.recordedAt } : {}),
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      inserted += 1;
      continue;
    }

    // The tracker can answer with a cached reading. Never let it roll the
    // stored state backwards.
    const staleReading =
      existing.recordedAt !== undefined &&
      incomingVehicle.recordedAt !== undefined &&
      incomingVehicle.recordedAt < existing.recordedAt;

    const patch: Partial<Doc<"fleetVehicles">> = {};
    if (!staleReading) {
      if (
        incomingVehicle.odometerMeters !== undefined &&
        incomingVehicle.odometerMeters !== existing.odometerMeters
      ) {
        patch.odometerMeters = incomingVehicle.odometerMeters;
      }
      if (incomingVehicle.lat !== undefined && incomingVehicle.lat !== existing.lat) patch.lat = incomingVehicle.lat;
      if (incomingVehicle.lng !== undefined && incomingVehicle.lng !== existing.lng) patch.lng = incomingVehicle.lng;
      if (incomingVehicle.address !== undefined && incomingVehicle.address !== existing.address) {
        patch.address = incomingVehicle.address;
      }
      if (incomingVehicle.speed !== undefined && incomingVehicle.speed !== existing.speed) {
        patch.speed = incomingVehicle.speed;
      }
      if (
        incomingVehicle.ignitionOn !== undefined &&
        incomingVehicle.ignitionOn !== existing.ignitionOn
      ) {
        patch.ignitionOn = incomingVehicle.ignitionOn;
      }
      if (
        incomingVehicle.recordedAt !== undefined &&
        incomingVehicle.recordedAt !== existing.recordedAt
      ) {
        patch.recordedAt = incomingVehicle.recordedAt;
      }
    }

    const reappeared = existing.missingFromTrackerAt !== undefined;
    if (reappeared) patch.missingFromTrackerAt = undefined;
    // `lastSeenAt` is the sync that last observed a new reading; bumping it
    // unconditionally would rewrite every vehicle on every cron tick.
    if (!staleReading && Object.keys(patch).some((key) => key !== "missingFromTrackerAt")) {
      patch.lastSeenAt = now;
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = now;
      await ctx.db.patch(existing._id, patch);
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  for (const existing of existingVehicles) {
    if (byRegistration.has(existing.registrationNumber)) continue;
    if (existing.missingFromTrackerAt === undefined) {
      await ctx.db.patch(existing._id, { missingFromTrackerAt: now, updatedAt: now });
      missing += 1;
    }
  }

  return { inserted, updated, unchanged, missing, present: byRegistration.size };
}

export const getSyncSource = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    return connection
      ? {
          connection: {
            secretKey: connection.secretKey,
            lastSyncAt: connection.lastSyncAt ?? null,
            connectedAt: connection.connectedAt,
          },
        }
      : { connection: null };
  },
});

export const listConnectionsPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("fleetTrackerConnections")
      .paginate({ numItems: 10, cursor: args.cursor ?? null });
    return {
      connections: page.page.map((connection) => ({
        companyId: connection.companyId,
        secretKey: connection.secretKey,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

async function hasExistingVehicles(ctx: MutationCtx, companyId: Id<"companies">) {
  return (
    (await ctx.db
      .query("fleetVehicles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .first()) !== null
  );
}

export const saveConnectionAndSync = internalMutation({
  args: {
    companyId: v.id("companies"),
    secretKey: v.string(),
    keyHint: v.string(),
    connectedByMembershipId: v.id("companyMemberships"),
    now: v.number(),
    vehicles: v.array(trackerVehicleValidator),
  },
  handler: async (ctx, args) => {
    // A valid key that suddenly reports no vehicles is far more likely to be
    // the wrong tracker account than a fleet disappearing. Save nothing.
    if (args.vehicles.length === 0 && (await hasExistingVehicles(ctx, args.companyId))) {
      throw new ConvexError(EMPTY_TRACKER_RESPONSE_MESSAGE);
    }
    const existing = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        secretKey: args.secretKey,
        keyHint: args.keyHint,
        connectedAt: args.now,
        connectedByMembershipId: args.connectedByMembershipId,
        lastSyncAt: args.now,
        lastSyncError: undefined,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("fleetTrackerConnections", {
        companyId: args.companyId,
        secretKey: args.secretKey,
        keyHint: args.keyHint,
        connectedAt: args.now,
        connectedByMembershipId: args.connectedByMembershipId,
        lastSyncAt: args.now,
        updatedAt: args.now,
      });
    }
    const counts = await upsertTrackerVehicles(ctx, args.companyId, args.vehicles, args.now);
    return { keyHint: args.keyHint, vehicleCount: counts.present, ...counts };
  },
});

export const applyTrackerSync = internalMutation({
  args: {
    companyId: v.id("companies"),
    now: v.number(),
    vehicles: v.array(trackerVehicleValidator),
  },
  handler: async (ctx, args) => {
    // An empty response while a fleet already exists must not mark every
    // vehicle missing or count as a successful sync.
    if (args.vehicles.length === 0 && (await hasExistingVehicles(ctx, args.companyId))) {
      return { inserted: 0, updated: 0, unchanged: 0, missing: 0, present: 0, emptyResponse: true };
    }
    const counts = await upsertTrackerVehicles(ctx, args.companyId, args.vehicles, args.now);
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        lastSyncAt: args.now,
        lastSyncError: undefined,
        updatedAt: args.now,
      });
    }
    return { ...counts, emptyResponse: false };
  },
});

export const recordSyncFailure = internalMutation({
  args: {
    companyId: v.id("companies"),
    message: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        lastSyncError: args.message,
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const applyStartTrip = internalMutation({
  args: {
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    vehicleId: v.id("fleetVehicles"),
    driverId: v.id("fleetDrivers"),
    destination: v.string(),
    notes: v.optional(v.string()),
    departedAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.companyId !== args.companyId) throw new ConvexError("Vehicle not found.");
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.companyId !== args.companyId) throw new ConvexError("Driver not found.");
    if (!driver.active) throw new ConvexError("This driver is inactive.");

    const vehicleOpenTrip = await ctx.db
      .query("fleetTrips")
      .withIndex("by_vehicleId_and_status", (q) =>
        q.eq("vehicleId", args.vehicleId).eq("status", "open"),
      )
      .first();
    if (vehicleOpenTrip) throw new ConvexError("This vehicle already has an open trip.");
    const driverOpenTrip = await ctx.db
      .query("fleetTrips")
      .withIndex("by_driverId_and_status", (q) =>
        q.eq("driverId", args.driverId).eq("status", "open"),
      )
      .first();
    if (driverOpenTrip) throw new ConvexError("This driver is already on a trip.");

    const departedAt = args.departedAt ?? args.now;
    if (!Number.isFinite(departedAt)) throw new ConvexError("Departure time is invalid.");
    const destination = nonEmpty(args.destination, "Destination");
    if (destination.length > MAX_DESTINATION) throw new ConvexError("Destination is too long.");
    const notes = args.notes?.trim();

    const tripId = await ctx.db.insert("fleetTrips", {
      companyId: args.companyId,
      vehicleId: args.vehicleId,
      driverId: args.driverId,
      destination,
      ...(notes ? { notes } : {}),
      status: "open",
      departedAt,
      ...(vehicle.odometerMeters !== undefined
        ? { startOdometerMeters: vehicle.odometerMeters }
        : {}),
      createdByMembershipId: args.membershipId,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { tripId, startOdometerMeters: vehicle.odometerMeters ?? null };
  },
});

export const applyReturnTrip = internalMutation({
  args: {
    companyId: v.id("companies"),
    tripId: v.id("fleetTrips"),
    returnedAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const trip = await ctx.db.get(args.tripId);
    if (!trip || trip.companyId !== args.companyId) throw new ConvexError("Trip not found.");
    if (trip.status === "returned") {
      return {
        tripId: trip._id,
        returnedAt: trip.returnedAt ?? null,
        endOdometerMeters: trip.endOdometerMeters ?? null,
        alreadyReturned: true,
      };
    }
    const returnedAt = args.returnedAt ?? args.now;
    if (!Number.isFinite(returnedAt)) throw new ConvexError("Return time is invalid.");
    if (returnedAt < trip.departedAt) {
      throw new ConvexError("Return time cannot be before departure.");
    }
    const vehicle = await ctx.db.get(trip.vehicleId);
    const endOdometerMeters =
      vehicle && vehicle.companyId === args.companyId ? vehicle.odometerMeters : undefined;
    await ctx.db.patch(trip._id, {
      status: "returned",
      returnedAt,
      ...(endOdometerMeters !== undefined ? { endOdometerMeters } : {}),
      updatedAt: args.now,
    });
    return {
      tripId: trip._id,
      returnedAt,
      endOdometerMeters: endOdometerMeters ?? null,
      alreadyReturned: false,
    };
  },
});

// Abandoned photo uploads (closed tab, failed entry save) are reclaimed once
// the URL they guard could no longer have completed an upload, including the
// bound blob when no entry owns it.
export const sweepExpiredFleetUploadClaims = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - FLEET_UPLOAD_CLAIM_TTL_MS;
    const page = await ctx.db
      .query("fleetUploadClaims")
      .order("asc")
      .paginate({ numItems: 200, cursor: args.cursor ?? null });
    for (const claim of page.page) {
      // Rows scan in creation order — a fresh claim means the rest are fresh.
      if (claim.createdAt >= cutoff) return null;
      const storageId = claim.storageId;
      await ctx.db.delete(claim._id);
      if (storageId && !(await isFleetBlobReferenced(ctx, storageId))) {
        await ctx.storage.delete(storageId);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fleetInternal.sweepExpiredFleetUploadClaims, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

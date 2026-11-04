import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { mutation } from "./functions";
import {
  computeFuelSeries,
  computeServiceStatus,
  computeSpendSummary,
  fleetMonthWindows,
  FUEL_ANOMALY_WINDOW_MS,
  serviceStatusRank,
  type ServiceStatus,
} from "./fleetDerived";
import {
  FLEET_UPLOAD_CLAIM_TTL_MS,
  FUEL_INSIGHT_SCAN_LIMIT,
  isFleetBlobReferenced,
  isFleetEntryBlobReferenced,
  loadCompanyVehicles,
  loadLatestServices,
  loadOpenTrips,
  MAX_ALERTS,
  MAX_DESTINATION,
  MAX_FLEET_DRIVERS,
  MAX_FLEET_PHOTO_BYTES,
  metersToKm,
} from "./fleetInternal";
import { fetchAndApplyCompanyVehicles } from "./fleetSync";
import {
  fetchTrackerVehicles,
  trackerKeyHint,
  trackerSafeMessage,
  type TrackerVehicle,
} from "./fleetTracker";
import { requireCapability, requireMembership } from "./permissions";
import { takeWithOverflow } from "./queryLimits";
import { nonEmpty } from "./validation";

const SYNC_NOW_COOLDOWN_MS = 60_000;
const TRACKER_STALE_MS = 60 * 60 * 1000;
const MAX_DRIVER_NAME = 100;
const MAX_SERVICE_DESCRIPTION = 300;

const photoInputValidator = v.object({
  storageId: v.id("_storage"),
  claimId: v.id("fleetUploadClaims"),
  fileName: v.string(),
});

function requireFleetLogOrManage(ctx: MutationCtx, companyId: Id<"companies">) {
  return requireMembership(ctx, companyId).then((auth) => {
    if (!auth.capabilities.has("fleet:log") && !auth.capabilities.has("fleet:manage")) {
      throw new ConvexError("You do not have access to do that.");
    }
    return auth;
  });
}

async function requireFleetVehicle(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
  vehicleId: Id<"fleetVehicles">,
) {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.companyId !== companyId) throw new ConvexError("Vehicle not found.");
  return vehicle;
}

async function requireFleetDriver(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
  driverId: Id<"fleetDrivers">,
) {
  const driver = await ctx.db.get(driverId);
  if (!driver || driver.companyId !== companyId) throw new ConvexError("Driver not found.");
  return driver;
}

async function requireFleetTrip(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
  tripId: Id<"fleetTrips">,
) {
  const trip = await ctx.db.get(tripId);
  if (!trip || trip.companyId !== companyId) throw new ConvexError("Trip not found.");
  return trip;
}

function validateOdometer(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new ConvexError(`${label} is invalid.`);
  return value;
}

function validateMoney(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new ConvexError(`${label} is invalid.`);
  return value;
}

function validateDate(value: number, label: string) {
  if (!Number.isFinite(value)) throw new ConvexError(`${label} is invalid.`);
  return value;
}

// Stored-script vectors such as SVG are intentionally excluded: photo links
// open the stored blob directly in a new tab.
const ALLOWED_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function isAllowedPhotoContentType(contentType: string | undefined) {
  return ALLOWED_PHOTO_CONTENT_TYPES.has((contentType ?? "").toLowerCase());
}

function validatePhotoMetadata(metadata: { contentType?: string; size?: number }) {
  const contentType = (metadata.contentType ?? "").toLowerCase();
  if (!isAllowedPhotoContentType(contentType)) {
    throw new ConvexError("Attach a JPEG, PNG, WebP, HEIC, or HEIF image.");
  }
  if ((metadata.size ?? 0) > MAX_FLEET_PHOTO_BYTES) {
    throw new ConvexError("Photo must be 10 MB or smaller.");
  }
  return { contentType, size: metadata.size ?? 0 };
}

/**
 * Validates the single-use upload claim for a required or replacement photo and
 * returns the flattened fields stored on the entry. The claim is consumed by
 * the caller after the entry is written.
 */
async function validatePhotoClaim(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    membershipId: Id<"companyMemberships">;
    photo: { storageId: Id<"_storage">; claimId: Id<"fleetUploadClaims">; fileName: string };
  },
) {
  const claim = await ctx.db.get(args.photo.claimId);
  if (
    !claim ||
    claim.companyId !== args.companyId ||
    claim.membershipId !== args.membershipId
  ) {
    throw new ConvexError("Photo upload claim not found.");
  }
  if (claim.storageId !== args.photo.storageId) {
    throw new ConvexError("Photo upload claim is bound to a different file.");
  }
  if (Date.now() - claim.createdAt > FLEET_UPLOAD_CLAIM_TTL_MS) {
    throw new ConvexError("Photo upload claim expired. Upload the photo again.");
  }
  const metadata = await ctx.db.system.get("_storage", args.photo.storageId);
  if (!metadata) throw new ConvexError("Uploaded photo not found.");
  const { contentType, size } = validatePhotoMetadata(metadata);
  if (await isFleetEntryBlobReferenced(ctx, args.photo.storageId)) {
    throw new ConvexError("This photo is already attached.");
  }
  return {
    photoStorageId: args.photo.storageId,
    photoFileName: nonEmpty(args.photo.fileName, "File name"),
    photoContentType: contentType,
    photoSize: size,
    claimId: args.photo.claimId,
  };
}

type VehicleStatus = "on_trip" | "missing" | "unknown" | "moving" | "parked";

function publicVehicle(
  vehicle: Doc<"fleetVehicles">,
  trip: Doc<"fleetTrips"> | null,
  driverName: string | null,
  serviceStatus: ServiceStatus,
) {
  const status: VehicleStatus = trip
    ? "on_trip"
    : vehicle.missingFromTrackerAt !== undefined
      ? "missing"
      : vehicle.recordedAt === undefined
        ? "unknown"
        : (vehicle.speed ?? 0) > 0
          ? "moving"
          : "parked";
  return {
    _id: vehicle._id,
    registrationNumber: vehicle.registrationNumber,
    displayName: vehicle.displayName ?? null,
    name: vehicle.displayName?.trim() || vehicle.registrationNumber,
    odometerMeters: vehicle.odometerMeters ?? null,
    odometerKm: metersToKm(vehicle.odometerMeters),
    lat: vehicle.lat ?? null,
    lng: vehicle.lng ?? null,
    address: vehicle.address ?? null,
    speed: vehicle.speed ?? null,
    ignitionOn: vehicle.ignitionOn ?? null,
    recordedAt: vehicle.recordedAt ?? null,
    lastSeenAt: vehicle.lastSeenAt ?? null,
    missingFromTrackerAt: vehicle.missingFromTrackerAt ?? null,
    status,
    openTrip: trip
      ? {
          _id: trip._id,
          driverId: trip.driverId,
          driverName: driverName ?? "Unknown driver",
          destination: trip.destination,
          departedAt: trip.departedAt,
        }
      : null,
    serviceStatus,
  };
}

async function driverNameFor(
  ctx: QueryCtx | MutationCtx,
  driverId: Id<"fleetDrivers">,
  cache: Map<Id<"fleetDrivers">, string>,
) {
  const cached = cache.get(driverId);
  if (cached !== undefined) return cached;
  const driver = await ctx.db.get(driverId);
  const name = driver?.name ?? "Unknown driver";
  cache.set(driverId, name);
  return name;
}

async function buildVehicleRows(ctx: QueryCtx, companyId: Id<"companies">, now: number) {
  const { rows: vehicles, isTruncated } = await loadCompanyVehicles(ctx, companyId);
  const open = await loadOpenTrips(ctx, companyId);
  const openByVehicle = new Map(open.rows.map((trip) => [trip.vehicleId, trip]));
  const latestServices = await loadLatestServices(ctx, vehicles);
  const driverNames = new Map<Id<"fleetDrivers">, string>();

  const rows = [];
  for (const vehicle of vehicles) {
    const trip = openByVehicle.get(vehicle._id) ?? null;
    const driverName = trip ? await driverNameFor(ctx, trip.driverId, driverNames) : null;
    const serviceStatus = computeServiceStatus({
      serviceIntervalKm: vehicle.serviceIntervalKm ?? null,
      serviceIntervalDays: vehicle.serviceIntervalDays ?? null,
      lastService: latestServices.get(vehicle._id) ?? null,
      currentOdometerMeters: vehicle.odometerMeters ?? null,
      now,
    });
    rows.push(publicVehicle(vehicle, trip, driverName, serviceStatus));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { vehicles: rows, isTruncated: isTruncated || open.isTruncated };
}

function serviceUrgency(status: ServiceStatus) {
  const km = status.kmRemaining ?? Number.POSITIVE_INFINITY;
  const days = status.daysRemaining ?? Number.POSITIVE_INFINITY;
  return { km, days };
}

async function buildMaintenanceRows(ctx: QueryCtx, companyId: Id<"companies">, now: number) {
  const { rows: vehicles, isTruncated } = await loadCompanyVehicles(ctx, companyId);
  const latestServices = await loadLatestServices(ctx, vehicles);
  const rows = vehicles.map((vehicle) => {
    const serviceStatus = computeServiceStatus({
      serviceIntervalKm: vehicle.serviceIntervalKm ?? null,
      serviceIntervalDays: vehicle.serviceIntervalDays ?? null,
      lastService: latestServices.get(vehicle._id) ?? null,
      currentOdometerMeters: vehicle.odometerMeters ?? null,
      now,
    });
    return {
      vehicleId: vehicle._id,
      registrationNumber: vehicle.registrationNumber,
      displayName: vehicle.displayName ?? null,
      name: vehicle.displayName?.trim() || vehicle.registrationNumber,
      odometerMeters: vehicle.odometerMeters ?? null,
      odometerKm: metersToKm(vehicle.odometerMeters),
      serviceStatus,
    };
  });
  rows.sort((a, b) => {
    const rank = serviceStatusRank(a.serviceStatus.status) - serviceStatusRank(b.serviceStatus.status);
    if (rank !== 0) return rank;
    const aUrgency = serviceUrgency(a.serviceStatus);
    const bUrgency = serviceUrgency(b.serviceStatus);
    if (aUrgency.km !== bUrgency.km) return aUrgency.km < bUrgency.km ? -1 : 1;
    if (aUrgency.days !== bUrgency.days) return aUrgency.days < bUrgency.days ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { rows, isTruncated };
}

async function buildFuelInsights(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  timeZone: string | null,
  now: number,
) {
  const windows = fleetMonthWindows(now, timeZone);
  // History cannot be inferred from the window below, so read the true
  // earliest fill with one indexed lookup for the fleet and one per vehicle.
  const earliestFleetFill = await ctx.db
    .query("fleetFuelEntries")
    .withIndex("by_companyId_and_filledAt", (q) => q.eq("companyId", companyId))
    .order("asc")
    .first();
  const fleetHasThreeMonthsHistory =
    earliestFleetFill !== null && earliestFleetFill.filledAt <= windows.threeMonthsAgoStart;

  const { rows: fills, isTruncated } = await takeWithOverflow(
    (limit) =>
      ctx.db
        .query("fleetFuelEntries")
        .withIndex("by_companyId_and_filledAt", (q) =>
          q.eq("companyId", companyId).gte("filledAt", windows.threeMonthsAgoStart),
        )
        .order("desc")
        .take(limit),
    FUEL_INSIGHT_SCAN_LIMIT,
  );

  const byVehicle = new Map<Id<"fleetVehicles">, Doc<"fleetFuelEntries">[]>();
  for (const fill of fills) {
    const rows = byVehicle.get(fill.vehicleId);
    if (rows) rows.push(fill);
    else byVehicle.set(fill.vehicleId, [fill]);
  }

  const anomalies: {
    entryId: Id<"fleetFuelEntries">;
    vehicleId: Id<"fleetVehicles">;
    vehicleName: string;
    registrationNumber: string;
    filledAt: number;
    kmPerL: number;
    medianKmPerL: number;
    litres: number;
    amount: number;
  }[] = [];
  const byVehicleSpend = [];

  for (const [vehicleId, vehicleFills] of byVehicle) {
    const vehicle = await ctx.db.get(vehicleId);
    const registrationNumber = vehicle?.registrationNumber ?? "Unknown vehicle";
    const name = vehicle?.displayName?.trim() || registrationNumber;
    const earliestVehicleFill = await ctx.db
      .query("fleetFuelEntries")
      .withIndex("by_vehicleId_and_filledAt", (q) => q.eq("vehicleId", vehicleId))
      .order("asc")
      .first();
    const vehicleHasThreeMonthsHistory =
      earliestVehicleFill !== null && earliestVehicleFill.filledAt <= windows.threeMonthsAgoStart;
    const series = computeFuelSeries(
      vehicleFills.map((fill) => ({
        id: fill._id,
        filledAt: fill.filledAt,
        litres: fill.litres,
        amount: fill.amount,
        odometerMeters: fill.odometerMeters ?? null,
      })),
    );
    for (const point of series) {
      if (point.anomaly && point.filledAt >= now - FUEL_ANOMALY_WINDOW_MS) {
        anomalies.push({
          entryId: point.id as Id<"fleetFuelEntries">,
          vehicleId,
          vehicleName: name,
          registrationNumber,
          filledAt: point.filledAt,
          kmPerL: point.kmPerL as number,
          medianKmPerL: point.medianKmPerL as number,
          litres: point.litres,
          amount: point.amount,
        });
      }
    }
    const spend = computeSpendSummary(series, windows, now, vehicleHasThreeMonthsHistory);
    byVehicleSpend.push({
      vehicleId,
      registrationNumber,
      displayName: vehicle?.displayName ?? null,
      name,
      ...spend,
    });
  }

  anomalies.sort((a, b) => b.filledAt - a.filledAt);
  byVehicleSpend.sort((a, b) => b.currentMonthSpend - a.currentMonthSpend);
  const fleet = computeSpendSummary(fills, windows, now, fleetHasThreeMonthsHistory);

  return {
    currentMonthStart: windows.currentStart,
    previousMonthStart: windows.previousStart,
    threeMonthsAgoStart: windows.threeMonthsAgoStart,
    fleet,
    byVehicle: byVehicleSpend,
    anomalies,
    isTruncated,
  };
}

function alertServiceMessage(prefix: string, status: ServiceStatus) {
  const parts: string[] = [];
  if (status.kmRemaining !== null) {
    const km = Math.round(Math.abs(status.kmRemaining));
    parts.push(status.kmRemaining <= 0 ? `${km} km past due` : `${km} km remaining`);
  }
  if (status.daysRemaining !== null) {
    const days = Math.ceil(Math.abs(status.daysRemaining));
    parts.push(status.daysRemaining <= 0 ? `${days} days past due` : `${days} days remaining`);
  }
  return parts.length ? `${prefix} (${parts.join(", ")}).` : `${prefix}.`;
}

async function buildAlerts(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  now: number,
  timeZone: string | null,
) {
  const [vehicleRows, insights, connection] = await Promise.all([
    buildVehicleRows(ctx, companyId, now),
    buildFuelInsights(ctx, companyId, timeZone, now),
    ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .unique(),
  ]);

  type Alert = {
    key: string;
    kind:
      | "service_overdue"
      | "service_due_soon"
      | "fuel_anomaly"
      | "fuel_spend_spike"
      | "tracker_sync_failing"
      | "vehicle_missing";
    severity: "critical" | "warning";
    title: string;
    message: string;
    vehicleId: Id<"fleetVehicles"> | null;
    entryId: Id<"fleetFuelEntries"> | null;
    at: number | null;
  };
  const alerts: Alert[] = [];

  if (connection) {
    const lastSuccess = connection.lastSyncAt ?? connection.connectedAt;
    if (now - lastSuccess > TRACKER_STALE_MS) {
      alerts.push({
        key: `tracker_sync:${companyId}`,
        kind: "tracker_sync_failing",
        severity: "critical",
        title: "Tracker sync is failing",
        message: connection.lastSyncError ?? "No successful sync in the last hour.",
        vehicleId: null,
        entryId: null,
        at: lastSuccess,
      });
    }
  }

  for (const vehicle of vehicleRows.vehicles) {
    if (vehicle.serviceStatus.status === "overdue") {
      alerts.push({
        key: `service_overdue:${vehicle._id}`,
        kind: "service_overdue",
        severity: "critical",
        title: `Service overdue: ${vehicle.name}`,
        message: alertServiceMessage("Service is overdue", vehicle.serviceStatus),
        vehicleId: vehicle._id,
        entryId: null,
        at: vehicle.serviceStatus.nextDueAt,
      });
    } else if (vehicle.serviceStatus.status === "due_soon") {
      alerts.push({
        key: `service_due_soon:${vehicle._id}`,
        kind: "service_due_soon",
        severity: "warning",
        title: `Service due soon: ${vehicle.name}`,
        message: alertServiceMessage("Service is due soon", vehicle.serviceStatus),
        vehicleId: vehicle._id,
        entryId: null,
        at: vehicle.serviceStatus.nextDueAt,
      });
    }
    if (vehicle.status === "missing") {
      alerts.push({
        key: `vehicle_missing:${vehicle._id}`,
        kind: "vehicle_missing",
        severity: "warning",
        title: `Missing from tracker: ${vehicle.name}`,
        message: "This vehicle has not appeared in the tracker's latest response.",
        vehicleId: vehicle._id,
        entryId: null,
        at: vehicle.missingFromTrackerAt,
      });
    }
  }

  for (const anomaly of insights.anomalies) {
    alerts.push({
      key: `fuel_anomaly:${anomaly.entryId}`,
      kind: "fuel_anomaly",
      severity: "warning",
      title: `Low fuel efficiency: ${anomaly.vehicleName}`,
      message: `${anomaly.kmPerL.toFixed(1)} km/L is well below the recent median of ${anomaly.medianKmPerL.toFixed(1)} km/L.`,
      vehicleId: anomaly.vehicleId,
      entryId: anomaly.entryId,
      at: anomaly.filledAt,
    });
  }

  let perVehicleSpikes = 0;
  for (const spend of insights.byVehicle) {
    if (!spend.spendSpike) continue;
    perVehicleSpikes += 1;
    alerts.push({
      key: `fuel_spend_spike:${spend.vehicleId}`,
      kind: "fuel_spend_spike",
      severity: "warning",
      title: `Fuel spend is up: ${spend.name}`,
      message: `This month's spend is above 130% of the previous three-month average.`,
      vehicleId: spend.vehicleId,
      entryId: null,
      at: null,
    });
  }
  if (perVehicleSpikes === 0 && insights.fleet.spendSpike) {
    alerts.push({
      key: `fuel_spend_spike:fleet:${companyId}`,
      kind: "fuel_spend_spike",
      severity: "warning",
      title: "Fleet fuel spend is up",
      message: "This month's fleet spend is above 130% of the previous three-month average.",
      vehicleId: null,
      entryId: null,
      at: null,
    });
  }

  const severityRank = { critical: 0, warning: 1 } as const;
  alerts.sort((a, b) => {
    const rank = severityRank[a.severity] - severityRank[b.severity];
    if (rank !== 0) return rank;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.title.localeCompare(b.title);
  });
  const truncated = alerts.length > MAX_ALERTS;
  return {
    alerts: alerts.slice(0, MAX_ALERTS),
    count: Math.min(alerts.length, MAX_ALERTS),
    isTruncated: truncated || vehicleRows.isTruncated || insights.isTruncated,
  };
}

// ---------------------------------------------------------------------------
// Tracker connection
// ---------------------------------------------------------------------------

export const getConnection = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    const vehicles = await loadCompanyVehicles(ctx, args.companyId);
    // Deliberately enumerated: the secret key must never cross this boundary.
    return {
      connected: Boolean(connection),
      keyHint: connection?.keyHint ?? null,
      connectedAt: connection?.connectedAt ?? null,
      lastSyncAt: connection?.lastSyncAt ?? null,
      lastSyncError: connection?.lastSyncError ?? null,
      vehicleCount: vehicles.rows.length,
      isTruncated: vehicles.isTruncated,
    };
  },
});

export const connect = action({
  args: { companyId: v.id("companies"), secretKey: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ connected: true; keyHint: string; vehicleCount: number; syncedAt: number }> => {
    const auth: { membershipId: Id<"companyMemberships"> } = await ctx.runQuery(
      internal.fleetAuth.requireManage,
      { companyId: args.companyId },
    );
    const secretKey = args.secretKey.trim();
    if (!secretKey) throw new ConvexError("Enter the tracker key.");

    let vehicles: TrackerVehicle[];
    try {
      vehicles = (await fetchTrackerVehicles(secretKey)).vehicles;
    } catch (error) {
      // A rejected or unreachable key saves nothing and never echoes the key.
      throw new ConvexError(trackerSafeMessage(error));
    }

    const now = Date.now();
    const saved: { keyHint: string; vehicleCount: number } = await ctx.runMutation(
      internal.fleetInternal.saveConnectionAndSync,
      {
        companyId: args.companyId,
        secretKey,
        keyHint: trackerKeyHint(secretKey),
        connectedByMembershipId: auth.membershipId,
        now,
        vehicles,
      },
    );
    return {
      connected: true,
      keyHint: saved.keyHint,
      vehicleCount: saved.vehicleCount,
      syncedAt: now,
    };
  },
});

export const disconnect = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    if (connection) await ctx.db.delete(connection._id);
    return null;
  },
});

export const syncNow = action({
  args: { companyId: v.id("companies") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    skipped: boolean;
    syncedAt: number | null;
    vehicleCount: number | null;
    missingCount: number | null;
  }> => {
    await ctx.runQuery(internal.fleetAuth.requireView, { companyId: args.companyId });
    const source: {
      connection: { secretKey: string; lastSyncAt: number | null; connectedAt: number } | null;
    } = await ctx.runQuery(internal.fleetInternal.getSyncSource, {
      companyId: args.companyId,
    });
    if (!source.connection) throw new ConvexError("Connect the tracker first.");

    const now = Date.now();
    if (source.connection.lastSyncAt !== null && now - source.connection.lastSyncAt < SYNC_NOW_COOLDOWN_MS) {
      return {
        skipped: true,
        syncedAt: source.connection.lastSyncAt,
        vehicleCount: null,
        missingCount: null,
      };
    }

    const result = await fetchAndApplyCompanyVehicles(ctx, args.companyId);
    if (!result.ok) throw new ConvexError(result.error ?? "Could not reach the tracker.");
    return {
      skipped: false,
      syncedAt: result.lastSyncAt,
      vehicleCount: result.vehicleCount,
      missingCount: result.counts?.missing ?? 0,
    };
  },
});

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const listVehicles = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    return await buildVehicleRows(ctx, args.companyId, args.now);
  },
});

export const getVehicle = query({
  args: { companyId: v.id("companies"), vehicleId: v.id("fleetVehicles"), now: v.number() },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const vehicle = await requireFleetVehicle(ctx, args.companyId, args.vehicleId);

    const openTrip = await ctx.db
      .query("fleetTrips")
      .withIndex("by_vehicleId_and_status", (q) =>
        q.eq("vehicleId", args.vehicleId).eq("status", "open"),
      )
      .first();
    const driverNames = new Map<Id<"fleetDrivers">, string>();
    const driverName = openTrip ? await driverNameFor(ctx, openTrip.driverId, driverNames) : null;

    const recentServices = await ctx.db
      .query("fleetServiceEntries")
      .withIndex("by_vehicleId_and_servicedAt", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(10);
    const serviceStatus = computeServiceStatus({
      serviceIntervalKm: vehicle.serviceIntervalKm ?? null,
      serviceIntervalDays: vehicle.serviceIntervalDays ?? null,
      lastService: recentServices[0] ?? null,
      currentOdometerMeters: vehicle.odometerMeters ?? null,
      now: args.now,
    });

    const tripDocs = await ctx.db
      .query("fleetTrips")
      .withIndex("by_vehicleId_and_departedAt", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(10);

    const fuelDocs = await ctx.db
      .query("fleetFuelEntries")
      .withIndex("by_vehicleId_and_filledAt", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(20);
    const fuelPoints = computeFuelSeries(
      [...fuelDocs]
        .reverse()
        .map((fill) => ({
          id: fill._id,
          filledAt: fill.filledAt,
          litres: fill.litres,
          amount: fill.amount,
          odometerMeters: fill.odometerMeters ?? null,
        })),
    );
    const fuelPointById = new Map(fuelPoints.map((point) => [point.id, point]));

    const trips = [];
    for (const trip of tripDocs) {
      const driver = await ctx.db.get(trip.driverId);
      const distanceMeters =
        trip.startOdometerMeters !== undefined &&
        trip.endOdometerMeters !== undefined &&
        trip.endOdometerMeters >= trip.startOdometerMeters
          ? trip.endOdometerMeters - trip.startOdometerMeters
          : null;
      trips.push({
        _id: trip._id,
        destination: trip.destination,
        notes: trip.notes ?? null,
        status: trip.status,
        departedAt: trip.departedAt,
        returnedAt: trip.returnedAt ?? null,
        startOdometerMeters: trip.startOdometerMeters ?? null,
        endOdometerMeters: trip.endOdometerMeters ?? null,
        distanceMeters,
        distanceKm: metersToKm(distanceMeters),
        driverId: trip.driverId,
        driverName: driver?.name ?? null,
      });
    }

    const fuelEntries = [];
    for (const fill of fuelDocs.slice(0, 10)) {
      const driver = fill.driverId ? await ctx.db.get(fill.driverId) : null;
      const metrics = fuelPointById.get(fill._id);
      fuelEntries.push({
        _id: fill._id,
        filledAt: fill.filledAt,
        litres: fill.litres,
        amount: fill.amount,
        odometerMeters: fill.odometerMeters ?? null,
        odometerKm: metersToKm(fill.odometerMeters),
        notes: fill.notes ?? null,
        driverId: fill.driverId ?? null,
        driverName: driver?.name ?? null,
        kmPerL: metrics?.kmPerL ?? null,
        medianKmPerL: metrics?.medianKmPerL ?? null,
        anomaly: metrics?.anomaly ?? false,
        photo: {
          fileName: fill.photoFileName,
          contentType: fill.photoContentType,
          size: fill.photoSize,
          url: await ctx.storage.getUrl(fill.photoStorageId),
        },
      });
    }

    const services = [];
    for (const service of recentServices) {
      services.push({
        _id: service._id,
        servicedAt: service.servicedAt,
        odometerMeters: service.odometerMeters ?? null,
        odometerKm: metersToKm(service.odometerMeters),
        description: service.description,
        cost: service.cost ?? null,
        notes: service.notes ?? null,
        photo: service.photoStorageId
          ? {
              fileName: service.photoFileName ?? null,
              contentType: service.photoContentType ?? null,
              size: service.photoSize ?? null,
              url: await ctx.storage.getUrl(service.photoStorageId),
            }
          : null,
      });
    }

    return {
      vehicle: publicVehicle(vehicle, openTrip, driverName, serviceStatus),
      recentTrips: trips,
      recentFuel: fuelEntries,
      recentServices: services,
    };
  },
});

export const renameVehicle = mutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    displayName: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const vehicle = await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    const displayName = args.displayName.trim();
    if (displayName.length > 100) throw new ConvexError("Vehicle name is too long.");
    if ((vehicle.displayName ?? "") === displayName) return null;
    await ctx.db.patch(vehicle._id, {
      displayName: displayName || undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setServiceInterval = mutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    serviceIntervalKm: v.union(v.number(), v.null()),
    serviceIntervalDays: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const vehicle = await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    if (args.serviceIntervalKm !== null) {
      if (!Number.isFinite(args.serviceIntervalKm) || args.serviceIntervalKm <= 0 || args.serviceIntervalKm > 1_000_000) {
        throw new ConvexError("Service distance must be between 1 and 1,000,000 km.");
      }
    }
    if (args.serviceIntervalDays !== null) {
      if (!Number.isInteger(args.serviceIntervalDays) || args.serviceIntervalDays <= 0 || args.serviceIntervalDays > 3_650) {
        throw new ConvexError("Service interval must be between 1 and 3,650 days.");
      }
    }
    await ctx.db.patch(vehicle._id, {
      serviceIntervalKm: args.serviceIntervalKm ?? undefined,
      serviceIntervalDays: args.serviceIntervalDays ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export const listDrivers = query({
  args: { companyId: v.id("companies"), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const result = await takeWithOverflow(
      (limit) =>
        args.includeInactive
          ? ctx.db
              .query("fleetDrivers")
              .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
              .take(limit)
          : ctx.db
              .query("fleetDrivers")
              .withIndex("by_companyId_and_active", (q) =>
                q.eq("companyId", args.companyId).eq("active", true),
              )
              .take(limit),
      MAX_FLEET_DRIVERS,
    );
    return {
      drivers: result.rows.map((driver) => ({
        _id: driver._id,
        name: driver.name,
        phone: driver.phone ?? null,
        active: driver.active,
        createdAt: driver.createdAt,
        updatedAt: driver.updatedAt,
      })),
      isTruncated: result.isTruncated,
    };
  },
});

export const createDriver = mutation({
  args: { companyId: v.id("companies"), name: v.string(), phone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const name = nonEmpty(args.name, "Driver name");
    if (name.length > MAX_DRIVER_NAME) throw new ConvexError("Driver name is too long.");
    const phone = args.phone?.trim() || undefined;
    const now = Date.now();
    return await ctx.db.insert("fleetDrivers", {
      companyId: args.companyId,
      name,
      ...(phone ? { phone } : {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateDriver = mutation({
  args: {
    companyId: v.id("companies"),
    driverId: v.id("fleetDrivers"),
    name: v.optional(v.string()),
    phone: v.optional(v.union(v.string(), v.null())),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const driver = await requireFleetDriver(ctx, args.companyId, args.driverId);
    const patch: Partial<Doc<"fleetDrivers">> = {};
    if (args.name !== undefined) {
      const name = nonEmpty(args.name, "Driver name");
      if (name.length > MAX_DRIVER_NAME) throw new ConvexError("Driver name is too long.");
      patch.name = name;
    }
    if (args.phone !== undefined) {
      const phone = args.phone?.trim();
      patch.phone = phone || undefined;
    }
    if (args.active !== undefined) patch.active = args.active;
    if (Object.keys(patch).length === 0) return null;
    patch.updatedAt = Date.now();
    await ctx.db.patch(driver._id, patch);
    return null;
  },
});

export const deactivateDriver = mutation({
  args: { companyId: v.id("companies"), driverId: v.id("fleetDrivers") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const driver = await requireFleetDriver(ctx, args.companyId, args.driverId);
    if (!driver.active) return null;
    await ctx.db.patch(driver._id, { active: false, updatedAt: Date.now() });
    return null;
  },
});

export const deleteDriver = mutation({
  args: { companyId: v.id("companies"), driverId: v.id("fleetDrivers") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const driver = await requireFleetDriver(ctx, args.companyId, args.driverId);
    const [trip, fuel] = await Promise.all([
      ctx.db
        .query("fleetTrips")
        .withIndex("by_driverId_and_status", (q) => q.eq("driverId", driver._id))
        .first(),
      ctx.db
        .query("fleetFuelEntries")
        .withIndex("by_driverId", (q) => q.eq("driverId", driver._id))
        .first(),
    ]);
    if (trip || fuel) throw new ConvexError("This driver has history. Deactivate them instead.");
    await ctx.db.delete(driver._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export const startTrip = action({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    driverId: v.id("fleetDrivers"),
    destination: v.string(),
    notes: v.optional(v.string()),
    departedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tripId: Id<"fleetTrips">; startOdometerMeters: number | null }> => {
    const auth: { membershipId: Id<"companyMemberships"> } = await ctx.runQuery(
      internal.fleetAuth.requireLog,
      { companyId: args.companyId },
    );
    // A fresh reading improves the start odometer, but trip logging must never
    // be blocked by the tracker or the office network.
    try {
      await fetchAndApplyCompanyVehicles(ctx, args.companyId);
    } catch {
      // Fall back to the last synced reading.
    }
    return await ctx.runMutation(internal.fleetInternal.applyStartTrip, {
      companyId: args.companyId,
      membershipId: auth.membershipId,
      vehicleId: args.vehicleId,
      driverId: args.driverId,
      destination: args.destination,
      notes: args.notes,
      departedAt: args.departedAt,
      now: Date.now(),
    });
  },
});

export const returnTrip = action({
  args: {
    companyId: v.id("companies"),
    tripId: v.id("fleetTrips"),
    returnedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tripId: Id<"fleetTrips">;
    returnedAt: number | null;
    endOdometerMeters: number | null;
    alreadyReturned: boolean;
  }> => {
    await ctx.runQuery(internal.fleetAuth.requireLog, { companyId: args.companyId });
    try {
      await fetchAndApplyCompanyVehicles(ctx, args.companyId);
    } catch {
      // Fall back to the last synced reading.
    }
    return await ctx.runMutation(internal.fleetInternal.applyReturnTrip, {
      companyId: args.companyId,
      tripId: args.tripId,
      returnedAt: args.returnedAt,
      now: Date.now(),
    });
  },
});

async function tripPublicRow(
  ctx: QueryCtx,
  trip: Doc<"fleetTrips">,
  vehicleCache: Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>,
  driverCache: Map<Id<"fleetDrivers">, Doc<"fleetDrivers"> | null>,
) {
  let vehicle = vehicleCache.get(trip.vehicleId);
  if (vehicle === undefined) {
    vehicle = await ctx.db.get(trip.vehicleId);
    vehicleCache.set(trip.vehicleId, vehicle);
  }
  let driver = driverCache.get(trip.driverId);
  if (driver === undefined) {
    driver = await ctx.db.get(trip.driverId);
    driverCache.set(trip.driverId, driver);
  }
  const distanceMeters =
    trip.startOdometerMeters !== undefined &&
    trip.endOdometerMeters !== undefined &&
    trip.endOdometerMeters >= trip.startOdometerMeters
      ? trip.endOdometerMeters - trip.startOdometerMeters
      : null;
  return {
    _id: trip._id,
    vehicleId: trip.vehicleId,
    driverId: trip.driverId,
    destination: trip.destination,
    notes: trip.notes ?? null,
    status: trip.status,
    departedAt: trip.departedAt,
    returnedAt: trip.returnedAt ?? null,
    startOdometerMeters: trip.startOdometerMeters ?? null,
    endOdometerMeters: trip.endOdometerMeters ?? null,
    distanceMeters,
    distanceKm: metersToKm(distanceMeters),
    vehicle: vehicle
      ? {
          _id: vehicle._id,
          registrationNumber: vehicle.registrationNumber,
          displayName: vehicle.displayName ?? null,
          name: vehicle.displayName?.trim() || vehicle.registrationNumber,
        }
      : null,
    driver: driver ? { _id: driver._id, name: driver.name } : null,
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
  };
}

export const listTrips = query({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.optional(v.id("fleetVehicles")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    if (args.vehicleId) await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    const page = await (
      args.vehicleId
        ? ctx.db
            .query("fleetTrips")
            .withIndex("by_vehicleId_and_departedAt", (q) => q.eq("vehicleId", args.vehicleId!))
        : ctx.db
            .query("fleetTrips")
            .withIndex("by_companyId_and_departedAt", (q) => q.eq("companyId", args.companyId))
    )
      .order("desc")
      .paginate(args.paginationOpts);
    const vehicleCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
    const driverCache = new Map<Id<"fleetDrivers">, Doc<"fleetDrivers"> | null>();
    return {
      ...page,
      page: await Promise.all(
        page.page.map((trip) => tripPublicRow(ctx, trip, vehicleCache, driverCache)),
      ),
    };
  },
});

export const listOpenTrips = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const result = await loadOpenTrips(ctx, args.companyId);
    const vehicleCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
    const driverCache = new Map<Id<"fleetDrivers">, Doc<"fleetDrivers"> | null>();
    return {
      trips: await Promise.all(
        result.rows.map((trip) => tripPublicRow(ctx, trip, vehicleCache, driverCache)),
      ),
      isTruncated: result.isTruncated,
    };
  },
});

export const updateTrip = mutation({
  args: {
    companyId: v.id("companies"),
    tripId: v.id("fleetTrips"),
    destination: v.optional(v.string()),
    notes: v.optional(v.union(v.string(), v.null())),
    driverId: v.optional(v.id("fleetDrivers")),
    departedAt: v.optional(v.number()),
    returnedAt: v.optional(v.union(v.number(), v.null())),
    startOdometerMeters: v.optional(v.union(v.number(), v.null())),
    endOdometerMeters: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const trip = await requireFleetTrip(ctx, args.companyId, args.tripId);

    const nextVehicleId = trip.vehicleId;
    const nextDriverId = args.driverId ?? trip.driverId;
    if (args.driverId) await requireFleetDriver(ctx, args.companyId, args.driverId);

    const nextDepartedAt = args.departedAt ?? trip.departedAt;
    validateDate(nextDepartedAt, "Departure time");
    const nextReturnedAt =
      args.returnedAt === undefined ? trip.returnedAt ?? null : args.returnedAt;
    if (nextReturnedAt !== null) {
      validateDate(nextReturnedAt, "Return time");
      if (nextReturnedAt < nextDepartedAt) {
        throw new ConvexError("Return time cannot be before departure.");
      }
    }
    const nextStatus = nextReturnedAt === null ? "open" : "returned";

    if (nextStatus === "open") {
      const openVehicleTrips = await ctx.db
        .query("fleetTrips")
        .withIndex("by_vehicleId_and_status", (q) =>
          q.eq("vehicleId", nextVehicleId).eq("status", "open"),
        )
        .take(2);
      if (openVehicleTrips.some((row) => row._id !== trip._id)) {
        throw new ConvexError("This vehicle already has an open trip.");
      }
      const openDriverTrips = await ctx.db
        .query("fleetTrips")
        .withIndex("by_driverId_and_status", (q) =>
          q.eq("driverId", nextDriverId).eq("status", "open"),
        )
        .take(2);
      if (openDriverTrips.some((row) => row._id !== trip._id)) {
        throw new ConvexError("This driver is already on a trip.");
      }
    }

    const patch: Partial<Doc<"fleetTrips">> = {
      driverId: nextDriverId,
      departedAt: nextDepartedAt,
      status: nextStatus,
      returnedAt: nextReturnedAt ?? undefined,
      updatedAt: Date.now(),
    };
    if (args.destination !== undefined) {
      const destination = nonEmpty(args.destination, "Destination");
      if (destination.length > MAX_DESTINATION) throw new ConvexError("Destination is too long.");
      patch.destination = destination;
    }
    if (args.notes !== undefined) {
      patch.notes = args.notes?.trim() || undefined;
    }
    if (args.startOdometerMeters !== undefined) {
      patch.startOdometerMeters =
        validateOdometer(args.startOdometerMeters, "Start odometer") ?? undefined;
    }
    if (args.endOdometerMeters !== undefined) {
      patch.endOdometerMeters =
        validateOdometer(args.endOdometerMeters, "End odometer") ?? undefined;
    } else if (trip.status === "returned" && nextStatus === "open") {
      // Reopening a trip makes the old end reading meaningless.
      patch.endOdometerMeters = undefined;
    }

    await ctx.db.patch(trip._id, patch);
    return null;
  },
});

export const deleteTrip = mutation({
  args: { companyId: v.id("companies"), tripId: v.id("fleetTrips") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const trip = await requireFleetTrip(ctx, args.companyId, args.tripId);
    await ctx.db.delete(trip._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------

export const createFuelEntry = mutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    driverId: v.optional(v.id("fleetDrivers")),
    filledAt: v.number(),
    litres: v.number(),
    amount: v.number(),
    odometerMeters: v.optional(v.number()),
    notes: v.optional(v.string()),
    photo: photoInputValidator,
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:log");
    const vehicle = await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    if (args.driverId) await requireFleetDriver(ctx, args.companyId, args.driverId);
    validateDate(args.filledAt, "Fill-up date");
    if (!Number.isFinite(args.litres) || args.litres <= 0) {
      throw new ConvexError("Litres must be greater than zero.");
    }
    validateMoney(args.amount, "Amount");
    const odometerMeters =
      validateOdometer(args.odometerMeters, "Odometer") ?? vehicle.odometerMeters ?? null;
    const photo = await validatePhotoClaim(ctx, {
      companyId: args.companyId,
      membershipId: membership._id,
      photo: args.photo,
    });
    const now = Date.now();
    const entryId = await ctx.db.insert("fleetFuelEntries", {
      companyId: args.companyId,
      vehicleId: args.vehicleId,
      ...(args.driverId ? { driverId: args.driverId } : {}),
      filledAt: args.filledAt,
      litres: args.litres,
      amount: args.amount,
      ...(odometerMeters !== null ? { odometerMeters } : {}),
      ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
      photoStorageId: photo.photoStorageId,
      photoFileName: photo.photoFileName,
      photoContentType: photo.photoContentType,
      photoSize: photo.photoSize,
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.delete(photo.claimId);
    return entryId;
  },
});

async function fuelMetricsForEntry(ctx: QueryCtx, entry: Doc<"fleetFuelEntries">) {
  const prior = await ctx.db
    .query("fleetFuelEntries")
    .withIndex("by_vehicleId_and_filledAt", (q) =>
      q.eq("vehicleId", entry.vehicleId).lt("filledAt", entry.filledAt),
    )
    .order("desc")
    .take(6);
  const points = computeFuelSeries(
    [...prior]
      .reverse()
      .concat(entry)
      .map((fill) => ({
        id: fill._id,
        filledAt: fill.filledAt,
        litres: fill.litres,
        amount: fill.amount,
        odometerMeters: fill.odometerMeters ?? null,
      })),
  );
  return points[points.length - 1];
}

export const listFuelEntries = query({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.optional(v.id("fleetVehicles")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    if (args.vehicleId) await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    const page = await (
      args.vehicleId
        ? ctx.db
            .query("fleetFuelEntries")
            .withIndex("by_vehicleId_and_filledAt", (q) => q.eq("vehicleId", args.vehicleId!))
        : ctx.db
            .query("fleetFuelEntries")
            .withIndex("by_companyId_and_filledAt", (q) => q.eq("companyId", args.companyId))
    )
      .order("desc")
      .paginate(args.paginationOpts);

    const vehicleCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
    const driverCache = new Map<Id<"fleetDrivers">, Doc<"fleetDrivers"> | null>();
    const rows = [];
    for (const entry of page.page) {
      let vehicle = vehicleCache.get(entry.vehicleId);
      if (vehicle === undefined) {
        vehicle = await ctx.db.get(entry.vehicleId);
        vehicleCache.set(entry.vehicleId, vehicle);
      }
      let driver: Doc<"fleetDrivers"> | null = null;
      if (entry.driverId) {
        if (driverCache.has(entry.driverId)) {
          driver = driverCache.get(entry.driverId) ?? null;
        } else {
          driver = await ctx.db.get(entry.driverId);
          driverCache.set(entry.driverId, driver);
        }
      }
      const metrics = await fuelMetricsForEntry(ctx, entry);
      rows.push({
        _id: entry._id,
        vehicleId: entry.vehicleId,
        vehicle: vehicle
          ? {
              _id: vehicle._id,
              registrationNumber: vehicle.registrationNumber,
              displayName: vehicle.displayName ?? null,
              name: vehicle.displayName?.trim() || vehicle.registrationNumber,
            }
          : null,
        driverId: entry.driverId ?? null,
        driver: driver ? { _id: driver._id, name: driver.name } : null,
        filledAt: entry.filledAt,
        litres: entry.litres,
        amount: entry.amount,
        odometerMeters: entry.odometerMeters ?? null,
        odometerKm: metersToKm(entry.odometerMeters),
        notes: entry.notes ?? null,
        kmPerL: metrics.kmPerL,
        medianKmPerL: metrics.medianKmPerL,
        anomaly: metrics.anomaly,
        photo: {
          fileName: entry.photoFileName,
          contentType: entry.photoContentType,
          size: entry.photoSize,
          url: await ctx.storage.getUrl(entry.photoStorageId),
        },
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return { ...page, page: rows };
  },
});

export const updateFuelEntry = mutation({
  args: {
    companyId: v.id("companies"),
    entryId: v.id("fleetFuelEntries"),
    driverId: v.optional(v.union(v.id("fleetDrivers"), v.null())),
    filledAt: v.optional(v.number()),
    litres: v.optional(v.number()),
    amount: v.optional(v.number()),
    odometerMeters: v.optional(v.union(v.number(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    photo: v.optional(photoInputValidator),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:manage");
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.companyId !== args.companyId) throw new ConvexError("Fuel entry not found.");
    if (args.driverId) await requireFleetDriver(ctx, args.companyId, args.driverId);

    const patch: Partial<Doc<"fleetFuelEntries">> = {};
    if (args.driverId !== undefined) patch.driverId = args.driverId ?? undefined;
    if (args.filledAt !== undefined) patch.filledAt = validateDate(args.filledAt, "Fill-up date");
    if (args.litres !== undefined) {
      if (!Number.isFinite(args.litres) || args.litres <= 0) {
        throw new ConvexError("Litres must be greater than zero.");
      }
      patch.litres = args.litres;
    }
    if (args.amount !== undefined) patch.amount = validateMoney(args.amount, "Amount");
    if (args.odometerMeters !== undefined) {
      patch.odometerMeters =
        validateOdometer(args.odometerMeters, "Odometer") ?? undefined;
    }
    if (args.notes !== undefined) patch.notes = args.notes?.trim() || undefined;

    let newPhoto: Awaited<ReturnType<typeof validatePhotoClaim>> | null = null;
    if (args.photo) {
      newPhoto = await validatePhotoClaim(ctx, {
        companyId: args.companyId,
        membershipId: membership._id,
        photo: args.photo,
      });
      patch.photoStorageId = newPhoto.photoStorageId;
      patch.photoFileName = newPhoto.photoFileName;
      patch.photoContentType = newPhoto.photoContentType;
      patch.photoSize = newPhoto.photoSize;
    }

    if (Object.keys(patch).length === 0) return null;
    patch.updatedAt = Date.now();
    const oldStorageId = entry.photoStorageId;
    await ctx.db.patch(entry._id, patch);

    if (newPhoto) {
      await ctx.db.delete(newPhoto.claimId);
      if (oldStorageId !== newPhoto.photoStorageId) {
        if (!(await isFleetBlobReferenced(ctx, oldStorageId))) {
          await ctx.storage.delete(oldStorageId);
        }
      }
    }
    return null;
  },
});

export const deleteFuelEntry = mutation({
  args: { companyId: v.id("companies"), entryId: v.id("fleetFuelEntries") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.companyId !== args.companyId) throw new ConvexError("Fuel entry not found.");
    const storageId = entry.photoStorageId;
    await ctx.db.delete(entry._id);
    if (!(await isFleetBlobReferenced(ctx, storageId))) await ctx.storage.delete(storageId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const createServiceEntry = mutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    servicedAt: v.number(),
    odometerMeters: v.optional(v.number()),
    description: v.string(),
    cost: v.optional(v.number()),
    notes: v.optional(v.string()),
    photo: v.optional(photoInputValidator),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:log");
    const vehicle = await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    validateDate(args.servicedAt, "Service date");
    const description = nonEmpty(args.description, "Description");
    if (description.length > MAX_SERVICE_DESCRIPTION) {
      throw new ConvexError("Description is too long.");
    }
    if (args.cost !== undefined) validateMoney(args.cost, "Cost");
    const odometerMeters =
      validateOdometer(args.odometerMeters, "Odometer") ?? vehicle.odometerMeters ?? null;
    const photo = args.photo
      ? await validatePhotoClaim(ctx, {
          companyId: args.companyId,
          membershipId: membership._id,
          photo: args.photo,
        })
      : null;
    const now = Date.now();
    const entryId = await ctx.db.insert("fleetServiceEntries", {
      companyId: args.companyId,
      vehicleId: args.vehicleId,
      servicedAt: args.servicedAt,
      ...(odometerMeters !== null ? { odometerMeters } : {}),
      description,
      ...(args.cost !== undefined ? { cost: args.cost } : {}),
      ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
      ...(photo
        ? {
            photoStorageId: photo.photoStorageId,
            photoFileName: photo.photoFileName,
            photoContentType: photo.photoContentType,
            photoSize: photo.photoSize,
          }
        : {}),
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    });
    if (photo) await ctx.db.delete(photo.claimId);
    return entryId;
  },
});

export const listServiceEntries = query({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.optional(v.id("fleetVehicles")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    if (args.vehicleId) await requireFleetVehicle(ctx, args.companyId, args.vehicleId);
    const page = await (
      args.vehicleId
        ? ctx.db
            .query("fleetServiceEntries")
            .withIndex("by_vehicleId_and_servicedAt", (q) => q.eq("vehicleId", args.vehicleId!))
        : ctx.db
            .query("fleetServiceEntries")
            .withIndex("by_companyId_and_servicedAt", (q) => q.eq("companyId", args.companyId))
    )
      .order("desc")
      .paginate(args.paginationOpts);

    const vehicleCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
    const rows = [];
    for (const entry of page.page) {
      let vehicle = vehicleCache.get(entry.vehicleId);
      if (vehicle === undefined) {
        vehicle = await ctx.db.get(entry.vehicleId);
        vehicleCache.set(entry.vehicleId, vehicle);
      }
      rows.push({
        _id: entry._id,
        vehicleId: entry.vehicleId,
        vehicle: vehicle
          ? {
              _id: vehicle._id,
              registrationNumber: vehicle.registrationNumber,
              displayName: vehicle.displayName ?? null,
              name: vehicle.displayName?.trim() || vehicle.registrationNumber,
            }
          : null,
        servicedAt: entry.servicedAt,
        odometerMeters: entry.odometerMeters ?? null,
        odometerKm: metersToKm(entry.odometerMeters),
        description: entry.description,
        cost: entry.cost ?? null,
        notes: entry.notes ?? null,
        photo: entry.photoStorageId
          ? {
              fileName: entry.photoFileName ?? null,
              contentType: entry.photoContentType ?? null,
              size: entry.photoSize ?? null,
              url: await ctx.storage.getUrl(entry.photoStorageId),
            }
          : null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return { ...page, page: rows };
  },
});

export const updateServiceEntry = mutation({
  args: {
    companyId: v.id("companies"),
    entryId: v.id("fleetServiceEntries"),
    servicedAt: v.optional(v.number()),
    odometerMeters: v.optional(v.union(v.number(), v.null())),
    description: v.optional(v.string()),
    cost: v.optional(v.union(v.number(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    photo: v.optional(photoInputValidator),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:manage");
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.companyId !== args.companyId) {
      throw new ConvexError("Service entry not found.");
    }

    const patch: Partial<Doc<"fleetServiceEntries">> = {};
    if (args.servicedAt !== undefined) {
      patch.servicedAt = validateDate(args.servicedAt, "Service date");
    }
    if (args.odometerMeters !== undefined) {
      patch.odometerMeters =
        validateOdometer(args.odometerMeters, "Odometer") ?? undefined;
    }
    if (args.description !== undefined) {
      const description = nonEmpty(args.description, "Description");
      if (description.length > MAX_SERVICE_DESCRIPTION) {
        throw new ConvexError("Description is too long.");
      }
      patch.description = description;
    }
    if (args.cost !== undefined) {
      patch.cost = args.cost === null ? undefined : validateMoney(args.cost, "Cost");
    }
    if (args.notes !== undefined) patch.notes = args.notes?.trim() || undefined;

    let newPhoto: Awaited<ReturnType<typeof validatePhotoClaim>> | null = null;
    if (args.photo) {
      newPhoto = await validatePhotoClaim(ctx, {
        companyId: args.companyId,
        membershipId: membership._id,
        photo: args.photo,
      });
      patch.photoStorageId = newPhoto.photoStorageId;
      patch.photoFileName = newPhoto.photoFileName;
      patch.photoContentType = newPhoto.photoContentType;
      patch.photoSize = newPhoto.photoSize;
    }

    if (Object.keys(patch).length === 0) return null;
    patch.updatedAt = Date.now();
    const oldStorageId = entry.photoStorageId;
    await ctx.db.patch(entry._id, patch);

    if (newPhoto) {
      await ctx.db.delete(newPhoto.claimId);
      if (oldStorageId && oldStorageId !== newPhoto.photoStorageId) {
        if (!(await isFleetBlobReferenced(ctx, oldStorageId))) {
          await ctx.storage.delete(oldStorageId);
        }
      }
    }
    return null;
  },
});

export const deleteServiceEntry = mutation({
  args: { companyId: v.id("companies"), entryId: v.id("fleetServiceEntries") },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.companyId !== args.companyId) {
      throw new ConvexError("Service entry not found.");
    }
    const storageId = entry.photoStorageId;
    await ctx.db.delete(entry._id);
    if (storageId && !(await isFleetBlobReferenced(ctx, storageId))) {
      await ctx.storage.delete(storageId);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export const generateUploadUrl = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireFleetLogOrManage(ctx, args.companyId);
    const claimId = await ctx.db.insert("fleetUploadClaims", {
      companyId: args.companyId,
      membershipId: membership._id,
      createdAt: Date.now(),
    });
    return { url: await ctx.storage.generateUploadUrl(), claimId };
  },
});

/**
 * Binds the blob produced by the upload POST to its claim. The claim is bound
 * even when validation fails so the orphan sweep can reclaim the blob; callers
 * must check `ok` and may call `discardUpload` immediately.
 */
export const bindUploadClaim = mutation({
  args: {
    companyId: v.id("companies"),
    claimId: v.id("fleetUploadClaims"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireFleetLogOrManage(ctx, args.companyId);
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.companyId !== args.companyId || claim.membershipId !== membership._id) {
      throw new ConvexError("Photo upload claim not found.");
    }
    if (claim.storageId !== undefined && claim.storageId !== args.storageId) {
      throw new ConvexError("Upload claim is already bound to another file.");
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("Uploaded photo not found.");

    const [entryReference, boundClaim] = await Promise.all([
      isFleetEntryBlobReferenced(ctx, args.storageId),
      ctx.db
        .query("fleetUploadClaims")
        .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
        .first(),
    ]);
    if (claim.storageId === undefined) {
      await ctx.db.patch(claim._id, { storageId: args.storageId });
    }
    if (entryReference || (boundClaim && boundClaim._id !== claim._id)) {
      return { ok: false, error: "This photo is already attached." };
    }
    const contentType = (metadata.contentType ?? "").toLowerCase();
    if (!isAllowedPhotoContentType(contentType)) {
      return { ok: false, error: "Attach a JPEG, PNG, WebP, HEIC, or HEIF image." };
    }
    if ((metadata.size ?? 0) > MAX_FLEET_PHOTO_BYTES) {
      return { ok: false, error: "Photo must be 10 MB or smaller." };
    }
    return { ok: true, error: null };
  },
});

export const discardUpload = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("fleetUploadClaims") },
  handler: async (ctx, args) => {
    const { membership } = await requireFleetLogOrManage(ctx, args.companyId);
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.companyId !== args.companyId || claim.membershipId !== membership._id) {
      throw new ConvexError("Photo upload claim not found.");
    }
    const storageId = claim.storageId;
    await ctx.db.delete(claim._id);
    if (storageId && !(await isFleetBlobReferenced(ctx, storageId))) {
      await ctx.storage.delete(storageId);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export const maintenanceStatus = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    return await buildMaintenanceRows(ctx, args.companyId, args.now);
  },
});

export const fuelInsights = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    const { company } = await requireCapability(ctx, args.companyId, "fleet:view");
    return await buildFuelInsights(ctx, args.companyId, company.timeZone ?? null, args.now);
  },
});

export const alerts = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    const { company } = await requireCapability(ctx, args.companyId, "fleet:view");
    return await buildAlerts(ctx, args.companyId, args.now, company.timeZone ?? null);
  },
});
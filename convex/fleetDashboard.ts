import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireCapability } from "./permissions";
import { takeWithOverflow } from "./queryLimits";
import { buildVehicleRows } from "./fleet";
import { buildAlertsFeed } from "./fleetMonitoring";
import { loadCompanyPlaces } from "./fleetPlaces";
import {
  DAY_MS,
  findContainingPlace,
  OFF_ROUTE_CORRIDOR_METERS,
  MAX_TIMELINE_ALERTS,
  MAX_TIMELINE_LOGGED_TRIPS,
  MAX_TIMELINE_TRACKER_TRIPS,
} from "./fleetDetection";
import {
  currentJdCycle,
  nextJdCycleStart,
  previousJdCycleStart,
} from "./taskCycles";

const MAX_DAILY_TRACKER_TRIPS = 2_000;
const MAX_DESTINATION_TRIPS = 1_000;
const MAX_UPCOMING_SERVICE = 5;
const MAX_ATTENTION = 5;
const MAX_RECENT_ACTIVITY = 10;
const TRIPS_BY_DESTINATION_WINDOW_MS = 30 * DAY_MS;

function dayWindows(now: number, timeZone: string | null | undefined, count: number) {
  const today = currentJdCycle("daily", now, timeZone);
  const starts = [today.start];
  for (let index = 1; index < count; index += 1) {
    starts.push(previousJdCycleStart(starts[starts.length - 1], "daily", timeZone));
  }
  starts.reverse();
  return starts.map((start) => ({
    start,
    end: nextJdCycleStart(start, "daily", timeZone) - 1,
  }));
}

function bucketFor(windows: { start: number; end: number }[], at: number) {
  return windows.find((window) => at >= window.start && at <= window.end) ?? null;
}

async function vehicleName(
  ctx: QueryCtx,
  cache: Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>,
  vehicleId: Id<"fleetVehicles">,
) {
  let vehicle = cache.get(vehicleId);
  if (vehicle === undefined) {
    vehicle = await ctx.db.get(vehicleId);
    cache.set(vehicleId, vehicle);
  }
  return vehicle?.displayName?.trim() || vehicle?.registrationNumber || "Vehicle";
}

function odometerDistance(trip: Doc<"fleetTrips">) {
  if (
    trip.startOdometerMeters === undefined ||
    trip.endOdometerMeters === undefined ||
    trip.endOdometerMeters < trip.startOdometerMeters
  ) {
    return null;
  }
  return trip.endOdometerMeters - trip.startOdometerMeters;
}

/**
 * Fleet overview: KPIs, the live vehicle board, attention items and upcoming
 * service. Bounded reads only; fuel analytics live in `fleet.fuelInsights`.
 */
export const overview = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    const { company } = await requireCapability(ctx, args.companyId, "fleet:view");
    const timeZone = company.timeZone ?? null;
    const [vehicleRows, placesResult, feed] = await Promise.all([
      buildVehicleRows(ctx, args.companyId, args.now),
      loadCompanyPlaces(ctx, args.companyId, false),
      buildAlertsFeed(ctx, args.companyId, args.now, "open"),
    ]);

    const today = currentJdCycle("daily", args.now, timeZone);
    const trackerToday = await takeWithOverflow(
      (limit) =>
        ctx.db
          .query("fleetTrackerTrips")
          .withIndex("by_companyId_and_startAt", (q) =>
            q.eq("companyId", args.companyId)
              .gte("startedAt", today.start)
              .lte("startedAt", args.now),
          )
          .take(limit),
      MAX_DAILY_TRACKER_TRIPS,
    );
    const loggedToday = await takeWithOverflow(
      (limit) =>
        ctx.db
          .query("fleetTrips")
          .withIndex("by_companyId_and_departedAt", (q) =>
            q.eq("companyId", args.companyId)
              .gte("departedAt", today.start)
              .lte("departedAt", args.now),
          )
          .take(limit),
      500,
    );

    const places = placesResult.rows;
    const board = vehicleRows.vehicles.map((vehicle) => {
      const status = vehicle.offline
        ? ("offline" as const)
        : vehicle.openTrip
          ? ("on_trip" as const)
          : (vehicle.speed ?? 0) > 0
            ? ("moving" as const)
            : ("parked" as const);
      const place =
        vehicle.lat !== null && vehicle.lng !== null
          ? findContainingPlace({ lat: vehicle.lat, lng: vehicle.lng }, places)
          : null;
      return {
        _id: vehicle._id,
        registrationNumber: vehicle.registrationNumber,
        displayName: vehicle.displayName,
        name: vehicle.name,
        status,
        place: place
          ? { _id: place._id, name: place.name, kind: place.kind }
          : null,
        address: vehicle.address,
        driverName: vehicle.openTrip?.driverName ?? null,
        destination: vehicle.openTrip?.destination ?? null,
        placeId: vehicle.openTrip?.placeId ?? null,
        departedAt: vehicle.openTrip?.departedAt ?? null,
        arrivedAt: vehicle.openTrip?.arrivedAt ?? null,
        parkedSince: vehicle.ignitionChangedAt ?? vehicle.recordedAt ?? null,
        lastUpdate: vehicle.recordedAt,
        offlineSince: vehicle.offlineSince,
        requiresTripLogging: vehicle.requiresTripLogging,
        odometerKm: vehicle.odometerKm,
      };
    });

    const kpis = {
      onTrip: board.filter((vehicle) => vehicle.status === "on_trip").length,
      moving: board.filter((vehicle) => vehicle.status === "moving").length,
      parked: board.filter((vehicle) => vehicle.status === "parked").length,
      offline: board.filter((vehicle) => vehicle.status === "offline").length,
      kmToday:
        trackerToday.rows.reduce((sum, trip) => sum + trip.distanceMeters, 0) / 1000,
      tripsToday: loggedToday.rows.length,
      openAlerts: feed.openCount,
    };

    const upcomingService = vehicleRows.vehicles
      .filter(
        (vehicle) =>
          vehicle.serviceStatus.status === "overdue" ||
          vehicle.serviceStatus.status === "due_soon",
      )
      .map((vehicle) => ({
        vehicleId: vehicle._id,
        name: vehicle.name,
        registrationNumber: vehicle.registrationNumber,
        status: vehicle.serviceStatus.status,
        nextDueAt: vehicle.serviceStatus.nextDueAt,
        nextDueOdometerMeters: vehicle.serviceStatus.nextDueOdometerMeters,
        kmRemaining: vehicle.serviceStatus.kmRemaining,
        daysRemaining: vehicle.serviceStatus.daysRemaining,
      }))
      .sort((a, b) => {
        const statusRank = (status: string) => (status === "overdue" ? 0 : 1);
        const rank = statusRank(a.status) - statusRank(b.status);
        if (rank !== 0) return rank;
        return (a.kmRemaining ?? Infinity) - (b.kmRemaining ?? Infinity);
      })
      .slice(0, MAX_UPCOMING_SERVICE);

    return {
      kpis,
      attention: feed.alerts.slice(0, MAX_ATTENTION),
      vehicleBoard: board,
      upcomingService,
      isTruncated:
        vehicleRows.isTruncated ||
        placesResult.isTruncated ||
        feed.isTruncated ||
        trackerToday.isTruncated ||
        loggedToday.isTruncated,
    };
  },
});

/**
 * Trend panels: tracker km per local day, trips by destination, and a merged
 * recent-activity list.
 */
export const activity = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    const { company } = await requireCapability(ctx, args.companyId, "fleet:view");
    const timeZone = company.timeZone ?? null;
    const windows = dayWindows(args.now, timeZone, 7);

    const trackerTrips = await takeWithOverflow(
      (limit) =>
        ctx.db
          .query("fleetTrackerTrips")
          .withIndex("by_companyId_and_startAt", (q) =>
            q.eq("companyId", args.companyId).gte("startedAt", windows[0].start),
          )
          .take(limit),
      MAX_DAILY_TRACKER_TRIPS,
    );
    const kmLast7Days = windows.map((window) => {
      const trips = trackerTrips.rows.filter(
        (trip) => trip.startedAt >= window.start && trip.startedAt <= window.end,
      );
      return {
        dayStart: window.start,
        dayEnd: window.end,
        km: trips.reduce((sum, trip) => sum + trip.distanceMeters, 0) / 1000,
        trips: trips.length,
      };
    });

    const destinationTrips = await takeWithOverflow(
      (limit) =>
        ctx.db
          .query("fleetTrips")
          .withIndex("by_companyId_and_departedAt", (q) =>
            q.eq("companyId", args.companyId).gte(
              "departedAt",
              args.now - TRIPS_BY_DESTINATION_WINDOW_MS,
            ),
          )
          .take(limit),
      MAX_DESTINATION_TRIPS,
    );
    const byDestination = new Map<
      string,
      { destination: string; placeId: Id<"fleetPlaces"> | null; count: number; km: number }
    >();
    for (const trip of destinationTrips.rows) {
      const key = trip.placeId ? `place:${trip.placeId}` : `text:${trip.destination.trim().toLowerCase()}`;
      const entry = byDestination.get(key) ?? {
        destination: trip.destination,
        placeId: trip.placeId ?? null,
        count: 0,
        km: 0,
      };
      entry.count += 1;
      entry.km += (trip.actualDistanceMeters ?? odometerDistance(trip) ?? 0) / 1000;
      entry.destination = trip.destination;
      byDestination.set(key, entry);
    }
    const tripsByDestination = [...byDestination.values()].sort(
      (a, b) => b.count - a.count || b.km - a.km,
    );

    const [recentTrips, recentFuel, recentService, recentAlerts] = await Promise.all([
      ctx.db
        .query("fleetTrips")
        .withIndex("by_companyId_and_departedAt", (q) => q.eq("companyId", args.companyId))
        .order("desc")
        .take(8),
      ctx.db
        .query("fleetFuelEntries")
        .withIndex("by_companyId_and_filledAt", (q) => q.eq("companyId", args.companyId))
        .order("desc")
        .take(8),
      ctx.db
        .query("fleetServiceEntries")
        .withIndex("by_companyId_and_servicedAt", (q) => q.eq("companyId", args.companyId))
        .order("desc")
        .take(8),
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_companyId_and_occurredAt", (q) => q.eq("companyId", args.companyId))
        .order("desc")
        .take(8),
    ]);
    const nameCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
    type ActivityRow = {
      type: "trip_started" | "trip_returned" | "fuel" | "service" | "alert";
      at: number;
      title: string;
      vehicleId: Id<"fleetVehicles">;
      vehicleName: string;
      detail: string | null;
    };
    const activityRows: ActivityRow[] = [];
    for (const trip of recentTrips) {
      const name = await vehicleName(ctx, nameCache, trip.vehicleId);
      activityRows.push({
        type: trip.status === "open" ? "trip_started" : "trip_returned",
        at: trip.returnedAt ?? trip.departedAt,
        title: `${name} → ${trip.destination}`,
        vehicleId: trip.vehicleId,
        vehicleName: name,
        detail: trip.status,
      });
    }
    for (const fill of recentFuel) {
      const name = await vehicleName(ctx, nameCache, fill.vehicleId);
      activityRows.push({
        type: "fuel",
        at: fill.filledAt,
        title: `Fuel logged for ${name}`,
        vehicleId: fill.vehicleId,
        vehicleName: name,
        detail: `${fill.litres} L`,
      });
    }
    for (const service of recentService) {
      const name = await vehicleName(ctx, nameCache, service.vehicleId);
      activityRows.push({
        type: "service",
        at: service.servicedAt,
        title: `Service logged for ${name}`,
        vehicleId: service.vehicleId,
        vehicleName: name,
        detail: service.description,
      });
    }
    for (const alert of recentAlerts) {
      const name = await vehicleName(ctx, nameCache, alert.vehicleId);
      activityRows.push({
        type: "alert",
        at: alert.occurredAt,
        title: `${name}: ${alert.summary}`,
        vehicleId: alert.vehicleId,
        vehicleName: name,
        detail: alert.status,
      });
    }
    const recentActivity = activityRows
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RECENT_ACTIVITY);

    return {
      kmLast7Days,
      tripsByDestination,
      recentActivity,
      isTruncated: trackerTrips.isTruncated || destinationTrips.isTruncated,
    };
  },
});

/**
 * Day-by-day vehicle timeline: tracker trips with their matched logged trip,
 * logged trips that had no tracker segment, and stored alerts.
 */
export const vehicleTimeline = query({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    now: v.number(),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { company } = await requireCapability(ctx, args.companyId, "fleet:view");
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.companyId !== args.companyId) {
      throw new ConvexError("Vehicle not found.");
    }
    const dayCount = Math.min(31, Math.max(1, Math.round(args.days ?? 7)));
    const windows = dayWindows(args.now, company.timeZone ?? null, dayCount);
    const since = windows[0].start;

    const [trackerResult, loggedResult, alertResult] = await Promise.all([
      takeWithOverflow(
        (limit) =>
          ctx.db
            .query("fleetTrackerTrips")
            .withIndex("by_vehicleId_and_startAt", (q) =>
              q.eq("vehicleId", args.vehicleId).gte("startedAt", since),
            )
            .order("desc")
            .take(limit),
        MAX_TIMELINE_TRACKER_TRIPS,
      ),
      takeWithOverflow(
        (limit) =>
          ctx.db
            .query("fleetTrips")
            .withIndex("by_vehicleId_and_departedAt", (q) =>
              q.eq("vehicleId", args.vehicleId).gte("departedAt", since),
            )
            .order("desc")
            .take(limit),
        MAX_TIMELINE_LOGGED_TRIPS,
      ),
      takeWithOverflow(
        (limit) =>
          ctx.db
            .query("fleetAlerts")
            .withIndex("by_vehicleId_and_occurredAt", (q) =>
              q.eq("vehicleId", args.vehicleId).gte("occurredAt", since),
            )
            .order("desc")
            .take(limit),
        MAX_TIMELINE_ALERTS,
      ),
    ]);

    const loggedById = new Map(loggedResult.rows.map((trip) => [trip._id, trip]));
    const buckets = new Map<
      number,
      {
        dayStart: number;
        dayEnd: number;
        trackerTrips: unknown[];
        loggedTrips: unknown[];
        alerts: unknown[];
      }
    >();
    for (const window of windows) {
      buckets.set(window.start, {
        dayStart: window.start,
        dayEnd: window.end,
        trackerTrips: [],
        loggedTrips: [],
        alerts: [],
      });
    }

    const bucketForAt = (at: number) => {
      const window = bucketFor(windows, at);
      return window ? buckets.get(window.start) ?? null : null;
    };

    for (const trip of trackerResult.rows) {
      const bucket = bucketForAt(trip.startedAt);
      if (!bucket) continue;
      const match = trip.matchedTripId ? loggedById.get(trip.matchedTripId) ?? null : null;
      bucket.trackerTrips.push({
        _id: trip._id,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        startLandmark: trip.startLandmark ?? null,
        endLandmark: trip.endLandmark ?? null,
        startLat: trip.startLat ?? null,
        startLng: trip.startLng ?? null,
        endLat: trip.endLat ?? null,
        endLng: trip.endLng ?? null,
        distanceMeters: trip.distanceMeters,
        distanceKm: trip.distanceMeters / 1000,
        travelSeconds: trip.travelSeconds,
        maxSpeedKmh: trip.maxSpeedKmh,
        avgSpeedKmh: trip.avgSpeedKmh ?? null,
        matchedTripId: trip.matchedTripId ?? null,
        matchedTrip: match
          ? {
              destination: match.destination,
              status: match.status,
              departedAt: match.departedAt,
              returnedAt: match.returnedAt ?? null,
            }
          : null,
      });
    }

    for (const trip of loggedResult.rows) {
      const bucket = bucketForAt(trip.departedAt);
      if (!bucket) continue;
      bucket.loggedTrips.push({
        _id: trip._id,
        destination: trip.destination,
        placeId: trip.placeId ?? null,
        status: trip.status,
        departedAt: trip.departedAt,
        returnedAt: trip.returnedAt ?? null,
        arrivedAt: trip.arrivedAt ?? null,
        autoReturned: trip.autoReturned ?? false,
        actualDistanceMeters: trip.actualDistanceMeters ?? null,
        actualDistanceKm:
          trip.actualDistanceMeters !== undefined
            ? trip.actualDistanceMeters / 1000
            : null,
        offRoute:
          trip.maxDeviationMeters !== undefined &&
          trip.maxDeviationMeters > OFF_ROUTE_CORRIDOR_METERS,
        startOdometerMeters: trip.startOdometerMeters ?? null,
        endOdometerMeters: trip.endOdometerMeters ?? null,
        driverId: trip.driverId,
      });
    }

    for (const alert of alertResult.rows) {
      const bucket = bucketForAt(alert.occurredAt);
      if (!bucket) continue;
      bucket.alerts.push({
        _id: alert._id,
        kind: alert.kind,
        status: alert.status,
        occurredAt: alert.occurredAt,
        endedAt: alert.endedAt ?? null,
        summary: alert.summary,
        address: alert.address ?? null,
        distanceMeters: alert.distanceMeters ?? null,
        maxDeviationMeters: alert.maxDeviationMeters ?? null,
        tripId: alert.tripId ?? null,
        resolutionNote: alert.resolutionNote ?? null,
        resolvedAt: alert.resolvedAt ?? null,
      });
    }

    return {
      vehicle: {
        _id: vehicle._id,
        registrationNumber: vehicle.registrationNumber,
        displayName: vehicle.displayName ?? null,
        name: vehicle.displayName?.trim() || vehicle.registrationNumber,
        requiresTripLogging: vehicle.requiresTripLogging ?? true,
      },
      days: windows
        .slice()
        .reverse()
        .map((window) => buckets.get(window.start)!),
      isTruncated:
        trackerResult.isTruncated ||
        loggedResult.isTruncated ||
        alertResult.isTruncated,
    };
  },
});

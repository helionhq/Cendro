import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { requireCapability } from "./permissions";
import { requireFleetLogOrManage } from "./fleetAuth";
import {
  loadCompanyVehicles,
  loadOpenTrips,
  MAX_ALERTS,
  MAX_DESTINATION,
  resolveTripOverdueAlerts,
} from "./fleetInternal";
import { buildDerivedAlerts } from "./fleet";
import { loadCompanyPlaces } from "./fleetPlaces";
import {
  fetchTrackerTrips,
  fetchTrackerVehicleHistory,
  trackerHistoryPointValidator,
  trackerTripValidator,
  type TrackerHistoryPoint,
  type TrackerTrip,
} from "./fleetTracker";
import {
  groupConsecutiveTrips,
  INGEST_LOOKBACK_MS,
  INGEST_OVERLAP_MS,
  isInsideRadius,
  isParkedObservation,
  isTrackerTripCovered,
  MAX_HISTORY_FETCHES_PER_RUN,
  MAX_HISTORY_LOOKBACK_MS,
  MAX_HISTORY_POINTS,
  MAX_TRACKER_TRIPS_PER_RECONCILE,
  MAX_TRACKER_TRIPS_PER_VEHICLE_INGEST,
  maxCorridorDeviation,
  MIN_TRACKER_TRIP_DISTANCE_METERS,
  OFF_ROUTE_CORRIDOR_METERS,
  selectBasePlace,
  sumOverlappingDistance,
  TRIP_COVERAGE_BUFFER_MS,
  TRIP_OVERDUE_MS,
  UNLOGGED_GROUP_GAP_MS,
  UNLOGGED_LOOKBACK_MS,
  UNLOGGED_MIN_TRIP_DISTANCE_METERS,
  type LatLng,
} from "./fleetDetection";
import { nonEmpty } from "./validation";

export const MAX_ALERT_NOTE = 500;
const MAX_RECENT_ALERTS_PER_VEHICLE = 100;
const MAX_RETURNED_TRIPS_FOR_FACTS = 20;

type StoredAlertKind = "unlogged_movement" | "off_route" | "trip_overdue";

const ALERT_SEVERITY: Record<StoredAlertKind, "critical" | "warning"> = {
  unlogged_movement: "warning",
  off_route: "warning",
  // A car that has not come back after 12 hours is the most urgent event.
  trip_overdue: "critical",
};

function alertTitle(kind: StoredAlertKind, vehicleName: string) {
  switch (kind) {
    case "unlogged_movement":
      return `Movement without a trip: ${vehicleName}`;
    case "off_route":
      return `Off route: ${vehicleName}`;
    case "trip_overdue":
      return `Trip overdue: ${vehicleName}`;
  }
}

function kmLabel(meters: number) {
  return `${(meters / 1000).toFixed(1)} km`;
}

function vehicleNameOf(vehicle: Doc<"fleetVehicles"> | null) {
  return vehicle?.displayName?.trim() || vehicle?.registrationNumber || "Vehicle";
}

/**
 * Create or refresh a stored event. Re-runs find the same `dedupeKey`; an
 * already-resolved alert is never reopened or rewritten, because the review
 * decision is the user's record of what happened.
 */
async function upsertStoredAlert(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    kind: StoredAlertKind;
    vehicleId: Id<"fleetVehicles">;
    tripId?: Id<"fleetTrips">;
    dedupeKey: string;
    occurredAt: number;
    endedAt?: number;
    lat?: number;
    lng?: number;
    address?: string;
    distanceMeters?: number;
    maxDeviationMeters?: number;
    fromAddress?: string;
    toAddress?: string;
    summary: string;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("fleetAlerts")
    .withIndex("by_companyId_and_dedupeKey", (q) =>
      q.eq("companyId", args.companyId).eq("dedupeKey", args.dedupeKey),
    )
    .first();
  if (existing) {
    if (existing.status === "resolved") return existing._id;
    const patch: Partial<Doc<"fleetAlerts">> = { updatedAt: args.now };
    if (args.endedAt !== undefined && (existing.endedAt ?? 0) < args.endedAt) {
      patch.endedAt = args.endedAt;
    }
    if (
      args.distanceMeters !== undefined &&
      (existing.distanceMeters ?? 0) < args.distanceMeters
    ) {
      patch.distanceMeters = args.distanceMeters;
    }
    // Off-route location/summary must describe the farthest point ever seen.
    // A later reconcile with a smaller (or equal) deviation must not move the
    // alert to a nearer point or rewrite its distance summary.
    const advancesOffRoute =
      args.kind !== "off_route" ||
      (args.maxDeviationMeters !== undefined &&
        (existing.maxDeviationMeters ?? Number.NEGATIVE_INFINITY) <
          args.maxDeviationMeters);
    if (args.maxDeviationMeters !== undefined && advancesOffRoute) {
      patch.maxDeviationMeters = args.maxDeviationMeters;
    }
    if (advancesOffRoute) {
      if (args.lat !== undefined) patch.lat = args.lat;
      if (args.lng !== undefined) patch.lng = args.lng;
      if (args.address) patch.address = args.address;
      if (args.summary !== existing.summary) patch.summary = args.summary;
    }
    if (args.fromAddress && !existing.fromAddress) patch.fromAddress = args.fromAddress;
    if (args.toAddress) patch.toAddress = args.toAddress;
    await ctx.db.patch(existing._id, patch);
    return existing._id;
  }
  return await ctx.db.insert("fleetAlerts", {
    companyId: args.companyId,
    kind: args.kind,
    status: "open",
    vehicleId: args.vehicleId,
    ...(args.tripId ? { tripId: args.tripId } : {}),
    dedupeKey: args.dedupeKey,
    occurredAt: args.occurredAt,
    ...(args.endedAt !== undefined ? { endedAt: args.endedAt } : {}),
    ...(args.lat !== undefined ? { lat: args.lat } : {}),
    ...(args.lng !== undefined ? { lng: args.lng } : {}),
    ...(args.address ? { address: args.address } : {}),
    ...(args.distanceMeters !== undefined ? { distanceMeters: args.distanceMeters } : {}),
    ...(args.maxDeviationMeters !== undefined
      ? { maxDeviationMeters: args.maxDeviationMeters }
      : {}),
    ...(args.fromAddress ? { fromAddress: args.fromAddress } : {}),
    ...(args.toAddress ? { toAddress: args.toAddress } : {}),
    summary: args.summary,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

type Observation = {
  at: number;
  lat: number;
  lng: number;
  label?: string;
  odometerMeters?: number;
  parked?: boolean;
};

function historyObservations(
  points: readonly TrackerHistoryPoint[],
  since: number,
): Observation[] {
  return points
    .filter((point) => point.at >= since)
    .map((point) => ({
      at: point.at,
      lat: point.lat,
      lng: point.lng,
      label: undefined,
      ...(point.odometerMeters !== undefined ? { odometerMeters: point.odometerMeters } : {}),
      parked: isParkedObservation(point),
    }));
}

function trackerTripEndObservations(
  trips: readonly Doc<"fleetTrackerTrips">[],
  since: number,
): Observation[] {
  const observations: Observation[] = [];
  for (const trip of trips) {
    if (trip.endedAt < since) continue;
    if (trip.endLat === undefined || trip.endLng === undefined) continue;
    observations.push({
      at: trip.endedAt,
      lat: trip.endLat,
      lng: trip.endLng,
      ...(trip.endLandmark ? { label: trip.endLandmark } : {}),
      // A GetTrips segment ends when the ignition went off.
      parked: true,
    });
  }
  return observations;
}

function liveObservation(vehicle: Doc<"fleetVehicles">, since: number): Observation | null {
  if (vehicle.recordedAt === undefined || vehicle.recordedAt < since) return null;
  if (vehicle.lat === undefined || vehicle.lng === undefined) return null;
  return {
    at: vehicle.recordedAt,
    lat: vehicle.lat,
    lng: vehicle.lng,
    ...(vehicle.address ? { label: vehicle.address } : {}),
    ...(vehicle.odometerMeters !== undefined
      ? { odometerMeters: vehicle.odometerMeters }
      : {}),
    parked: isParkedObservation(vehicle),
  };
}

function earliestInside(
  observations: readonly Observation[],
  center: LatLng,
  radiusMeters: number,
) {
  let best: Observation | null = null;
  for (const observation of observations) {
    if (!isInsideRadius(observation, center, radiusMeters)) continue;
    if (!best || observation.at < best.at) best = observation;
  }
  return best;
}

async function loadTrackerTripsBetween(
  ctx: MutationCtx,
  vehicleId: Id<"fleetVehicles">,
  from: number,
  to: number,
) {
  return await ctx.db
    .query("fleetTrackerTrips")
    .withIndex("by_vehicleId_and_startAt", (q) =>
      q.eq("vehicleId", vehicleId).gte("startedAt", from).lte("startedAt", to),
    )
    .take(MAX_TRACKER_TRIPS_PER_RECONCILE);
}

type TripFactOptions = {
  companyId: Id<"companies">;
  now: number;
  trip: Doc<"fleetTrips">;
  placeById: Map<Id<"fleetPlaces">, Doc<"fleetPlaces">>;
  bases: readonly Doc<"fleetPlaces">[];
  observations: readonly Observation[];
  startPoint: LatLng | null;
  allowAutoReturn: boolean;
};

function storedStartPoint(trip: Doc<"fleetTrips">): LatLng | null {
  return trip.startLat !== undefined && trip.startLng !== undefined
    ? { lat: trip.startLat, lng: trip.startLng }
    : null;
}

function trackerStartPoint(
  trip: Doc<"fleetTrips">,
  trackerTrips: readonly Doc<"fleetTrackerTrips">[],
): LatLng | null {
  const direct = storedStartPoint(trip);
  if (direct) return direct;
  const start = trackerTrips
    .filter(
      (trackerTrip) =>
        trackerTrip.startedAt >= trip.departedAt - TRIP_COVERAGE_BUFFER_MS &&
        trackerTrip.startedAt <= (trip.returnedAt ?? Number.POSITIVE_INFINITY) &&
        trackerTrip.startLat !== undefined &&
        trackerTrip.startLng !== undefined,
    )
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  if (!start || start.startLat === undefined || start.startLng === undefined) return null;
  return { lat: start.startLat, lng: start.startLng };
}

/**
 * Derive arrival, automatic return and off-route facts for one logged trip
 * from a bounded observation set. Both the stored-data reconcile and the live
 * sync path call this helper so they can never diverge.
 *
 * - Observations outside [departedAt, returnedAt ?? now] are ignored.
 * - Deviation is measured over observations at or before the arrival (or all
 *   bounded observations when arrival is unknown), so a detour followed by an
 *   arrival is still flagged.
 * - `allowAutoReturn: false` processes a trip that is already returned: facts
 *   are filled in but the trip is never closed again.
 * - Auto-return requires a parked observation strictly after arrival.
 */
async function applyTripObservations(ctx: MutationCtx, options: TripFactOptions) {
  const { trip, now } = options;
  if (trip.placeId === undefined) return;
  const destination = options.placeById.get(trip.placeId) ?? null;
  if (!destination) return;

  const upperBound = trip.returnedAt ?? now;
  const observations = options.observations
    .filter((observation) => observation.at >= trip.departedAt && observation.at <= upperBound)
    .sort((a, b) => a.at - b.at);

  let arrivedAt = trip.arrivedAt;
  const arrival = earliestInside(observations, destination, destination.radiusMeters);
  if (arrival && (arrivedAt === undefined || arrival.at < arrivedAt)) {
    arrivedAt = arrival.at;
    trip.arrivedAt = arrivedAt;
    await ctx.db.patch(trip._id, { arrivedAt, updatedAt: now });
  }

  if (options.allowAutoReturn && trip.status === "open" && arrivedAt !== undefined) {
    const returnObservation = observations.find(
      (observation) =>
        observation.at > arrivedAt! &&
        observation.parked &&
        options.bases.some((base) => isInsideRadius(observation, base, base.radiusMeters)),
    );
    if (returnObservation) {
      trip.status = "returned";
      trip.returnedAt = returnObservation.at;
      trip.autoReturned = true;
      if (returnObservation.odometerMeters !== undefined) {
        trip.endOdometerMeters = returnObservation.odometerMeters;
      }
      await ctx.db.patch(trip._id, {
        status: "returned",
        returnedAt: returnObservation.at,
        autoReturned: true,
        ...(returnObservation.odometerMeters !== undefined
          ? { endOdometerMeters: returnObservation.odometerMeters }
          : {}),
        updatedAt: now,
      });
      await resolveTripOverdueAlerts(
        ctx,
        trip._id,
        "The trip returned automatically.",
        returnObservation.at,
      );
    }
  }

  let basePlaceId = trip.basePlaceId;
  if (!basePlaceId && options.startPoint) {
    const base = selectBasePlace(options.startPoint, options.bases, destination._id);
    if (base) {
      basePlaceId = base._id;
      trip.basePlaceId = base._id;
      await ctx.db.patch(trip._id, { basePlaceId, updatedAt: now });
    }
  }
  const base = basePlaceId ? options.placeById.get(basePlaceId) ?? null : null;
  if (!base) return;

  const cutoff = arrivedAt ?? Number.POSITIVE_INFINITY;
  const deviation = maxCorridorDeviation(
    observations
      .filter((observation) => observation.at <= cutoff)
      .map((observation) => ({
        lat: observation.lat,
        lng: observation.lng,
        at: observation.at,
        ...(observation.label ? { label: observation.label } : {}),
      })),
    base,
    destination,
  );
  if (!deviation) return;
  const maxDeviationMeters = Math.round(deviation.maxDeviationMeters);
  // The first observation can legitimately be 0 m from the corridor; only a
  // missing value compares below it.
  if ((trip.maxDeviationMeters ?? Number.NEGATIVE_INFINITY) < maxDeviationMeters) {
    trip.maxDeviationMeters = maxDeviationMeters;
    await ctx.db.patch(trip._id, { maxDeviationMeters, updatedAt: now });
  }
  if (maxDeviationMeters > OFF_ROUTE_CORRIDOR_METERS) {
    await upsertStoredAlert(ctx, {
      companyId: options.companyId,
      kind: "off_route",
      vehicleId: trip.vehicleId,
      tripId: trip._id,
      dedupeKey: `off_route:${trip._id}`,
      occurredAt: deviation.point.at ?? now,
      lat: deviation.point.lat,
      lng: deviation.point.lng,
      ...(deviation.point.label ? { address: deviation.point.label } : {}),
      maxDeviationMeters,
      summary: `Deviated ${kmLabel(maxDeviationMeters)} from the route to ${trip.destination}.`,
      now,
    });
  }
}

/**
 * Re-derive one vehicle's tracker-trip matches, arrival, auto-return, actual
 * distance, off-route alert and unlogged-movement alerts from stored data.
 * Called after ingestion and (by schedule) after trip records change.
 */
async function reconcileVehicleState(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  vehicleId: Id<"fleetVehicles">,
  now: number,
  history?: readonly TrackerHistoryPoint[],
) {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.companyId !== companyId) return;

  const placesResult = await loadCompanyPlaces(ctx, companyId, true);
  const places = placesResult.rows;
  const placeById = new Map(places.map((place) => [place._id, place]));
  const bases = places.filter((place) => place.kind === "base" && !place.archived);

  const trackerTrips = await ctx.db
    .query("fleetTrackerTrips")
    .withIndex("by_vehicleId_and_startAt", (q) =>
      q.eq("vehicleId", vehicleId).gte("startedAt", now - INGEST_LOOKBACK_MS),
    )
    .take(MAX_TRACKER_TRIPS_PER_RECONCILE);

  const loggedTrips = (
    await ctx.db
      .query("fleetTrips")
      .withIndex("by_vehicleId_and_departedAt", (q) => q.eq("vehicleId", vehicleId))
      .order("desc")
      .take(200)
  ).filter((trip) => (trip.returnedAt ?? now) >= now - UNLOGGED_LOOKBACK_MS);

  const matchingTrips = [...loggedTrips].sort((a, b) => b.departedAt - a.departedAt);
  for (const trackerTrip of trackerTrips) {
    const match =
      matchingTrips.find((trip) => {
        const end = trip.returnedAt ?? now;
        return (
          trackerTrip.startedAt >= trip.departedAt - TRIP_COVERAGE_BUFFER_MS &&
          trackerTrip.endedAt <= end + TRIP_COVERAGE_BUFFER_MS
        );
      }) ?? null;
    if ((trackerTrip.matchedTripId ?? null) !== (match?._id ?? null)) {
      await ctx.db.patch(trackerTrip._id, {
        matchedTripId: match?._id,
        updatedAt: now,
      });
    }
  }

  const historySince = now - MAX_HISTORY_LOOKBACK_MS;
  const histories = history ? historyObservations(history, historySince) : [];
  const observations: Observation[] = [
    ...trackerTripEndObservations(trackerTrips, now - INGEST_LOOKBACK_MS),
    ...histories,
  ];
  const live = liveObservation(vehicle, now - INGEST_LOOKBACK_MS);
  if (live) observations.push(live);
  observations.sort((a, b) => a.at - b.at);

  const openTrip = loggedTrips.find((trip) => trip.status === "open") ?? null;
  if (openTrip) {
    await applyTripObservations(ctx, {
      companyId,
      now,
      trip: openTrip,
      placeById,
      bases,
      observations,
      startPoint: trackerStartPoint(openTrip, trackerTrips),
      allowAutoReturn: true,
    });
  }

  // A trip returned before any observation sampled the destination still gets
  // its arrival/deviation facts filled in. It stays returned: auto-return is
  // disabled and observations are bounded by returnedAt inside the helper.
  const returnedFactTrips = loggedTrips
    .filter(
      (trip) =>
        trip.status === "returned" &&
        trip.placeId !== undefined &&
        trip.returnedAt !== undefined &&
        trip.returnedAt >= now - INGEST_LOOKBACK_MS &&
        (trip.arrivedAt === undefined || trip.maxDeviationMeters === undefined),
    )
    .sort((a, b) => (b.returnedAt ?? 0) - (a.returnedAt ?? 0))
    .slice(0, MAX_RETURNED_TRIPS_FOR_FACTS);
  for (const trip of returnedFactTrips) {
    await applyTripObservations(ctx, {
      companyId,
      now,
      trip,
      placeById,
      bases,
      observations,
      startPoint: trackerStartPoint(trip, trackerTrips),
      allowAutoReturn: false,
    });
  }

  // Actual distance for trips that overlap the ingested window.
  const distanceTrips = loggedTrips.filter(
    (trip) => trip.status === "open" || trip.departedAt >= now - INGEST_LOOKBACK_MS,
  );
  for (const trip of distanceTrips) {
    // The loaded tracker segments start at now - 48 h. Recomputing an older
    // trip would shrink or clear a distance derived from a larger window.
    if (trip.departedAt < now - INGEST_LOOKBACK_MS) continue;
    const end = trip.returnedAt ?? now;
    const actual = sumOverlappingDistance(trackerTrips, trip.departedAt, end);
    const next = actual > 0 ? actual : undefined;
    if ((trip.actualDistanceMeters ?? undefined) !== next) {
      await ctx.db.patch(trip._id, { actualDistanceMeters: next, updatedAt: now });
    }
  }

  // Unlogged movement ("outing") alerts. This scan includes resolved alerts:
  // an outing already reviewed must not be raised again when a late segment
  // changes its first trip or when the old first segment ages out.
  const vehicleAlerts = await ctx.db
    .query("fleetAlerts")
    .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicleId))
    .order("desc")
    .take(MAX_RECENT_ALERTS_PER_VEHICLE);

  if (vehicle.requiresTripLogging === false) {
    for (const alert of vehicleAlerts) {
      if (alert.kind !== "unlogged_movement" || alert.status === "resolved") continue;
      await ctx.db.patch(alert._id, {
        status: "resolved",
        resolvedAt: now,
        resolutionNote: "Trip logging is disabled for this vehicle.",
        updatedAt: now,
      });
    }
    return;
  }

  const uncovered = trackerTrips
    .filter(
      (trip) =>
        trip.distanceMeters >= UNLOGGED_MIN_TRIP_DISTANCE_METERS &&
        !isTrackerTripCovered(trip, loggedTrips, now),
    )
    .sort((a, b) => a.startedAt - b.startedAt);

  // An outing alert is a live condition: a trip logged after the alert was
  // raised (start, backdated edit, or the pre-departure buffer) can cover the
  // whole movement. Resolve those instead of leaving a false review item.
  for (const alert of vehicleAlerts) {
    if (alert.kind !== "unlogged_movement" || alert.status === "resolved") continue;
    // Older outings may have segments outside the loaded tracker window.
    if (alert.occurredAt < now - INGEST_LOOKBACK_MS) continue;
    const alertEnd = alert.endedAt ?? alert.occurredAt;
    const stillUncovered = uncovered.some(
      (trip) =>
        trip.startedAt <= alertEnd + UNLOGGED_GROUP_GAP_MS &&
        trip.endedAt >= alert.occurredAt - UNLOGGED_GROUP_GAP_MS,
    );
    if (stillUncovered) continue;
    await ctx.db.patch(alert._id, {
      status: "resolved",
      resolvedAt: now,
      resolutionNote: "A logged trip now covers this movement.",
      updatedAt: now,
    });
  }

  for (const group of groupConsecutiveTrips(uncovered, UNLOGGED_GROUP_GAP_MS)) {
    const first = group[0];
    const last = group[group.length - 1];
    const distanceMeters = group.reduce((sum, trip) => sum + trip.distanceMeters, 0);
    const fromAddress = first.startLandmark;
    const toAddress = last.endLandmark;
    const summary = `${kmLabel(distanceMeters)} from ${fromAddress ?? "an unknown place"} to ${
      toAddress ?? "an unknown place"
    }.`;
    const overlapping = vehicleAlerts.find(
      (alert) =>
        alert.kind === "unlogged_movement" &&
        (alert.endedAt ?? alert.occurredAt) >= first.startedAt - UNLOGGED_GROUP_GAP_MS &&
        alert.occurredAt <= last.endedAt + UNLOGGED_GROUP_GAP_MS,
    );
    if (overlapping) {
      // A reviewed outing is a closed decision: extend only open alerts.
      if (overlapping.status === "open") {
        const patch: Partial<Doc<"fleetAlerts">> = { updatedAt: now };
        if (first.startedAt < overlapping.occurredAt) {
          patch.occurredAt = first.startedAt;
          if (fromAddress) patch.fromAddress = fromAddress;
        }
        if ((overlapping.endedAt ?? 0) < last.endedAt) patch.endedAt = last.endedAt;
        if ((overlapping.distanceMeters ?? 0) < distanceMeters) {
          patch.distanceMeters = distanceMeters;
        }
        if (last.endLat !== undefined) patch.lat = last.endLat;
        if (last.endLng !== undefined) patch.lng = last.endLng;
        if (toAddress) patch.address = toAddress;
        if (toAddress) patch.toAddress = toAddress;
        if (summary !== overlapping.summary) patch.summary = summary;
        await ctx.db.patch(overlapping._id, patch);
      }
      continue;
    }
    await upsertStoredAlert(ctx, {
      companyId,
      kind: "unlogged_movement",
      vehicleId,
      dedupeKey: `unlogged:${vehicleId}:${first._id}`,
      occurredAt: first.startedAt,
      endedAt: last.endedAt,
      ...(last.endLat !== undefined ? { lat: last.endLat } : {}),
      ...(last.endLng !== undefined ? { lng: last.endLng } : {}),
      ...(toAddress ? { address: toAddress } : {}),
      distanceMeters,
      ...(fromAddress ? { fromAddress } : {}),
      ...(toAddress ? { toAddress } : {}),
      summary,
      now,
    });
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export const listVehiclesForIngest = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const vehicles = await loadCompanyVehicles(ctx, args.companyId);
    const open = await loadOpenTrips(ctx, args.companyId);
    const openByVehicle = new Map(open.rows.map((trip) => [trip.vehicleId, trip]));
    return {
      vehicles: vehicles.rows.map((vehicle) => {
        const trip = openByVehicle.get(vehicle._id);
        return {
          vehicleId: vehicle._id,
          registrationNumber: vehicle.registrationNumber,
          openTrip: trip
            ? { departedAt: trip.departedAt, placeId: trip.placeId ?? null }
            : null,
        };
      }),
      isTruncated: vehicles.isTruncated || open.isTruncated,
    };
  },
});

export const getIngestWindow = internalQuery({
  args: { vehicleId: v.id("fleetVehicles"), now: v.number() },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("fleetTrackerTrips")
      .withIndex("by_vehicleId_and_startAt", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .first();
    const windowStart = latest
      ? Math.max(args.now - INGEST_LOOKBACK_MS, latest.startedAt - INGEST_OVERLAP_MS)
      : args.now - INGEST_LOOKBACK_MS;
    return { from: Math.min(windowStart, args.now) };
  },
});

export const applyTrackerTripIngest = internalMutation({
  args: {
    companyId: v.id("companies"),
    connectionId: v.id("fleetTrackerConnections"),
    connectionGeneration: v.number(),
    vehicleId: v.id("fleetVehicles"),
    now: v.number(),
    trips: v.array(trackerTripValidator),
    history: v.optional(v.array(trackerHistoryPointValidator)),
  },
  handler: async (ctx, args) => {
    // A key replaced or disconnected while the fetch was in flight must not
    // write trips read with the old account, exactly like applyTrackerSync.
    const connection = await ctx.db
      .query("fleetTrackerConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .unique();
    if (
      !connection ||
      connection._id !== args.connectionId ||
      (connection.generation ?? 0) !== args.connectionGeneration
    ) {
      return { ingested: 0, stale: true };
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.companyId !== args.companyId) {
      throw new ConvexError("Vehicle not found.");
    }

    // Newest first keeps the most recent trips when a window overflows the
    // per-vehicle cap; insert in chronological order for a stable review.
    const byStart = new Map<number, TrackerTrip>();
    for (const trip of [...args.trips].sort((a, b) => b.startedAt - a.startedAt)) {
      if (trip.registrationNumber !== vehicle.registrationNumber) continue;
      if (trip.distanceMeters < MIN_TRACKER_TRIP_DISTANCE_METERS) continue;
      const existing = byStart.get(trip.startedAt);
      if (!existing || trip.endedAt > existing.endedAt) byStart.set(trip.startedAt, trip);
    }
    const incoming = [...byStart.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-MAX_TRACKER_TRIPS_PER_VEHICLE_INGEST);

    if (incoming.length > 0) {
      const firstStart = incoming[0].startedAt;
      const lastStart = incoming[incoming.length - 1].startedAt;
      const existingTrips = await ctx.db
        .query("fleetTrackerTrips")
        .withIndex("by_vehicleId_and_startAt", (q) =>
          q.eq("vehicleId", args.vehicleId).gte("startedAt", firstStart).lte("startedAt", lastStart),
        )
        .take(MAX_TRACKER_TRIPS_PER_VEHICLE_INGEST + 1);
      const existingByStart = new Map(existingTrips.map((trip) => [trip.startedAt, trip]));
      for (const trip of incoming) {
        const existing = existingByStart.get(trip.startedAt);
        if (!existing) {
          await ctx.db.insert("fleetTrackerTrips", {
            companyId: args.companyId,
            vehicleId: args.vehicleId,
            startedAt: trip.startedAt,
            endedAt: trip.endedAt,
            ...(trip.startLat !== undefined ? { startLat: trip.startLat } : {}),
            ...(trip.startLng !== undefined ? { startLng: trip.startLng } : {}),
            ...(trip.startLandmark ? { startLandmark: trip.startLandmark } : {}),
            ...(trip.endLat !== undefined ? { endLat: trip.endLat } : {}),
            ...(trip.endLng !== undefined ? { endLng: trip.endLng } : {}),
            ...(trip.endLandmark ? { endLandmark: trip.endLandmark } : {}),
            distanceMeters: trip.distanceMeters,
            travelSeconds: trip.travelSeconds,
            maxSpeedKmh: trip.maxSpeedKmh,
            ...(trip.avgSpeedKmh !== undefined ? { avgSpeedKmh: trip.avgSpeedKmh } : {}),
            createdAt: args.now,
            updatedAt: args.now,
          });
          continue;
        }
        const patch: Partial<Doc<"fleetTrackerTrips">> = {};
        if (existing.endedAt !== trip.endedAt) patch.endedAt = trip.endedAt;
        if (existing.distanceMeters !== trip.distanceMeters) patch.distanceMeters = trip.distanceMeters;
        if (existing.travelSeconds !== trip.travelSeconds) patch.travelSeconds = trip.travelSeconds;
        if (existing.maxSpeedKmh !== trip.maxSpeedKmh) patch.maxSpeedKmh = trip.maxSpeedKmh;
        if (existing.startLat !== trip.startLat) patch.startLat = trip.startLat;
        if (existing.startLng !== trip.startLng) patch.startLng = trip.startLng;
        if (existing.startLandmark !== trip.startLandmark) patch.startLandmark = trip.startLandmark;
        if (existing.endLat !== trip.endLat) patch.endLat = trip.endLat;
        if (existing.endLng !== trip.endLng) patch.endLng = trip.endLng;
        if (existing.endLandmark !== trip.endLandmark) patch.endLandmark = trip.endLandmark;
        if (existing.avgSpeedKmh !== trip.avgSpeedKmh) patch.avgSpeedKmh = trip.avgSpeedKmh;
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = args.now;
          await ctx.db.patch(existing._id, patch);
        }
      }
    }

    await reconcileVehicleState(
      ctx,
      args.companyId,
      args.vehicleId,
      args.now,
      args.history,
    );
    return { ingested: incoming.length, stale: false };
  },
});

/** Reconcile a vehicle from already-stored data (scheduled after trip edits). */
export const reconcileVehicle = internalMutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await reconcileVehicleState(ctx, args.companyId, args.vehicleId, args.now ?? Date.now());
    return null;
  },
});

async function ingestCompanyTrackerTrips(
  ctx: ActionCtx,
  companyId: Id<"companies">,
): Promise<{ vehicles: number; failed: number; ingested: number }> {
  const source = await ctx.runQuery(internal.fleetInternal.getSyncSource, { companyId });
  if (!source.connection) return { vehicles: 0, failed: 0, ingested: 0 };

  const now = Date.now();
  const data: {
    vehicles: {
      vehicleId: Id<"fleetVehicles">;
      registrationNumber: string;
      openTrip: { departedAt: number; placeId: Id<"fleetPlaces"> | null } | null;
    }[];
    isTruncated: boolean;
  } = await ctx.runQuery(internal.fleetMonitoring.listVehiclesForIngest, { companyId });
  let failed = 0;
  let ingested = 0;
  let historyFetches = 0;

  for (const vehicle of data.vehicles) {
    const window: { from: number } = await ctx.runQuery(
      internal.fleetMonitoring.getIngestWindow,
      { vehicleId: vehicle.vehicleId, now },
    );

    let trips: TrackerTrip[];
    try {
      trips = (
        await fetchTrackerTrips(
          source.connection.secretKey,
          vehicle.registrationNumber,
          window.from,
          now,
        )
      ).trips;
    } catch {
      // One vehicle's tracker failure must not block the rest of the fleet.
      failed += 1;
      continue;
    }

    // History sharpens arrival time and off-route distance for trips that are
    // still open. It is optional and bounded in both window and count.
    let history: TrackerHistoryPoint[] | undefined;
    if (vehicle.openTrip?.placeId && historyFetches < MAX_HISTORY_FETCHES_PER_RUN) {
      historyFetches += 1;
      const from = Math.max(vehicle.openTrip.departedAt, now - MAX_HISTORY_LOOKBACK_MS);
      try {
        const points = (
          await fetchTrackerVehicleHistory(
            source.connection.secretKey,
            vehicle.registrationNumber,
            from,
            now,
          )
        ).points;
        history =
          points.length > MAX_HISTORY_POINTS ? points.slice(-MAX_HISTORY_POINTS) : points;
      } catch {
        // Arrival still works from GetTrips end points and the live reading.
      }
    }

    try {
      const result: { ingested: number; stale: boolean } = await ctx.runMutation(
        internal.fleetMonitoring.applyTrackerTripIngest,
        {
          companyId,
          connectionId: source.connection.id,
          connectionGeneration: source.connection.generation,
          vehicleId: vehicle.vehicleId,
          now,
          trips,
          ...(history ? { history } : {}),
        },
      );
      ingested += result.ingested;
    } catch {
      failed += 1;
    }
  }

  return { vehicles: data.vehicles.length, failed, ingested };
}

/** Cron entry point: page every tracker connection and ingest its fleet. */
export const ingestTrackerTrips = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<{ companies: number; vehicles: number; failed: number; ingested: number }> => {
    const page: {
      connections: { companyId: Id<"companies"> }[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.fleetInternal.listConnectionsPage, {
      cursor: args.cursor ?? null,
    });

    let vehicles = 0;
    let failed = 0;
    let ingested = 0;
    for (const connection of page.connections) {
      try {
        const result = await ingestCompanyTrackerTrips(ctx, connection.companyId);
        vehicles += result.vehicles;
        failed += result.failed;
        ingested += result.ingested;
      } catch {
        failed += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fleetMonitoring.ingestTrackerTrips, {
        cursor: page.continueCursor,
      });
    }
    return { companies: page.connections.length, vehicles, failed, ingested };
  },
});

// ---------------------------------------------------------------------------
// Live reconciliation
// ---------------------------------------------------------------------------

/**
 * Apply the current tracker snapshot to open trips: arrival, automatic return,
 * and off-route deviation. Called by the sync action after vehicle rows land.
 */
export const reconcileLivePositions = internalMutation({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    const vehicles = (await loadCompanyVehicles(ctx, args.companyId)).rows;
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle._id, vehicle]));
    const open = await loadOpenTrips(ctx, args.companyId);
    const places = (await loadCompanyPlaces(ctx, args.companyId, true)).rows;
    const placeById = new Map(places.map((place) => [place._id, place]));
    const bases = places.filter((place) => place.kind === "base" && !place.archived);

    for (const trip of open.rows) {
      const vehicle = vehicleById.get(trip.vehicleId);
      if (!vehicle) continue;
      const live = liveObservation(vehicle, trip.departedAt);
      const wasOpen = trip.status === "open";
      await applyTripObservations(ctx, {
        companyId: args.companyId,
        now: args.now,
        trip,
        placeById,
        bases,
        observations: live ? [live] : [],
        startPoint: storedStartPoint(trip),
        allowAutoReturn: true,
      });

      // A live automatic return is the one path where the trip transitions
      // during this mutation. Tracker-trip distance may not exist yet; only
      // overwrite the stored value when the local window actually found some.
      if (
        wasOpen &&
        trip.status === "returned" &&
        trip.returnedAt !== undefined &&
        trip.departedAt >= args.now - INGEST_LOOKBACK_MS
      ) {
        const trackerTrips = await loadTrackerTripsBetween(
          ctx,
          trip.vehicleId,
          Math.max(trip.departedAt - INGEST_OVERLAP_MS, args.now - INGEST_LOOKBACK_MS),
          trip.returnedAt,
        );
        const actual = sumOverlappingDistance(trackerTrips, trip.departedAt, trip.returnedAt);
        if (actual > 0) {
          await ctx.db.patch(trip._id, {
            actualDistanceMeters: actual,
            updatedAt: args.now,
          });
        }
      }
    }
    return null;
  },
});

/**
 * Global overdue scan. Runs even when a company's tracker is disconnected or
 * failing, because the trip record itself is authoritative.
 */
export const checkOverdueTrips = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("fleetTrips")
      .withIndex("by_status_and_departedAt", (q) =>
        q.eq("status", "open").lte("departedAt", now - TRIP_OVERDUE_MS),
      )
      .paginate({ numItems: 50, cursor: args.cursor ?? null });

    let created = 0;
    for (const trip of page.page) {
      if (trip.status !== "open") continue;
      const vehicle = await ctx.db.get(trip.vehicleId);
      const existing = await ctx.db
        .query("fleetAlerts")
        .withIndex("by_companyId_and_dedupeKey", (q) =>
          q.eq("companyId", trip.companyId).eq("dedupeKey", `trip_overdue:${trip._id}`),
        )
        .first();
      if (existing) continue;
      const hours = Math.floor((now - trip.departedAt) / (60 * 60_000));
      await ctx.db.insert("fleetAlerts", {
        companyId: trip.companyId,
        kind: "trip_overdue",
        status: "open",
        vehicleId: trip.vehicleId,
        tripId: trip._id,
        dedupeKey: `trip_overdue:${trip._id}`,
        occurredAt: trip.departedAt + TRIP_OVERDUE_MS,
        summary: `${vehicleNameOf(vehicle)} has been on a trip to ${trip.destination} for ${hours} hours.`,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fleetMonitoring.checkOverdueTrips, {
        cursor: page.continueCursor,
      });
    }
    return { created };
  },
});

// ---------------------------------------------------------------------------
// Alerts feed and actions
// ---------------------------------------------------------------------------

export type AlertFeedStatus = "open" | "resolved" | "all";

async function storedAlertRows(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  status: AlertFeedStatus,
) {
  const takeIndex = async (wanted: "open" | "resolved") =>
    await ctx.db
      .query("fleetAlerts")
      .withIndex("by_companyId_and_status_and_occurredAt", (q) =>
        q.eq("companyId", companyId).eq("status", wanted),
      )
      .order("desc")
      .take(MAX_ALERTS + 1);

  if (status === "open") {
    const rows = await takeIndex("open");
    return { rows: rows.slice(0, MAX_ALERTS), isTruncated: rows.length > MAX_ALERTS };
  }
  if (status === "resolved") {
    const rows = await takeIndex("resolved");
    return { rows: rows.slice(0, MAX_ALERTS), isTruncated: rows.length > MAX_ALERTS };
  }
  const openRows = await takeIndex("open");
  const resolvedRows = await takeIndex("resolved");
  return {
    rows: [...openRows, ...resolvedRows].slice(0, MAX_ALERTS),
    isTruncated: openRows.length + resolvedRows.length > MAX_ALERTS,
  };
}

export async function buildAlertsFeed(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  now: number,
  status: AlertFeedStatus,
) {
  const { company } = await requireCapability(ctx, companyId, "fleet:view");

  const stored = await storedAlertRows(ctx, companyId, status);
  const vehicleCache = new Map<Id<"fleetVehicles">, Doc<"fleetVehicles"> | null>();
  const reviewerCache = new Map<Id<"companyMemberships">, string | null>();
  const eventRows = [];
  for (const alert of stored.rows) {
    let vehicle = vehicleCache.get(alert.vehicleId);
    if (vehicle === undefined) {
      vehicle = await ctx.db.get(alert.vehicleId);
      vehicleCache.set(alert.vehicleId, vehicle);
    }
    const vehicleName = vehicleNameOf(vehicle);
    let resolvedByName: string | null = null;
    if (status !== "open" && alert.resolvedByMembershipId) {
      const membershipId = alert.resolvedByMembershipId;
      if (reviewerCache.has(membershipId)) {
        resolvedByName = reviewerCache.get(membershipId) ?? null;
      } else {
        const reviewer = await ctx.db.get(membershipId);
        let name = [reviewer?.firstName, reviewer?.secondName]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!name && reviewer?.userId) {
          const user = await ctx.db.get(reviewer.userId);
          name = [user?.firstName, user?.secondName].filter(Boolean).join(" ").trim();
        }
        resolvedByName = name || "A manager";
        reviewerCache.set(membershipId, resolvedByName);
      }
    }
    eventRows.push({
      source: "event" as const,
      _id: alert._id,
      key: alert.dedupeKey,
      kind: alert.kind,
      severity: ALERT_SEVERITY[alert.kind],
      title: alertTitle(alert.kind, vehicleName),
      message: alert.summary,
      vehicleId: alert.vehicleId,
      vehicleName,
      tripId: alert.tripId ?? null,
      occurredAt: alert.occurredAt,
      endedAt: alert.endedAt ?? null,
      status: alert.status,
      lat: alert.lat ?? null,
      lng: alert.lng ?? null,
      address: alert.address ?? null,
      distanceMeters: alert.distanceMeters ?? null,
      distanceKm:
        alert.distanceMeters !== undefined ? alert.distanceMeters / 1000 : null,
      maxDeviationMeters: alert.maxDeviationMeters ?? null,
      maxDeviationKm:
        alert.maxDeviationMeters !== undefined ? alert.maxDeviationMeters / 1000 : null,
      fromAddress: alert.fromAddress ?? null,
      toAddress: alert.toAddress ?? null,
      resolutionNote: alert.resolutionNote ?? null,
      resolvedAt: alert.resolvedAt ?? null,
      resolvedByName,
    });
  }

  const derived =
    status === "resolved"
      ? { alerts: [], count: 0, isTruncated: false }
      : await buildDerivedAlerts(ctx, companyId, now, company.timeZone ?? null);

  const derivedRows = [];
  for (const alert of derived.alerts) {
    let vehicleName: string | null = null;
    if (alert.vehicleId) {
      let vehicle = vehicleCache.get(alert.vehicleId);
      if (vehicle === undefined) {
        vehicle = await ctx.db.get(alert.vehicleId);
        vehicleCache.set(alert.vehicleId, vehicle);
      }
      vehicleName = vehicleNameOf(vehicle);
    }
    derivedRows.push({
      source: "derived" as const,
      _id: null,
      key: alert.key,
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      vehicleId: alert.vehicleId,
      vehicleName,
      tripId: null,
      // A due-soon service alert carries its future due date; group and sort
      // it by the moment it became actionable instead.
      occurredAt: alert.at === null ? null : Math.min(alert.at, now),
      endedAt: null,
      status: "open" as const,
      lat: null,
      lng: null,
      address: null,
      distanceMeters: null,
      distanceKm: null,
      maxDeviationMeters: null,
      maxDeviationKm: null,
      fromAddress: null,
      toAddress: null,
      resolutionNote: null,
      resolvedAt: null,
      resolvedByName: null,
    });
  }

  const rows = [...eventRows, ...derivedRows].sort((a, b) => {
    const severityRank = { critical: 0, warning: 1 } as const;
    const rank = severityRank[a.severity] - severityRank[b.severity];
    if (rank !== 0) return rank;
    const aAt = a.occurredAt ?? 0;
    const bAt = b.occurredAt ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return a.title.localeCompare(b.title);
  });

  return {
    alerts: rows.slice(0, MAX_ALERTS),
    count: Math.min(rows.length, MAX_ALERTS),
    openCount: rows.filter((row) => row.status === "open").length,
    isTruncated: stored.isTruncated || derived.isTruncated || rows.length > MAX_ALERTS,
  };
}

export const alertsFeed = query({
  args: {
    companyId: v.id("companies"),
    now: v.number(),
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"), v.literal("all"))),
  },
  handler: async (ctx, args) => {
    return await buildAlertsFeed(ctx, args.companyId, args.now, args.status ?? "open");
  },
});

export const resolveAlert = mutation({
  args: {
    companyId: v.id("companies"),
    alertId: v.id("fleetAlerts"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireFleetLogOrManage(ctx, args.companyId);
    const alert = await ctx.db.get(args.alertId);
    if (!alert || alert.companyId !== args.companyId) throw new ConvexError("Alert not found.");
    if (alert.status === "resolved") return { alreadyResolved: true };
    const note = args.note?.trim();
    if (note && note.length > MAX_ALERT_NOTE) throw new ConvexError("Note is too long.");
    const now = Date.now();
    await ctx.db.patch(alert._id, {
      status: "resolved",
      resolvedByMembershipId: membership._id,
      resolvedAt: now,
      resolutionNote: note || undefined,
      updatedAt: now,
    });
    return { alreadyResolved: false };
  },
});

export const logUnloggedAlertAsTrip = mutation({
  args: {
    companyId: v.id("companies"),
    alertId: v.id("fleetAlerts"),
    driverId: v.id("fleetDrivers"),
    destination: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireFleetLogOrManage(ctx, args.companyId);
    const alert = await ctx.db.get(args.alertId);
    if (!alert || alert.companyId !== args.companyId) throw new ConvexError("Alert not found.");
    if (alert.kind !== "unlogged_movement") {
      throw new ConvexError("This alert cannot be logged as a trip.");
    }
    if (alert.status === "resolved") throw new ConvexError("This alert is already resolved.");

    const vehicle = await ctx.db.get(alert.vehicleId);
    if (!vehicle || vehicle.companyId !== args.companyId) throw new ConvexError("Vehicle not found.");
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.companyId !== args.companyId) throw new ConvexError("Driver not found.");
    if (!driver.active) throw new ConvexError("This driver is inactive.");

    const destination = nonEmpty(
      args.destination?.trim() || alert.toAddress || "Unlogged movement",
      "Destination",
    );
    if (destination.length > MAX_DESTINATION) throw new ConvexError("Destination is too long.");

    const now = Date.now();
    const departedAt = alert.occurredAt;
    const returnedAt = Math.max(alert.endedAt ?? now, departedAt);
    const tripId = await ctx.db.insert("fleetTrips", {
      companyId: args.companyId,
      vehicleId: alert.vehicleId,
      driverId: args.driverId,
      destination,
      ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
      status: "returned",
      departedAt,
      returnedAt,
      ...(alert.distanceMeters !== undefined
        ? { actualDistanceMeters: alert.distanceMeters }
        : {}),
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(alert._id, {
      status: "resolved",
      resolvedByMembershipId: membership._id,
      resolvedAt: now,
      resolutionNote: args.notes?.trim() || "Logged as a trip.",
      updatedAt: now,
    });
    // Match the new trip against stored tracker segments and refresh any
    // remaining outing alerts for this vehicle.
    await ctx.scheduler.runAfter(0, internal.fleetMonitoring.reconcileVehicle, {
      companyId: args.companyId,
      vehicleId: alert.vehicleId,
      now,
    });
    return { tripId };
  },
});

export const setVehicleTripLogging = mutation({
  args: {
    companyId: v.id("companies"),
    vehicleId: v.id("fleetVehicles"),
    requiresTripLogging: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:manage");
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.companyId !== args.companyId) throw new ConvexError("Vehicle not found.");
    const now = Date.now();
    await ctx.db.patch(vehicle._id, {
      requiresTripLogging: args.requiresTripLogging,
      updatedAt: now,
    });
    if (!args.requiresTripLogging) {
      const alerts = await ctx.db
        .query("fleetAlerts")
        .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicle._id))
        .order("desc")
        .take(MAX_RECENT_ALERTS_PER_VEHICLE);
      for (const alert of alerts) {
        if (alert.kind !== "unlogged_movement" || alert.status === "resolved") continue;
        await ctx.db.patch(alert._id, {
          status: "resolved",
          resolvedByMembershipId: membership._id,
          resolvedAt: now,
          resolutionNote: "Trip logging is disabled for this vehicle.",
          updatedAt: now,
        });
      }
    }
    return null;
  },
});



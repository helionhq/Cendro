/**
 * Pure geometry and grouping helpers for fleet detection. Everything here is
 * deterministic and free of Convex types so the risky logic can be tested
 * directly. Distances use a local equirectangular projection, which is
 * accurate enough over a city (and explicitly a heuristic for the off-route
 * corridor — roads are not straight lines).
 */

export const DAY_MS = 86_400_000;

// Places
export const DEFAULT_PLACE_RADIUS_METERS = 300;
export const MIN_PLACE_RADIUS_METERS = 50;
export const MAX_PLACE_RADIUS_METERS = 5_000;
export const MAX_PLACES_PER_COMPANY = 200;
export const SUGGESTION_CLUSTER_RADIUS_METERS = 250;
export const SUGGESTION_LOOKBACK_MS = 30 * DAY_MS;
export const SUGGESTION_MIN_VISITS = 2;
export const MAX_SUGGESTED_PLACES = 20;
export const MAX_SUGGESTION_TRIPS = 2_000;

// Trips and monitoring
export const TRIP_COVERAGE_BUFFER_MS = 15 * 60_000;
export const UNLOGGED_MIN_TRIP_DISTANCE_METERS = 1_000;
export const UNLOGGED_GROUP_GAP_MS = 30 * 60_000;
export const UNLOGGED_LOOKBACK_MS = 48 * 60 * 60_000;
export const OFF_ROUTE_CORRIDOR_METERS = 3_000;
export const TRIP_OVERDUE_MS = 12 * 60 * 60_000;
export const TRACKER_OFFLINE_MS = 2 * 60 * 60_000;

// Tracker ingestion bounds
export const INGEST_LOOKBACK_MS = 48 * 60 * 60_000;
export const INGEST_OVERLAP_MS = 2 * 60 * 60_000;
export const MIN_TRACKER_TRIP_DISTANCE_METERS = 200;
export const MAX_TRACKER_TRIPS_PER_VEHICLE_INGEST = 500;
export const MAX_TRACKER_TRIPS_PER_RECONCILE = 1_000;
export const MAX_HISTORY_LOOKBACK_MS = 24 * 60 * 60_000;
export const MAX_HISTORY_POINTS = 3_000;
export const MAX_HISTORY_FETCHES_PER_RUN = 25;

// Vehicle timeline
export const MAX_TIMELINE_TRACKER_TRIPS = 500;
export const MAX_TIMELINE_LOGGED_TRIPS = 200;
export const MAX_TIMELINE_ALERTS = 200;

const METERS_PER_DEGREE = 111_320;

export type LatLng = { lat: number; lng: number };

export function haversineMeters(a: LatLng, b: LatLng) {
  const radius = 6_371_000;
  const toRadians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRadians;
  const dLng = (b.lng - a.lng) * toRadians;
  const lat1 = a.lat * toRadians;
  const lat2 = b.lat * toRadians;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aValue = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(aValue)));
}

/**
 * Distance from a point to the straight segment a→b, projected locally around
 * the segment's midpoint. A straight corridor is a heuristic, not a road
 * match; that ceiling is deliberate this round.
 */
export function pointToSegmentDistanceMeters(point: LatLng, a: LatLng, b: LatLng) {
  const referenceLat = (a.lat + b.lat + point.lat) / 3;
  const lngScale = Math.cos((referenceLat * Math.PI) / 180);
  const toX = (value: LatLng) => (value.lng - a.lng) * METERS_PER_DEGREE * lngScale;
  const toY = (value: LatLng) => (value.lat - a.lat) * METERS_PER_DEGREE;

  const bx = toX(b);
  const by = toY(b);
  const px = toX(point);
  const py = toY(point);
  const lengthSquared = bx * bx + by * by;
  if (lengthSquared === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  return Math.hypot(px - t * bx, py - t * by);
}

export function isInsideRadius(point: LatLng, center: LatLng, radiusMeters: number) {
  return haversineMeters(point, center) <= radiusMeters;
}

export type PlaceLike = LatLng & { _id: string; radiusMeters: number };

/** Nearest place whose radius covers the point, or null. */
export function findContainingPlace<T extends PlaceLike>(
  point: LatLng,
  places: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const place of places) {
    const distance = haversineMeters(point, place);
    if (distance <= place.radiusMeters && distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best;
}

/** Nearest place by distance, ignoring radius. */
export function findNearestPlace<T extends PlaceLike>(
  point: LatLng,
  places: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const place of places) {
    const distance = haversineMeters(point, place);
    if (distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The base a trip started from: the nearest base to the start observation.
 * The destination is excluded when another base exists, so a base-to-base
 * trip still has a meaningful corridor. When the destination is the only base
 * there is no corridor to measure, so route checks are skipped.
 */
export function selectBasePlace<T extends PlaceLike>(
  start: LatLng | null | undefined,
  bases: readonly T[],
  destinationPlaceId?: string | null,
): T | null {
  if (!start || bases.length === 0) return null;
  const alternatives = destinationPlaceId
    ? bases.filter((place) => place._id !== destinationPlaceId)
    : bases;
  return alternatives.length > 0 ? findNearestPlace(start, alternatives) : null;
}

/**
 * Greedy distance clustering. Points are consumed in the caller's order (the
 * caller sorts newest first); a point joins the first cluster whose running
 * centroid is within `radiusMeters`, otherwise it starts one. This is stable
 * and cheap for the small daily volumes a company fleet produces.
 */
export function clusterByDistance<T extends LatLng>(
  points: readonly T[],
  radiusMeters: number,
): T[][] {
  const clusters: { points: T[]; latSum: number; lngSum: number }[] = [];
  for (const point of points) {
    let joined = false;
    for (const cluster of clusters) {
      const centroid = {
        lat: cluster.latSum / cluster.points.length,
        lng: cluster.lngSum / cluster.points.length,
      };
      if (haversineMeters(point, centroid) <= radiusMeters) {
        cluster.points.push(point);
        cluster.latSum += point.lat;
        cluster.lngSum += point.lng;
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({ points: [point], latSum: point.lat, lngSum: point.lng });
    }
  }
  return clusters.map((cluster) => cluster.points);
}

/** Most frequent non-empty value; ties keep the first value seen. */
export function mostCommonValue(values: readonly (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export type TripWindow = { departedAt: number; returnedAt?: number | null };

/**
 * A tracker trip is covered when it sits inside a logged trip's window
 * expanded by the 15-minute buffer. Open logged trips run through `now`.
 */
export function isTrackerTripCovered(
  trackerTrip: { startedAt: number; endedAt: number },
  loggedTrips: readonly TripWindow[],
  now: number,
  bufferMs = TRIP_COVERAGE_BUFFER_MS,
) {
  return loggedTrips.some((trip) => {
    const end = trip.returnedAt ?? now;
    return (
      trackerTrip.startedAt >= trip.departedAt - bufferMs &&
      trackerTrip.endedAt <= end + bufferMs
    );
  });
}

/** Sort by start and split whenever the gap between consecutive trips is at least `gapMs`. */
export function groupConsecutiveTrips<T extends { startedAt: number; endedAt: number }>(
  trips: readonly T[],
  gapMs = UNLOGGED_GROUP_GAP_MS,
): T[][] {
  const sorted = [...trips].sort((a, b) => a.startedAt - b.startedAt);
  const groups: T[][] = [];
  let current: T[] = [];
  let previousEnd: number | null = null;
  for (const trip of sorted) {
    if (current.length > 0 && previousEnd !== null && trip.startedAt - previousEnd >= gapMs) {
      groups.push(current);
      current = [];
    }
    current.push(trip);
    previousEnd = previousEnd === null ? trip.endedAt : Math.max(previousEnd, trip.endedAt);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export type CorridorPoint = LatLng & { at?: number; label?: string };

export function maxCorridorDeviation(
  points: readonly CorridorPoint[],
  base: LatLng,
  destination: LatLng,
): { maxDeviationMeters: number; point: CorridorPoint } | null {
  let maxDeviationMeters = -1;
  let farthest: CorridorPoint | null = null;
  for (const point of points) {
    const deviation = pointToSegmentDistanceMeters(point, base, destination);
    if (deviation > maxDeviationMeters) {
      maxDeviationMeters = deviation;
      farthest = point;
    }
  }
  return farthest ? { maxDeviationMeters, point: farthest } : null;
}

/**
 * Sum the tracker mileage of every segment overlapping a logged trip window.
 * Segments are stored whole, so a segment crossing the boundary contributes
 * all its distance; acceptable for a display heuristic on short city trips.
 */
export function sumOverlappingDistance(
  trackerTrips: readonly { startedAt: number; endedAt: number; distanceMeters: number }[],
  start: number,
  end: number,
) {
  let total = 0;
  for (const trip of trackerTrips) {
    if (trip.startedAt < end && trip.endedAt > start) total += trip.distanceMeters;
  }
  return total;
}

/** Parked means ignition explicitly off, or an unknown ignition with zero speed. */
export function isParkedObservation(observation: { speed?: number; ignitionOn?: boolean }) {
  if (observation.ignitionOn === false) return true;
  if (observation.ignitionOn === true) return false;
  return (observation.speed ?? 0) === 0;
}

/** Case-insensitive uniqueness key for place names. */
export function normalizePlaceName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

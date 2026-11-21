import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireCapability } from "./permissions";
import { takeWithOverflow } from "./queryLimits";
import { nonEmpty } from "./validation";
import {
  clusterByDistance,
  DEFAULT_PLACE_RADIUS_METERS,
  findContainingPlace,
  MAX_PLACE_RADIUS_METERS,
  MAX_PLACES_PER_COMPANY,
  MAX_SUGGESTED_PLACES,
  MAX_SUGGESTION_TRIPS,
  MIN_PLACE_RADIUS_METERS,
  mostCommonValue,
  normalizePlaceName,
  SUGGESTION_CLUSTER_RADIUS_METERS,
  SUGGESTION_LOOKBACK_MS,
  SUGGESTION_MIN_VISITS,
} from "./fleetDetection";

export const placeKindValidator = v.union(v.literal("base"), v.literal("destination"));
const MAX_PLACE_NAME = 100;
const MAX_PLACE_ADDRESS = 300;

function validateLat(value: number) {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new ConvexError("Latitude must be between -90 and 90.");
  }
  return value;
}

function validateLng(value: number) {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new ConvexError("Longitude must be between -180 and 180.");
  }
  return value;
}

function validateRadius(value: number | undefined) {
  const radius = value ?? DEFAULT_PLACE_RADIUS_METERS;
  if (
    !Number.isFinite(radius) ||
    radius < MIN_PLACE_RADIUS_METERS ||
    radius > MAX_PLACE_RADIUS_METERS
  ) {
    throw new ConvexError(
      `Place radius must be between ${MIN_PLACE_RADIUS_METERS} and ${MAX_PLACE_RADIUS_METERS} metres.`,
    );
  }
  return Math.round(radius);
}

function validatePlaceName(value: string) {
  const name = nonEmpty(value, "Place name");
  if (name.length > MAX_PLACE_NAME) throw new ConvexError("Place name is too long.");
  return name;
}

function validateAddress(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const address = value?.trim() ?? "";
  if (address.length > MAX_PLACE_ADDRESS) throw new ConvexError("Address is too long.");
  return address || undefined;
}

async function requirePlace(ctx: MutationCtx, companyId: Id<"companies">, placeId: Id<"fleetPlaces">) {
  const place = await ctx.db.get(placeId);
  if (!place || place.companyId !== companyId) throw new ConvexError("Place not found.");
  return place;
}

async function assertNameAvailable(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  normalizedName: string,
  exceptId?: Id<"fleetPlaces">,
) {
  const existing = await ctx.db
    .query("fleetPlaces")
    .withIndex("by_companyId_and_normalizedName", (q) =>
      q.eq("companyId", companyId).eq("normalizedName", normalizedName),
    )
    .first();
  if (existing && existing._id !== exceptId) {
    throw new ConvexError("A place with this name already exists.");
  }
}

export function publicPlace(place: Doc<"fleetPlaces">) {
  return {
    _id: place._id,
    name: place.name,
    kind: place.kind,
    lat: place.lat,
    lng: place.lng,
    radiusMeters: place.radiusMeters,
    address: place.address ?? null,
    archived: place.archived,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt,
  };
}

/** Bounded read of a company's places; archived rows are included on request. */
export async function loadCompanyPlaces(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
  includeArchived = false,
) {
  return await takeWithOverflow(
    (limit) =>
      includeArchived
        ? ctx.db
            .query("fleetPlaces")
            .withIndex("by_company", (q) => q.eq("companyId", companyId))
            .take(limit)
        : ctx.db
            .query("fleetPlaces")
            .withIndex("by_companyId_and_archived", (q) =>
              q.eq("companyId", companyId).eq("archived", false),
            )
            .take(limit),
    MAX_PLACES_PER_COMPANY,
  );
}

export const listPlaces = query({
  args: { companyId: v.id("companies"), includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const result = await loadCompanyPlaces(ctx, args.companyId, args.includeArchived ?? false);
    const places = result.rows
      .map(publicPlace)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "base" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { places, isTruncated: result.isTruncated };
  },
});

export const createPlace = mutation({
  args: {
    companyId: v.id("companies"),
    name: v.string(),
    kind: placeKindValidator,
    lat: v.number(),
    lng: v.number(),
    radiusMeters: v.optional(v.number()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "fleet:manage");
    const name = validatePlaceName(args.name);
    const normalizedName = normalizePlaceName(name);
    await assertNameAvailable(ctx, args.companyId, normalizedName);

    const existing = await loadCompanyPlaces(ctx, args.companyId, true);
    if (existing.rows.length >= MAX_PLACES_PER_COMPANY) {
      throw new ConvexError(`You can save at most ${MAX_PLACES_PER_COMPANY} places.`);
    }

    const address = validateAddress(args.address);
    const now = Date.now();
    return await ctx.db.insert("fleetPlaces", {
      companyId: args.companyId,
      name,
      normalizedName,
      kind: args.kind,
      lat: validateLat(args.lat),
      lng: validateLng(args.lng),
      radiusMeters: validateRadius(args.radiusMeters),
      ...(address ? { address } : {}),
      archived: false,
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updatePlace = mutation({
  args: {
    companyId: v.id("companies"),
    placeId: v.id("fleetPlaces"),
    name: v.optional(v.string()),
    kind: v.optional(placeKindValidator),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    radiusMeters: v.optional(v.number()),
    address: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const place = await requirePlace(ctx, args.companyId, args.placeId);

    const patch: Partial<Doc<"fleetPlaces">> = {};
    if (args.name !== undefined) {
      const name = validatePlaceName(args.name);
      const normalizedName = normalizePlaceName(name);
      await assertNameAvailable(ctx, args.companyId, normalizedName, place._id);
      patch.name = name;
      patch.normalizedName = normalizedName;
    }
    if (args.kind !== undefined) patch.kind = args.kind;
    if (args.lat !== undefined) patch.lat = validateLat(args.lat);
    if (args.lng !== undefined) patch.lng = validateLng(args.lng);
    if (args.radiusMeters !== undefined) patch.radiusMeters = validateRadius(args.radiusMeters);
    if (args.address !== undefined) patch.address = validateAddress(args.address);

    if (Object.keys(patch).length === 0) return null;
    patch.updatedAt = Date.now();
    await ctx.db.patch(place._id, patch);
    return null;
  },
});

export const setPlaceArchived = mutation({
  args: {
    companyId: v.id("companies"),
    placeId: v.id("fleetPlaces"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:manage");
    const place = await requirePlace(ctx, args.companyId, args.placeId);
    if (place.archived === args.archived) return null;
    await ctx.db.patch(place._id, { archived: args.archived, updatedAt: Date.now() });
    return null;
  },
});

type SuggestionPoint = {
  lat: number;
  lng: number;
  at: number;
  landmark?: string;
  vehicleId: Id<"fleetVehicles">;
};

/**
 * Frequent tracker-trip end points from the last 30 days that no place covers.
 * Clusters are centroids of stop points; the returned coordinate is the most
 * recent real observation so it lands on a road rather than an averaged gap.
 */
export const suggestPlaces = query({
  args: { companyId: v.id("companies"), now: v.number() },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "fleet:view");
    const since = args.now - SUGGESTION_LOOKBACK_MS;
    const placesResult = await loadCompanyPlaces(ctx, args.companyId, false);
    const places = placesResult.rows;

    const tripsResult = await takeWithOverflow(
      (limit) =>
        ctx.db
          .query("fleetTrackerTrips")
          .withIndex("by_companyId_and_endAt", (q) =>
            q.eq("companyId", args.companyId).gte("endedAt", since).lte("endedAt", args.now),
          )
          .order("desc")
          .take(limit),
      MAX_SUGGESTION_TRIPS,
    );

    const points: SuggestionPoint[] = [];
    for (const trip of tripsResult.rows) {
      if (trip.endLat === undefined || trip.endLng === undefined) continue;
      const point = { lat: trip.endLat, lng: trip.endLng };
      if (findContainingPlace(point, places)) continue;
      points.push({
        lat: trip.endLat,
        lng: trip.endLng,
        at: trip.endedAt,
        landmark: trip.endLandmark,
        vehicleId: trip.vehicleId,
      });
    }

    const suggestions = clusterByDistance(points, SUGGESTION_CLUSTER_RADIUS_METERS)
      .filter((cluster) => cluster.length >= SUGGESTION_MIN_VISITS)
      .map((cluster) => {
        const latSum = cluster.reduce((sum, point) => sum + point.lat, 0);
        const lngSum = cluster.reduce((sum, point) => sum + point.lng, 0);
        const centroid = { lat: latSum / cluster.length, lng: lngSum / cluster.length };
        if (findContainingPlace(centroid, places)) return null;
        const latest = cluster.reduce((best, point) => (point.at > best.at ? point : best), cluster[0]);
        const visits = [...cluster].sort((a, b) => a.at - b.at);
        return {
          lat: latest.lat,
          lng: latest.lng,
          address: mostCommonValue(cluster.map((point) => point.landmark)),
          visitCount: cluster.length,
          vehicleCount: new Set(cluster.map((point) => point.vehicleId)).size,
          firstVisitAt: visits[0].at,
          lastVisitAt: visits[visits.length - 1].at,
        };
      })
      .filter((suggestion): suggestion is NonNullable<typeof suggestion> => suggestion !== null)
      .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitAt - a.lastVisitAt);

    return {
      suggestions: suggestions.slice(0, MAX_SUGGESTED_PLACES),
      isTruncated:
        tripsResult.isTruncated ||
        placesResult.isTruncated ||
        suggestions.length > MAX_SUGGESTED_PLACES,
    };
  },
});

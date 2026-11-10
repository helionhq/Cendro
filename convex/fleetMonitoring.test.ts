/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createAuthzFixture } from "./authz.fixture";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const pinnedNow = Date.UTC(2026, 10, 4, 12);
const trackerEnvelope =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><TWPXCC_GetVDataResponse xmlns="http://tempuri.org/" /></soap:Body></soap:Envelope>';

type Fixture = Awaited<ReturnType<typeof createAuthzFixture>>;

let trackerVehicles: Record<string, unknown>[] = [];
let trackerTrips: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(pinnedNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  trackerVehicles = [];
  trackerTrips = [];
});

function soap(payload: unknown) {
  return new Response(`${JSON.stringify(payload)}${trackerEnvelope}`, { status: 200 });
}

function installTrackerStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const action = String(init?.headers?.SOAPAction ?? "");
      if (action.includes("TWPXCC_GetVData")) {
        return soap({ responseCode: 200, responseMsg: "Sucessful", _vehicleData: trackerVehicles });
      }
      if (action.includes("TWPXCC_GetTrips")) {
        return soap({ responseCode: 200, responseMsg: "Sucessful", _trips: trackerTrips });
      }
      return soap({ responseCode: 402, responseMsg: "No History found...", _vehicleHistory: null });
    }),
  );
}

function rawVehicle(
  registrationNumber: string,
  lat: number,
  lng: number,
  extra: Record<string, unknown> = {},
) {
  return {
    RegistrationNumber: registrationNumber,
    Latitude: String(lat),
    Longitude: String(lng),
    Speed: 0,
    Odometer: 100_000_000,
    LastIgnitionStatus: "False",
    LastIgnitionStatusDateTime: `/Date(${pinnedNow})/`,
    Address: "Base",
    RecordDateTime: `/Date(${pinnedNow})/`,
    Reason: "Ignition Off",
    DirectionDegree: 0,
    ...extra,
  };
}

function rawTrackerTrip(args: {
  registrationNumber?: string;
  startedAt: number;
  endedAt: number;
  start: { lat: number; lng: number; landmark?: string };
  end: { lat: number; lng: number; landmark?: string };
  mileageKm: number;
}) {
  return {
    RegNo: args.registrationNumber ?? "APL-079",
    IGON_RDT: `/Date(${args.startedAt})/`,
    IGON_LAT: String(args.start.lat),
    IGON_LON: String(args.start.lng),
    IGON_LandMark: args.start.landmark ?? "0 Start",
    IGOFF_RDT: `/Date(${args.endedAt})/`,
    IGOFF_LAT: String(args.end.lat),
    IGOFF_LON: String(args.end.lng),
    IGOFF_LandMark: args.end.landmark ?? "0 End",
    Mileage: String(args.mileageKm),
    TravelTimeS: "600",
    MaxSpeed: "40",
    AvgSpeed: "20.0 km/hr",
  };
}

async function connect(f: Fixture, vehicles: Record<string, unknown>[]) {
  trackerVehicles = vehicles;
  installTrackerStub();
  await f.asUser("adminA").action(api.fleet.connect, {
    companyId: f.companyA,
    secretKey: "test-key-6789",
  });
}

async function vehicleIdOf(f: Fixture, registrationNumber = "APL-079") {
  const result = await f.asUser("adminA").query(api.fleet.listVehicles, {
    companyId: f.companyA,
    now: Date.now(),
  });
  const vehicle = result.vehicles.find((row) => row.registrationNumber === registrationNumber);
  if (!vehicle) throw new Error("vehicle missing");
  return vehicle._id;
}

async function driverIdOf(f: Fixture, name = "Bilal") {
  return await f.asUser("adminA").mutation(api.fleet.createDriver, {
    companyId: f.companyA,
    name,
  });
}

async function insertTrackerTrip(
  f: Fixture,
  vehicleId: Id<"fleetVehicles">,
  args: {
    startedAt: number;
    endedAt: number;
    distanceMeters: number;
    startLat?: number;
    startLng?: number;
    startLandmark?: string;
    endLat?: number;
    endLng?: number;
    endLandmark?: string;
  },
) {
  return await f.t.run((ctx) =>
    ctx.db.insert("fleetTrackerTrips", {
      companyId: f.companyA,
      vehicleId,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      ...(args.startLat !== undefined ? { startLat: args.startLat } : {}),
      ...(args.startLng !== undefined ? { startLng: args.startLng } : {}),
      ...(args.startLandmark ? { startLandmark: args.startLandmark } : {}),
      ...(args.endLat !== undefined ? { endLat: args.endLat } : {}),
      ...(args.endLng !== undefined ? { endLng: args.endLng } : {}),
      ...(args.endLandmark ? { endLandmark: args.endLandmark } : {}),
      distanceMeters: args.distanceMeters,
      travelSeconds: 600,
      maxSpeedKmh: 40,
      createdAt: pinnedNow,
      updatedAt: pinnedNow,
    }),
  );
}


async function createPlace(
  f: Fixture,
  args: {
    name: string;
    kind: "base" | "destination";
    lat: number;
    lng: number;
    radiusMeters?: number;
  },
) {
  return await f.asUser("adminA").mutation(api.fleetPlaces.createPlace, {
    companyId: f.companyA,
    ...args,
  });
}

async function reconcile(f: Fixture, vehicleId: Id<"fleetVehicles">, now = Date.now()) {
  await f.t.mutation(internal.fleetMonitoring.reconcileVehicle, {
    companyId: f.companyA,
    vehicleId,
    now,
  });
}

describe("tracker trip ingestion", () => {
  test("ingests idempotently and skips segments under 200 metres", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);

    trackerTrips = [
      rawTrackerTrip({
        startedAt: pinnedNow - 3 * HOUR,
        endedAt: pinnedNow - 2 * HOUR,
        start: { lat: 31.4623, lng: 74.458, landmark: "0 Depot" },
        end: { lat: 31.46, lng: 74.46, landmark: "1 Saggian Plant" },
        mileageKm: 1.7,
      }),
      rawTrackerTrip({
        startedAt: pinnedNow - 2 * HOUR,
        endedAt: pinnedNow - 2 * HOUR + 5 * MINUTE,
        start: { lat: 31.46, lng: 74.46 },
        end: { lat: 31.46, lng: 74.461 },
        mileageKm: 0.1,
      }),
    ];

    await f.t.action(internal.fleetMonitoring.ingestTrackerTrips, {});
    await f.t.action(internal.fleetMonitoring.ingestTrackerTrips, {});

    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("fleetTrackerTrips")
        .withIndex("by_vehicleId_and_startAt", (q) => q.eq("vehicleId", vehicleId))
        .take(10),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      distanceMeters: 1_700,
      startLandmark: "Depot",
      endLandmark: "Saggian Plant",
    });

    const alerts = await f.t.run((ctx) => ctx.db.query("fleetAlerts").take(10));
    expect(alerts).toHaveLength(1);
  });
});

describe("fleet places", () => {
  test("suggests frequent un-covered stop clusters and enforces unique names", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);

    const saved = await createPlace(f, {
      name: "Warehouse",
      kind: "base",
      lat: 31.4623,
      lng: 74.458,
    });
    const coveredPoint = { lat: 31.4623, lng: 74.458 };
    const suggestedPoint = { lat: 31.6, lng: 74.4 };
    const onceOnlyPoint = { lat: 31.7, lng: 74.5 };

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 5 * HOUR,
      endedAt: pinnedNow - 4 * HOUR,
      distanceMeters: 5_000,
      endLat: coveredPoint.lat,
      endLng: coveredPoint.lng,
      endLandmark: "Warehouse",
    });
    for (const offset of [3, 2]) {
      await insertTrackerTrip(f, vehicleId, {
        startedAt: pinnedNow - offset * HOUR,
        endedAt: pinnedNow - offset * HOUR + 30 * MINUTE,
        distanceMeters: 8_000,
        endLat: suggestedPoint.lat,
        endLng: suggestedPoint.lng,
        endLandmark: "Saggian Plant",
      });
    }
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - HOUR,
      endedAt: pinnedNow - 30 * MINUTE,
      distanceMeters: 9_000,
      endLat: onceOnlyPoint.lat,
      endLng: onceOnlyPoint.lng,
      endLandmark: "Once only",
    });

    const suggestions = await f.asUser("adminA").query(api.fleetPlaces.suggestPlaces, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(suggestions.suggestions).toHaveLength(1);
    expect(suggestions.suggestions[0]).toMatchObject({
      lat: suggestedPoint.lat,
      lng: suggestedPoint.lng,
      address: "Saggian Plant",
      visitCount: 2,
    });

    await expect(
      createPlace(f, { name: "  warehouse  ", kind: "destination", lat: 31.5, lng: 74.3 }),
    ).rejects.toThrow("A place with this name already exists.");

    await f.asUser("adminA").mutation(api.fleetPlaces.setPlaceArchived, {
      companyId: f.companyA,
      placeId: saved,
      archived: true,
    });
    const active = await f.asUser("adminA").query(api.fleetPlaces.listPlaces, {
      companyId: f.companyA,
    });
    expect(active.places.map((place) => place.name)).not.toContain("Warehouse");
    const all = await f.asUser("adminA").query(api.fleetPlaces.listPlaces, {
      companyId: f.companyA,
      includeArchived: true,
    });
    expect(all.places.map((place) => place.name)).toContain("Warehouse");
  });
});

describe("unlogged movement alerts", () => {
  test("groups consecutive outings and respects the per-vehicle toggle", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 3 * HOUR,
      endedAt: pinnedNow - 2 * HOUR - 50 * MINUTE,
      distanceMeters: 1_500,
      startLandmark: "Depot",
      endLat: 31.47,
      endLng: 74.47,
      endLandmark: "Market",
    });
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 2 * HOUR - 40 * MINUTE,
      endedAt: pinnedNow - 2 * HOUR - 30 * MINUTE,
      distanceMeters: 1_200,
      startLandmark: "Market",
      endLat: 31.48,
      endLng: 74.48,
      endLandmark: "Bank",
    });
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 90 * MINUTE,
      endedAt: pinnedNow - 80 * MINUTE,
      distanceMeters: 1_100,
      startLandmark: "Bank",
      endLat: 31.49,
      endLng: 74.49,
      endLandmark: "Depot",
    });
    await reconcile(f, vehicleId);

    const feed = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    const outings = feed.alerts.filter((alert) => alert.kind === "unlogged_movement");
    expect(outings).toHaveLength(2);
    expect(outings.find((alert) => alert.distanceMeters === 2_700)).toMatchObject({
      source: "event",
      status: "open",
      fromAddress: "Depot",
      toAddress: "Bank",
      distanceMeters: 2_700,
    });

    await f.asUser("adminA").mutation(api.fleetMonitoring.setVehicleTripLogging, {
      companyId: f.companyA,
      vehicleId,
      requiresTripLogging: false,
    });

    const openAfter = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(openAfter.alerts.filter((alert) => alert.kind === "unlogged_movement")).toHaveLength(0);

    const resolved = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
      status: "resolved",
    });
    expect(
      resolved.alerts.filter((alert) => alert.kind === "unlogged_movement"),
    ).toHaveLength(2);
  });

  test("a logged trip within the 15-minute buffer covers tracker segments", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 3 * HOUR,
      endedAt: pinnedNow - 2 * HOUR - 50 * MINUTE,
      distanceMeters: 1_500,
      startLandmark: "Depot",
      endLandmark: "Market",
    });
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - HOUR,
      endedAt: pinnedNow - 50 * MINUTE,
      distanceMeters: 1_200,
      startLandmark: "Market",
      endLandmark: "Bank",
    });
    await f.t.run((ctx) =>
      ctx.db.insert("fleetTrips", {
        companyId: f.companyA,
        vehicleId,
        driverId,
        destination: "Market",
        status: "returned",
        departedAt: pinnedNow - 3 * HOUR - 5 * MINUTE,
        returnedAt: pinnedNow - 2 * HOUR - 40 * MINUTE,
        createdByMembershipId: f.adminM,
        createdAt: pinnedNow,
        updatedAt: pinnedNow,
      }),
    );

    await reconcile(f, vehicleId);

    const alerts = await f.t.run((ctx) =>
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicleId))
        .take(10),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "unlogged_movement",
      distanceMeters: 1_200,
      fromAddress: "Market",
      toAddress: "Bank",
    });
  });
});

describe("trip detection", () => {
  test("arrival, automatic return and actual distance come from tracker trips", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 31.4623, lng: 74.458 };
    const destination = { lat: 31.5934, lng: 74.2611 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Warehouse", kind: "base", ...base });
    const destinationPlaceId = await createPlace(f, {
      name: "Saggian Plant",
      kind: "destination",
      ...destination,
    });

    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: destinationPlaceId,
      departedAt: pinnedNow,
    });
    const tripAfterStart = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(tripAfterStart).toMatchObject({
      status: "open",
      placeId: destinationPlaceId,
      startLat: base.lat,
      startLng: base.lng,
    });
    const basePlaceId = tripAfterStart?.basePlaceId;
    expect(basePlaceId).toBeDefined();

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 5 * MINUTE,
      endedAt: pinnedNow + 30 * MINUTE,
      distanceMeters: 16_000,
      startLat: base.lat,
      startLng: base.lng,
      endLat: destination.lat,
      endLng: destination.lng,
      endLandmark: "Saggian Plant",
    });
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 40 * MINUTE,
      endedAt: pinnedNow + 70 * MINUTE,
      distanceMeters: 16_000,
      startLat: destination.lat,
      startLng: destination.lng,
      endLat: base.lat,
      endLng: base.lng,
      endLandmark: "Warehouse",
    });

    await reconcile(f, vehicleId, pinnedNow + 2 * HOUR);

    // Refresh the live sync so the derived "sync failing" alert does not
    // distract from this test's KPIs.
    vi.setSystemTime(pinnedNow + 2 * HOUR);
    await f.asUser("adminA").action(api.fleet.syncNow, { companyId: f.companyA });

    const trip = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(trip).toMatchObject({
      status: "returned",
      arrivedAt: pinnedNow + 30 * MINUTE,
      returnedAt: pinnedNow + 70 * MINUTE,
      autoReturned: true,
      actualDistanceMeters: 32_000,
    });

    const overview = await f.asUser("adminA").query(api.fleetDashboard.overview, {
      companyId: f.companyA,
      now: pinnedNow + 2 * HOUR,
    });
    expect(overview.kpis).toMatchObject({
      onTrip: 0,
      kmToday: 32,
      tripsToday: 1,
      openAlerts: 0,
    });
    expect(overview.vehicleBoard[0]).toMatchObject({
      registrationNumber: "APL-079",
      status: "parked",
      place: { name: "Warehouse" },
    });

    const activity = await f.asUser("adminA").query(api.fleetDashboard.activity, {
      companyId: f.companyA,
      now: pinnedNow + 2 * HOUR,
    });
    expect(activity.kmLast7Days.reduce((sum, day) => sum + day.km, 0)).toBe(32);
    expect(activity.tripsByDestination[0]).toMatchObject({
      destination: "Saggian Plant",
      count: 1,
    });

    const timeline = await f.asUser("adminA").query(api.fleetDashboard.vehicleTimeline, {
      companyId: f.companyA,
      vehicleId,
      now: pinnedNow + 2 * HOUR,
      days: 7,
    });
    const today = timeline.days[0];
    expect(today.trackerTrips).toHaveLength(2);
    expect(today.loggedTrips).toHaveLength(1);
    expect((today.trackerTrips[0] as { matchedTripId: string }).matchedTripId).toBe(
      started.tripId,
    );
  });

  test("an off-route point raises one alert whose max deviation keeps growing", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 0, lng: 0 };
    const destination = { lat: 0, lng: 0.02 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Warehouse", kind: "base", ...base });
    const destinationPlaceId = await createPlace(f, {
      name: "Destination",
      kind: "destination",
      ...destination,
    });

    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: destinationPlaceId,
      departedAt: pinnedNow,
    });

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 5 * MINUTE,
      endedAt: pinnedNow + 30 * MINUTE,
      distanceMeters: 6_000,
      startLat: base.lat,
      startLng: base.lng,
      endLat: 0.05,
      endLng: 0.01,
      endLandmark: "Far point",
    });
    await reconcile(f, vehicleId, pinnedNow + HOUR);

    const firstAlerts = await f.t.run((ctx) =>
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicleId))
        .take(10),
    );
    expect(firstAlerts).toHaveLength(1);
    expect(firstAlerts[0]).toMatchObject({
      kind: "off_route",
      status: "open",
      address: "Far point",
    });
    const firstDeviation = firstAlerts[0].maxDeviationMeters ?? 0;
    expect(firstDeviation).toBeGreaterThan(3_000);

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 35 * MINUTE,
      endedAt: pinnedNow + 45 * MINUTE,
      distanceMeters: 8_000,
      startLat: 0.05,
      startLng: 0.01,
      endLat: 0.08,
      endLng: 0.01,
      endLandmark: "Farther point",
    });
    await reconcile(f, vehicleId, pinnedNow + HOUR);

    const secondAlerts = await f.t.run((ctx) =>
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicleId))
        .take(10),
    );
    expect(secondAlerts).toHaveLength(1);
    expect(secondAlerts[0].maxDeviationMeters ?? 0).toBeGreaterThan(firstDeviation);
    expect(secondAlerts[0].address).toBe("Farther point");

    const trip = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(trip?.maxDeviationMeters ?? 0).toBeGreaterThan(firstDeviation);
    expect(trip?.status).toBe("open");
  });
});

describe("overdue trips", () => {
  test("raises an alert after 12 hours and resolves it when the trip returns", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);

    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      destination: "Long errand",
      departedAt: pinnedNow - 13 * HOUR,
    });

    await f.t.mutation(internal.fleetMonitoring.checkOverdueTrips, {});
    const open = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(open.alerts.filter((alert) => alert.kind === "trip_overdue")).toHaveLength(1);
    expect(open.alerts[0]).toMatchObject({ severity: "critical", status: "open" });

    await f.asUser("adminA").action(api.fleet.returnTrip, {
      companyId: f.companyA,
      tripId: started.tripId,
      returnedAt: pinnedNow - 11 * HOUR,
    });

    const after = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(after.alerts.filter((alert) => alert.kind === "trip_overdue")).toHaveLength(0);

    const resolved = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
      status: "resolved",
    });
    expect(
      resolved.alerts.filter((alert) => alert.kind === "trip_overdue"),
    ).toHaveLength(1);
  });
});

describe("alert actions", () => {
  test("logging an outing as a trip creates a returned trip and resolves the alert", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 2 * HOUR,
      endedAt: pinnedNow - 110 * MINUTE,
      distanceMeters: 1_500,
      startLandmark: "Depot",
      endLat: 31.47,
      endLng: 74.47,
      endLandmark: "Market",
    });
    await reconcile(f, vehicleId);

    const feed = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    const alert = feed.alerts.find((row) => row.kind === "unlogged_movement");
    expect(alert?._id).toBeTruthy();

    const result = await f.asUser("adminA").mutation(
      api.fleetMonitoring.logUnloggedAlertAsTrip,
      {
        companyId: f.companyA,
        alertId: alert!._id!,
        driverId,
        destination: "Market",
      },
    );
    const trip = await f.t.run((ctx) => ctx.db.get(result.tripId));
    expect(trip).toMatchObject({
      vehicleId,
      driverId,
      destination: "Market",
      status: "returned",
      departedAt: pinnedNow - 2 * HOUR,
      returnedAt: pinnedNow - 110 * MINUTE,
      actualDistanceMeters: 1_500,
    });

    const resolved = await f.asUser("adminA").query(api.fleetMonitoring.alertsFeed, {
      companyId: f.companyA,
      now: pinnedNow,
      status: "resolved",
    });
    expect(resolved.alerts[0]).toMatchObject({
      kind: "unlogged_movement",
      status: "resolved",
      resolutionNote: "Logged as a trip.",
      resolvedByName: "Admin A",
    });

    await expect(
      f.asUser("adminA").mutation(api.fleetMonitoring.logUnloggedAlertAsTrip, {
        companyId: f.companyA,
        alertId: alert!._id!,
        driverId,
        destination: "Market",
      }),
    ).rejects.toThrow("This alert is already resolved.");
  });
});


async function patchVehicleReading(
  f: Fixture,
  vehicleId: Id<"fleetVehicles">,
  args: {
    lat: number;
    lng: number;
    recordedAt: number;
    address?: string;
    odometerMeters?: number;
  },
) {
  await f.t.run((ctx) =>
    ctx.db.patch(vehicleId, {
      lat: args.lat,
      lng: args.lng,
      speed: 0,
      ignitionOn: false,
      recordedAt: args.recordedAt,
      ...(args.address ? { address: args.address } : {}),
      ...(args.odometerMeters !== undefined
        ? { odometerMeters: args.odometerMeters }
        : {}),
      updatedAt: args.recordedAt,
    }),
  );
}

async function alertsForVehicle(
  f: Fixture,
  vehicleId: Id<"fleetVehicles">,
  kind?: "unlogged_movement" | "off_route" | "trip_overdue",
) {
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("fleetAlerts")
      .withIndex("by_vehicleId_and_occurredAt", (q) => q.eq("vehicleId", vehicleId))
      .order("desc")
      .take(50),
  );
  return kind ? rows.filter((row) => row.kind === kind) : rows;
}

describe("review regressions", () => {
  test("facts are filled for a trip returned before the next sync, without closing it again", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 31.4623, lng: 74.458 };
    const destination = { lat: 31.5934, lng: 74.2611 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Warehouse", kind: "base", ...base });
    const destinationPlaceId = await createPlace(f, {
      name: "Saggian Plant",
      kind: "destination",
      ...destination,
    });

    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: destinationPlaceId,
      departedAt: pinnedNow,
    });
    await f.asUser("adminA").action(api.fleet.returnTrip, {
      companyId: f.companyA,
      tripId: started.tripId,
      returnedAt: pinnedNow + 30 * MINUTE,
    });

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 5 * MINUTE,
      endedAt: pinnedNow + 20 * MINUTE,
      distanceMeters: 16_000,
      startLat: base.lat,
      startLng: base.lng,
      endLat: destination.lat,
      endLng: destination.lng,
      endLandmark: "Saggian Plant",
    });

    await reconcile(f, vehicleId, pinnedNow + HOUR);

    const trip = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(trip).toMatchObject({
      status: "returned",
      returnedAt: pinnedNow + 30 * MINUTE,
      arrivedAt: pinnedNow + 20 * MINUTE,
    });
    expect(trip?.autoReturned ?? false).toBe(false);
    expect(trip?.maxDeviationMeters).toBeDefined();
    expect(trip?.maxDeviationMeters ?? 1_000).toBeLessThan(50);
  });

  test("a detour followed by arrival is flagged in the same reconcile pass", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 0, lng: 0 };
    const destination = { lat: 0, lng: 0.02 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Warehouse", kind: "base", ...base });
    const destinationPlaceId = await createPlace(f, {
      name: "Destination",
      kind: "destination",
      ...destination,
    });
    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: destinationPlaceId,
      departedAt: pinnedNow,
    });

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 5 * MINUTE,
      endedAt: pinnedNow + 15 * MINUTE,
      distanceMeters: 6_000,
      startLat: base.lat,
      startLng: base.lng,
      endLat: 0.05,
      endLng: 0.01,
      endLandmark: "Far point",
    });
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow + 20 * MINUTE,
      endedAt: pinnedNow + 30 * MINUTE,
      distanceMeters: 5_000,
      startLat: 0.05,
      startLng: 0.01,
      endLat: destination.lat,
      endLng: destination.lng,
      endLandmark: "Destination",
    });

    await reconcile(f, vehicleId, pinnedNow + HOUR);

    const trip = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(trip).toMatchObject({ status: "open", arrivedAt: pinnedNow + 30 * MINUTE });
    expect(trip?.maxDeviationMeters ?? 0).toBeGreaterThan(3_000);
    const offRoute = await alertsForVehicle(f, vehicleId, "off_route");
    expect(offRoute).toHaveLength(1);
    expect(offRoute[0]).toMatchObject({ address: "Far point", status: "open" });
  });

  test("a live reading at the destination base does not close a base-to-base trip in the same pass", async () => {
    const f = await createAuthzFixture();
    const baseA = { lat: 31.4623, lng: 74.458 };
    const baseB = { lat: 31.5934, lng: 74.2611 };
    await connect(f, [rawVehicle("APL-079", baseA.lat, baseA.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Base A", kind: "base", ...baseA });
    const baseBPlaceId = await createPlace(f, { name: "Base B", kind: "base", ...baseB });

    const started = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: baseBPlaceId,
      departedAt: pinnedNow,
    });

    await patchVehicleReading(f, vehicleId, {
      lat: baseB.lat,
      lng: baseB.lng,
      recordedAt: pinnedNow + 30 * MINUTE,
      address: "Base B",
    });
    await f.t.mutation(internal.fleetMonitoring.reconcileLivePositions, {
      companyId: f.companyA,
      now: pinnedNow + 30 * MINUTE,
    });

    const afterArrival = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(afterArrival).toMatchObject({
      status: "open",
      arrivedAt: pinnedNow + 30 * MINUTE,
    });
    expect(afterArrival?.returnedAt).toBeUndefined();

    await patchVehicleReading(f, vehicleId, {
      lat: baseB.lat,
      lng: baseB.lng,
      recordedAt: pinnedNow + 40 * MINUTE,
      address: "Base B",
    });
    await f.t.mutation(internal.fleetMonitoring.reconcileLivePositions, {
      companyId: f.companyA,
      now: pinnedNow + 40 * MINUTE,
    });

    const afterReturn = await f.t.run((ctx) => ctx.db.get(started.tripId));
    expect(afterReturn).toMatchObject({
      status: "returned",
      returnedAt: pinnedNow + 40 * MINUTE,
      autoReturned: true,
    });
  });

  test("editing the departure time clears derived arrival and deviation", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 31.4623, lng: 74.458 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    const basePlaceId = await createPlace(f, {
      name: "Warehouse",
      kind: "base",
      ...base,
    });
    const destinationPlaceId = await createPlace(f, {
      name: "Destination",
      kind: "destination",
      lat: 31.6,
      lng: 74.4,
    });
    const tripId = await f.t.run((ctx) =>
      ctx.db.insert("fleetTrips", {
        companyId: f.companyA,
        vehicleId,
        driverId,
        destination: "Destination",
        placeId: destinationPlaceId,
        basePlaceId,
        status: "open",
        departedAt: pinnedNow - 2 * HOUR,
        arrivedAt: pinnedNow - HOUR,
        maxDeviationMeters: 4_000,
        startLat: base.lat,
        startLng: base.lng,
        createdByMembershipId: f.adminM,
        createdAt: pinnedNow,
        updatedAt: pinnedNow,
      }),
    );

    await f.asUser("adminA").mutation(api.fleet.updateTrip, {
      companyId: f.companyA,
      tripId,
      departedAt: pinnedNow - 3 * HOUR,
    });

    const trip = await f.t.run((ctx) => ctx.db.get(tripId));
    expect(trip?.departedAt).toBe(pinnedNow - 3 * HOUR);
    expect(trip?.arrivedAt).toBeUndefined();
    expect(trip?.maxDeviationMeters).toBeUndefined();
    expect(trip?.basePlaceId).toBeUndefined();
    expect(trip?.startLat).toBeUndefined();
    expect(trip?.startLng).toBeUndefined();

    // Changing the destination place also invalidates the old corridor facts.
    await f.t.run((ctx) =>
      ctx.db.patch(tripId, {
        arrivedAt: pinnedNow - HOUR,
        maxDeviationMeters: 4_000,
        basePlaceId,
      }),
    );
    const otherPlaceId = await createPlace(f, {
      name: "Other destination",
      kind: "destination",
      lat: 31.61,
      lng: 74.41,
    });
    await f.asUser("adminA").mutation(api.fleet.updateTrip, {
      companyId: f.companyA,
      tripId,
      placeId: otherPlaceId,
    });
    const moved = await f.t.run((ctx) => ctx.db.get(tripId));
    expect(moved?.placeId).toBe(otherPlaceId);
    expect(moved?.arrivedAt).toBeUndefined();
    expect(moved?.maxDeviationMeters).toBeUndefined();
    expect(moved?.basePlaceId).toBeUndefined();
  });

  test("returning or deleting a trip resolves its overdue alert", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);

    const first = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      destination: "Long errand A",
      departedAt: pinnedNow - 13 * HOUR,
    });
    await f.t.mutation(internal.fleetMonitoring.checkOverdueTrips, {});
    await f.asUser("adminA").mutation(api.fleet.updateTrip, {
      companyId: f.companyA,
      tripId: first.tripId,
      returnedAt: pinnedNow - 11 * HOUR,
    });
    const firstAlerts = await f.t.run((ctx) =>
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_tripId", (q) => q.eq("tripId", first.tripId))
        .take(10),
    );
    expect(firstAlerts).toHaveLength(1);
    expect(firstAlerts[0]).toMatchObject({
      kind: "trip_overdue",
      status: "resolved",
      resolutionNote: "The trip was returned.",
    });

    const second = await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      destination: "Long errand B",
      departedAt: pinnedNow - 13 * HOUR,
    });
    await f.t.mutation(internal.fleetMonitoring.checkOverdueTrips, {});
    await f.asUser("adminA").mutation(api.fleet.deleteTrip, {
      companyId: f.companyA,
      tripId: second.tripId,
    });
    const secondAlerts = await f.t.run((ctx) =>
      ctx.db
        .query("fleetAlerts")
        .withIndex("by_tripId", (q) => q.eq("tripId", second.tripId))
        .take(10),
    );
    expect(secondAlerts).toHaveLength(1);
    expect(secondAlerts[0]).toMatchObject({
      kind: "trip_overdue",
      status: "resolved",
      resolutionNote: "Trip deleted.",
    });
  });

  test("a smaller off-route deviation does not move or rewrite the alert", async () => {
    const f = await createAuthzFixture();
    const base = { lat: 0, lng: 0 };
    const destination = { lat: 0, lng: 0.02 };
    await connect(f, [rawVehicle("APL-079", base.lat, base.lng)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    await createPlace(f, { name: "Warehouse", kind: "base", ...base });
    const destinationPlaceId = await createPlace(f, {
      name: "Destination",
      kind: "destination",
      ...destination,
    });
    await f.asUser("adminA").action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId,
      driverId,
      placeId: destinationPlaceId,
      departedAt: pinnedNow,
    });

    await patchVehicleReading(f, vehicleId, {
      lat: 0.05,
      lng: 0.01,
      recordedAt: pinnedNow + 10 * MINUTE,
      address: "Far A",
    });
    await f.t.mutation(internal.fleetMonitoring.reconcileLivePositions, {
      companyId: f.companyA,
      now: pinnedNow + 10 * MINUTE,
    });
    const first = (await alertsForVehicle(f, vehicleId, "off_route"))[0];
    expect(first.address).toBe("Far A");
    expect(first.maxDeviationMeters ?? 0).toBeGreaterThan(5_000);

    await patchVehicleReading(f, vehicleId, {
      lat: 0.035,
      lng: 0.01,
      recordedAt: pinnedNow + 20 * MINUTE,
      address: "Near B",
    });
    await f.t.mutation(internal.fleetMonitoring.reconcileLivePositions, {
      companyId: f.companyA,
      now: pinnedNow + 20 * MINUTE,
    });
    const second = (await alertsForVehicle(f, vehicleId, "off_route"))[0];
    expect(second._id).toBe(first._id);
    expect(second.maxDeviationMeters).toBe(first.maxDeviationMeters);
    expect(second.address).toBe("Far A");
    expect(second.summary).toBe(first.summary);
    expect(second.lat).toBe(first.lat);
    expect(second.lng).toBe(first.lng);
  });

  test("a reviewed outing is not duplicated when an earlier segment arrives", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 2 * HOUR,
      endedAt: pinnedNow - 110 * MINUTE,
      distanceMeters: 1_500,
      startLandmark: "Depot",
      endLat: 31.47,
      endLng: 74.47,
      endLandmark: "Market",
    });
    await reconcile(f, vehicleId);
    const initial = await alertsForVehicle(f, vehicleId, "unlogged_movement");
    expect(initial).toHaveLength(1);

    await f.asUser("adminA").mutation(api.fleetMonitoring.resolveAlert, {
      companyId: f.companyA,
      alertId: initial[0]._id,
      note: "Approved personal use",
    });

    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 140 * MINUTE,
      endedAt: pinnedNow - 130 * MINUTE,
      distanceMeters: 1_000,
      startLandmark: "Depot",
      endLat: 31.47,
      endLng: 74.47,
      endLandmark: "Market",
    });
    await reconcile(f, vehicleId);

    const after = await alertsForVehicle(f, vehicleId, "unlogged_movement");
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(initial[0]._id);
    expect(after[0].status).toBe("resolved");
  });

  test("starting with a deleted place fails instead of silently becoming a text trip", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);
    const placeId = await createPlace(f, {
      name: "Deleted place",
      kind: "destination",
      lat: 31.5,
      lng: 74.3,
    });
    await f.t.run((ctx) => ctx.db.delete(placeId));

    await expect(
      f.asUser("adminA").action(api.fleet.startTrip, {
        companyId: f.companyA,
        vehicleId,
        driverId,
        placeId,
      }),
    ).rejects.toThrow("Place not found.");
  });

  test("an open trip older than the 48-hour tracker window keeps its actual distance", async () => {
    const f = await createAuthzFixture();
    await connect(f, [rawVehicle("APL-079", 31.4623, 74.458)]);
    const vehicleId = await vehicleIdOf(f);
    const driverId = await driverIdOf(f);

    const tripId = await f.t.run((ctx) =>
      ctx.db.insert("fleetTrips", {
        companyId: f.companyA,
        vehicleId,
        driverId,
        destination: "Long haul",
        status: "open",
        departedAt: pinnedNow - 60 * HOUR,
        actualDistanceMeters: 5_000,
        createdByMembershipId: f.adminM,
        createdAt: pinnedNow - 60 * HOUR,
        updatedAt: pinnedNow - 60 * HOUR,
      }),
    );
    await insertTrackerTrip(f, vehicleId, {
      startedAt: pinnedNow - 20 * HOUR,
      endedAt: pinnedNow - 19 * HOUR,
      distanceMeters: 1_000,
    });

    await reconcile(f, vehicleId, pinnedNow);

    const trip = await f.t.run((ctx) => ctx.db.get(tripId));
    expect(trip?.actualDistanceMeters).toBe(5_000);
  });
});

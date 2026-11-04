/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";

const DAY_MS = 86_400_000;
const pinnedNow = Date.UTC(2026, 10, 4, 12);
const trackerEnvelope =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><TWPXCC_GetVDataResponse xmlns="http://tempuri.org/" /></soap:Body></soap:Envelope>';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(pinnedNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function trackerBody(vehicles: unknown[]) {
  return `${JSON.stringify({ responseCode: 200, responseMsg: "Sucessful", _vehicleData: vehicles })}${trackerEnvelope}`;
}

function rawVehicle(
  registrationNumber: string,
  odometer: number,
  extra: Record<string, unknown> = {},
) {
  return {
    RegistrationNumber: registrationNumber,
    Latitude: "31.5894083",
    Longitude: "74.320345",
    Speed: 0,
    Direction: "SW",
    Odometer: odometer,
    LastIgnitionStatus: "False",
    LastIgnitionStatusDateTime: "/Date(1793785727000)/",
    Address: "Badami Bagh, Lahore",
    RecordDateTime: "/Date(1793785727000)/",
    DirectionDegree: 243,
    Reason: "Ignition Off",
    ...extra,
  };
}

function stubTracker(vehicles: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(trackerBody(vehicles), { status: 200 })),
  );
}

function stubTrackerDown() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network unreachable");
    }),
  );
}

function stubTrackerRejected() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({
            responseCode: 402,
            responseMsg: "No Data found. Please check and verify your Secret Key",
            _vehicleData: null,
          })}${trackerEnvelope}`,
          { status: 200 },
        ),
    ),
  );
}

function stubTrackerEmpty() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({
            responseCode: 200,
            responseMsg: "Sucessful",
            _vehicleData: null,
          })}${trackerEnvelope}`,
          { status: 200 },
        ),
    ),
  );
}

async function connectVehicles(
  f: Awaited<ReturnType<typeof createAuthzFixture>>,
  vehicles: unknown[],
) {
  stubTracker(vehicles);
  return await f.asUser("adminA").action(api.fleet.connect, {
    companyId: f.companyA,
    secretKey: "test-key-6789",
  });
}

async function vehicleIdsByName(f: Awaited<ReturnType<typeof createAuthzFixture>>) {
  const result = await f.asUser("adminA").query(api.fleet.listVehicles, {
    companyId: f.companyA,
    now: Date.now(),
  });
  return new Map(result.vehicles.map((vehicle) => [vehicle.registrationNumber, vehicle._id]));
}

describe("fleet tracker connection", () => {
  test("the key never leaves the server and a rejected key saves nothing", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");

    stubTrackerRejected();
    await expect(
      admin.action(api.fleet.connect, { companyId: f.companyA, secretKey: "bad-key-1234" }),
    ).rejects.toThrow("The tracker rejected this key.");

    const afterRejection = await admin.query(api.fleet.getConnection, { companyId: f.companyA });
    expect(afterRejection.connected).toBe(false);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("fleetTrackerConnections")
          .withIndex("by_company", (q) => q.eq("companyId", f.companyA))
          .first(),
      ),
    ).toBeNull();

    const secretKey = "ABCDEF0123456789";
    stubTracker([rawVehicle("APL-079", 50_906_028)]);
    const connected = await admin.action(api.fleet.connect, {
      companyId: f.companyA,
      secretKey,
    });
    expect(connected.keyHint).toBe("6789");

    const status = await admin.query(api.fleet.getConnection, { companyId: f.companyA });
    expect(status).toMatchObject({ connected: true, keyHint: "6789", vehicleCount: 1 });
    expect(status).not.toHaveProperty("secretKey");
    expect(JSON.stringify(status)).not.toContain(secretKey);

    const vehicles = await admin.query(api.fleet.listVehicles, {
      companyId: f.companyA,
      now: Date.now(),
    });
    expect(vehicles.vehicles).toHaveLength(1);
    expect(vehicles.vehicles[0]).toMatchObject({
      registrationNumber: "APL-079",
      odometerMeters: 50_906_028,
      odometerKm: 50_906.028,
      status: "parked",
      address: "Badami Bagh, Lahore",
    });
    expect(vehicles.vehicles[0].recordedAt).toBe(1_793_785_727_000);
  });
});

describe("fleet sync", () => {
  test("sync updates readings, preserves the display name, and marks and clears missing vehicles", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [rawVehicle("APL-079", 100_000_000), rawVehicle("LE-3166", 20_000_000)]);

    const ids = await vehicleIdsByName(f);
    await admin.mutation(api.fleet.renameVehicle, {
      companyId: f.companyA,
      vehicleId: ids.get("APL-079")!,
      displayName: "Truck One",
    });

    // Five minutes later: APL-079 has a newer reading; LE-3166 is absent.
    vi.setSystemTime(pinnedNow + 5 * 60_000);
    stubTracker([
      rawVehicle("APL-079", 100_500_000, {
        RecordDateTime: `/Date(${pinnedNow + 5 * 60_000})/`,
      }),
    ]);
    const synced = await admin.action(api.fleet.syncNow, { companyId: f.companyA });
    expect(synced).toMatchObject({ skipped: false, vehicleCount: 1, missingCount: 1 });

    const after = await admin.query(api.fleet.listVehicles, {
      companyId: f.companyA,
      now: Date.now(),
    });
    const apl = after.vehicles.find((vehicle) => vehicle.registrationNumber === "APL-079")!;
    expect(apl.displayName).toBe("Truck One");
    expect(apl.odometerMeters).toBe(100_500_000);
    expect(apl.missingFromTrackerAt).toBeNull();

    const le = after.vehicles.find((vehicle) => vehicle.registrationNumber === "LE-3166")!;
    expect(le.missingFromTrackerAt).toBe(pinnedNow + 5 * 60_000);
    expect(le.status).toBe("missing");

    // A later response that includes LE-3166 clears the missing marker.
    vi.setSystemTime(pinnedNow + 10 * 60_000);
    stubTracker([
      rawVehicle("APL-079", 100_500_000, {
        RecordDateTime: `/Date(${pinnedNow + 5 * 60_000})/`,
      }),
      rawVehicle("LE-3166", 20_000_000, {
        RecordDateTime: `/Date(${pinnedNow + 10 * 60_000})/`,
      }),
    ]);
    await admin.action(api.fleet.syncNow, { companyId: f.companyA });
    const reappeared = await admin.query(api.fleet.listVehicles, {
      companyId: f.companyA,
      now: Date.now(),
    });
    const leAgain = reappeared.vehicles.find(
      (vehicle) => vehicle.registrationNumber === "LE-3166",
    )!;
    expect(leAgain.missingFromTrackerAt).toBeNull();
    expect(leAgain.displayName).toBeNull();

    // An empty 200 response while vehicles exist is a failed sync: nothing is
    // marked missing and lastSyncAt does not advance.
    const successfulSyncAt = (
      await admin.query(api.fleet.getConnection, { companyId: f.companyA })
    ).lastSyncAt;
    vi.setSystemTime(pinnedNow + 15 * 60_000);
    stubTrackerEmpty();
    await expect(
      admin.action(api.fleet.syncNow, { companyId: f.companyA }),
    ).rejects.toThrow("The tracker returned no vehicles.");
    const afterEmpty = await admin.query(api.fleet.listVehicles, {
      companyId: f.companyA,
      now: Date.now(),
    });
    expect(afterEmpty.vehicles).toHaveLength(2);
    expect(afterEmpty.vehicles.every((vehicle) => vehicle.missingFromTrackerAt === null)).toBe(
      true,
    );
    const connectionAfterEmpty = await admin.query(api.fleet.getConnection, {
      companyId: f.companyA,
    });
    expect(connectionAfterEmpty.lastSyncAt).toBe(successfulSyncAt);
    expect(connectionAfterEmpty.lastSyncError).toBe(
      "The tracker returned no vehicles. Check the tracker key or try again.",
    );

    // Empty with no existing vehicles remains a successful connection.
    const companyBConnect = await f.asUser("adminB").action(api.fleet.connect, {
      companyId: f.companyB,
      secretKey: "empty-key-0000",
    });
    expect(companyBConnect).toMatchObject({ connected: true, vehicleCount: 0 });
    expect(
      await f.asUser("adminB").query(api.fleet.getConnection, { companyId: f.companyB }),
    ).toMatchObject({ connected: true, vehicleCount: 0 });
  });
});

describe("fleet trips", () => {
  test("trip start falls back to the last synced odometer, enforces one open trip, and derives distance", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [rawVehicle("APL-079", 100_000_000), rawVehicle("LE-3166", 20_000_000)]);
    const ids = await vehicleIdsByName(f);

    const bilal = await admin.mutation(api.fleet.createDriver, {
      companyId: f.companyA,
      name: "Bilal",
    });
    const sana = await admin.mutation(api.fleet.createDriver, {
      companyId: f.companyA,
      name: "Sana",
    });

    // Tracker is down: start still succeeds with the last synced reading.
    stubTrackerDown();
    const started = await admin.action(api.fleet.startTrip, {
      companyId: f.companyA,
      vehicleId: ids.get("APL-079")!,
      driverId: bilal,
      destination: "Lahore depot",
    });
    expect(started.startOdometerMeters).toBe(100_000_000);

    await expect(
      admin.action(api.fleet.startTrip, {
        companyId: f.companyA,
        vehicleId: ids.get("APL-079")!,
        driverId: sana,
        destination: "Second trip",
      }),
    ).rejects.toThrow("This vehicle already has an open trip.");
    await expect(
      admin.action(api.fleet.startTrip, {
        companyId: f.companyA,
        vehicleId: ids.get("LE-3166")!,
        driverId: bilal,
        destination: "Second vehicle",
      }),
    ).rejects.toThrow("This driver is already on a trip.");

    // Tracker is back: returning captures the fresh odometer.
    stubTracker([
      rawVehicle("APL-079", 100_003_500, {
        RecordDateTime: `/Date(${pinnedNow + 60_000})/`,
      }),
      rawVehicle("LE-3166", 20_000_000, {
        RecordDateTime: `/Date(${pinnedNow + 60_000})/`,
      }),
    ]);
    const returned = await admin.action(api.fleet.returnTrip, {
      companyId: f.companyA,
      tripId: started.tripId,
    });
    expect(returned).toMatchObject({
      endOdometerMeters: 100_003_500,
      alreadyReturned: false,
    });

    const trips = await admin.query(api.fleet.listTrips, {
      companyId: f.companyA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(trips.page).toHaveLength(1);
    expect(trips.page[0]).toMatchObject({
      destination: "Lahore depot",
      status: "returned",
      startOdometerMeters: 100_000_000,
      endOdometerMeters: 100_003_500,
      distanceMeters: 3_500,
      distanceKm: 3.5,
      driver: { name: "Bilal" },
      vehicle: { registrationNumber: "APL-079" },
    });

    const open = await admin.query(api.fleet.listOpenTrips, { companyId: f.companyA });
    expect(open.trips).toEqual([]);

    // A repeated return is idempotent.
    const again = await admin.action(api.fleet.returnTrip, {
      companyId: f.companyA,
      tripId: started.tripId,
    });
    expect(again.alreadyReturned).toBe(true);
  });
});

describe("fleet maintenance", () => {
  test("service due status derives overdue, due soon, unknown, and not configured from intervals", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [
      rawVehicle("APL-079", 54_600_000),
      rawVehicle("LE-3166", 55_100_000),
      rawVehicle("APR-079", 10_000_000),
      rawVehicle("LES-6714", 20_000_000),
    ]);
    const ids = await vehicleIdsByName(f);

    for (const registrationNumber of ["APL-079", "LE-3166", "APR-079"]) {
      await admin.mutation(api.fleet.setServiceInterval, {
        companyId: f.companyA,
        vehicleId: ids.get(registrationNumber)!,
        serviceIntervalKm: 5_000,
        serviceIntervalDays: 30,
      });
    }
    await admin.mutation(api.fleet.createServiceEntry, {
      companyId: f.companyA,
      vehicleId: ids.get("APL-079")!,
      servicedAt: pinnedNow - 25 * DAY_MS,
      odometerMeters: 50_000_000,
      description: "Oil and filter",
    });
    await admin.mutation(api.fleet.createServiceEntry, {
      companyId: f.companyA,
      vehicleId: ids.get("LE-3166")!,
      servicedAt: pinnedNow - 3 * DAY_MS,
      odometerMeters: 50_000_000,
      description: "Brakes",
    });

    const status = await admin.query(api.fleet.maintenanceStatus, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    const byRegistration = new Map(
      status.rows.map((row) => [row.registrationNumber, row.serviceStatus]),
    );

    // 50,000 km service + 5,000 km interval = 55,000 km due; current is 54,600 km.
    expect(byRegistration.get("APL-079")).toMatchObject({
      status: "due_soon",
      nextDueOdometerMeters: 55_000_000,
      nextDueAt: pinnedNow + 5 * DAY_MS,
      kmRemaining: 400,
      daysRemaining: 5,
    });
    // The same interval is already 100 km past due.
    expect(byRegistration.get("LE-3166")).toMatchObject({
      status: "overdue",
      kmRemaining: -100,
    });
    // Interval configured, but no service has been logged.
    expect(byRegistration.get("APR-079")).toMatchObject({ status: "unknown" });
    // No interval configured at all.
    expect(byRegistration.get("LES-6714")).toMatchObject({ status: "not_configured" });

    expect(status.rows.map((row) => row.registrationNumber)).toEqual([
      "LE-3166",
      "APL-079",
      "APR-079",
      "LES-6714",
    ]);
  });
});

describe("fleet fuel", () => {
  test("full-to-full efficiency flags a fill-up below 75% of the median of its previous five", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [rawVehicle("APL-079", 102_300_000)]);
    const ids = await vehicleIdsByName(f);
    const vehicleId = ids.get("APL-079")!;

    // Hand-derived: four 500 km / 50 L fill-ups (10 km/L), then 300 km / 50 L (6 km/L).
    const odometers = [100_000_000, 100_500_000, 101_000_000, 101_500_000, 102_000_000, 102_300_000];
    await f.t.run(async (ctx) => {
      for (let index = 0; index < odometers.length; index += 1) {
        const photoStorageId = await ctx.storage.store(
          new Blob([`photo-${index}`], { type: "image/jpeg" }),
        );
        await ctx.db.insert("fleetFuelEntries", {
          companyId: f.companyA,
          vehicleId,
          filledAt: pinnedNow - (odometers.length - index) * 60_000,
          litres: 50,
          amount: 1_000,
          odometerMeters: odometers[index],
          photoStorageId,
          photoFileName: `fill-${index}.jpg`,
          photoContentType: "image/jpeg",
          photoSize: 7,
          createdByMembershipId: f.adminM,
          createdAt: pinnedNow,
          updatedAt: pinnedNow,
        });
      }
    });

    const list = await admin.query(api.fleet.listFuelEntries, {
      companyId: f.companyA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(list.page[0]).toMatchObject({ kmPerL: 6, anomaly: true });
    expect(list.page[1]).toMatchObject({ kmPerL: 10, anomaly: false });

    const insights = await admin.query(api.fleet.fuelInsights, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(insights.anomalies).toHaveLength(1);
    expect(insights.anomalies[0]).toMatchObject({
      entryId: list.page[0]._id,
      kmPerL: 6,
      medianKmPerL: 10,
    });
    expect(insights.fleet).toMatchObject({
      currentMonthSpend: 6_000,
      hasThreeMonthsHistory: false,
      spendSpike: false,
    });
  });

  test("three months of history makes a spiking current month visible and alerts", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [rawVehicle("APL-079", 102_500_000)]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.companyA, { timeZone: "UTC" });
    });
    const ids = await vehicleIdsByName(f);
    const vehicleId = ids.get("APL-079")!;

    // 4 Nov 2026 in UTC: Aug/Sep/Oct are the three complete previous months.
    const fills = [
      { filledAt: Date.UTC(2026, 5, 15, 12), amount: 500, odometerMeters: 100_000_000 },
      { filledAt: Date.UTC(2026, 7, 15, 12), amount: 1_000, odometerMeters: 100_500_000 },
      { filledAt: Date.UTC(2026, 8, 15, 12), amount: 1_000, odometerMeters: 101_000_000 },
      { filledAt: Date.UTC(2026, 9, 15, 12), amount: 1_000, odometerMeters: 101_500_000 },
      { filledAt: Date.UTC(2026, 10, 2, 12), amount: 2_000, odometerMeters: 102_000_000 },
    ];
    await f.t.run(async (ctx) => {
      for (let index = 0; index < fills.length; index += 1) {
        const storageId = await ctx.storage.store(
          new Blob([`spend-${index}`], { type: "image/jpeg" }),
        );
        await ctx.db.insert("fleetFuelEntries", {
          companyId: f.companyA,
          vehicleId,
          filledAt: fills[index].filledAt,
          litres: 50,
          amount: fills[index].amount,
          odometerMeters: fills[index].odometerMeters,
          photoStorageId: storageId,
          photoFileName: `spend-${index}.jpg`,
          photoContentType: "image/jpeg",
          photoSize: 8,
          createdByMembershipId: f.adminM,
          createdAt: pinnedNow,
          updatedAt: pinnedNow,
        });
      }
    });

    // Previous three complete months: Aug + Sep + Oct = 3,000, average 1,000.
    // Current month spend is 2,000, which is above 130% of 1,000.
    const insights = await admin.query(api.fleet.fuelInsights, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(insights.fleet).toMatchObject({
      currentMonthSpend: 2_000,
      previousMonthSpend: 1_000,
      previousThreeMonthAverage: 1_000,
      spendSpike: true,
      hasThreeMonthsHistory: true,
    });
    expect(insights.byVehicle).toHaveLength(1);
    expect(insights.byVehicle[0]).toMatchObject({
      vehicleId,
      currentMonthSpend: 2_000,
      previousThreeMonthAverage: 1_000,
      spendSpike: true,
      hasThreeMonthsHistory: true,
    });

    const alerts = await admin.query(api.fleet.alerts, {
      companyId: f.companyA,
      now: pinnedNow,
    });
    expect(
      alerts.alerts.some(
        (alert) => alert.kind === "fuel_spend_spike" && alert.vehicleId === vehicleId,
      ),
    ).toBe(true);
  });

  test("fuel photos must be images from a bound, unexpired upload claim", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    await connectVehicles(f, [rawVehicle("APL-079", 100_000_000)]);
    const ids = await vehicleIdsByName(f);
    const vehicleId = ids.get("APL-079")!;

    const rejectedPhotoError = "Attach a JPEG, PNG, WebP, HEIC, or HEIF image.";
    const rejectedUpload = await admin.mutation(api.fleet.generateUploadUrl, {
      companyId: f.companyA,
    });
    const textStorageId = await f.t.run((ctx) =>
      ctx.storage.store(new Blob(["not an image"], { type: "text/plain" })),
    );
    const rejectedBind = await admin.mutation(api.fleet.bindUploadClaim, {
      companyId: f.companyA,
      claimId: rejectedUpload.claimId,
      storageId: textStorageId,
    });
    expect(rejectedBind).toMatchObject({
      ok: false,
      error: rejectedPhotoError,
    });
    await expect(
      admin.mutation(api.fleet.createFuelEntry, {
        companyId: f.companyA,
        vehicleId,
        filledAt: pinnedNow,
        litres: 40,
        amount: 5_000,
        photo: { storageId: textStorageId, claimId: rejectedUpload.claimId, fileName: "note.txt" },
      }),
    ).rejects.toThrow(rejectedPhotoError);
    await admin.mutation(api.fleet.discardUpload, {
      companyId: f.companyA,
      claimId: rejectedUpload.claimId,
    });

    // SVG is image/* but is a stored-script vector, so it must be rejected.
    const svgUpload = await admin.mutation(api.fleet.generateUploadUrl, { companyId: f.companyA });
    const svgStorageId = await f.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["<svg/>"], { type: "image/svg+xml" }));
      await (ctx.db as unknown as { patch: (table: string, id: string, value: object) => Promise<void> }).patch(
        "_storage",
        storageId,
        { contentType: "image/svg+xml" },
      );
      return storageId;
    });
    expect(
      await admin.mutation(api.fleet.bindUploadClaim, {
        companyId: f.companyA,
        claimId: svgUpload.claimId,
        storageId: svgStorageId,
      }),
    ).toMatchObject({ ok: false, error: rejectedPhotoError });
    await admin.mutation(api.fleet.discardUpload, {
      companyId: f.companyA,
      claimId: svgUpload.claimId,
    });

    const upload = await admin.mutation(api.fleet.generateUploadUrl, { companyId: f.companyA });
    const imageStorageId = await f.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["image"], { type: "image/jpeg" }));
      // convex-test does not copy Blob.type into the _storage metadata row.
      await (ctx.db as unknown as { patch: (table: string, id: string, value: object) => Promise<void> }).patch(
        "_storage",
        storageId,
        { contentType: "image/jpeg" },
      );
      return storageId;
    });
    const bound = await admin.mutation(api.fleet.bindUploadClaim, {
      companyId: f.companyA,
      claimId: upload.claimId,
      storageId: imageStorageId,
    });
    expect(bound).toEqual({ ok: true, error: null });

    const entryId = await admin.mutation(api.fleet.createFuelEntry, {
      companyId: f.companyA,
      vehicleId,
      filledAt: pinnedNow,
      litres: 40,
      amount: 5_000,
      photo: { storageId: imageStorageId, claimId: upload.claimId, fileName: "receipt.jpg" },
    });
    expect(entryId).toBeDefined();
    // The claim is consumed rather than left for the sweep.
    expect(await f.t.run((ctx) => ctx.db.get(upload.claimId))).toBeNull();

    const list = await admin.query(api.fleet.listFuelEntries, {
      companyId: f.companyA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(list.page[0].photo).toMatchObject({
      fileName: "receipt.jpg",
      contentType: "image/jpeg",
      size: 5,
    });
    expect(list.page[0].odometerMeters).toBe(100_000_000);
  });
});

describe("fleet role defaults", () => {
  test("the release backfill grants fleet capabilities only to untouched default roles", async () => {
    const f = await createAuthzFixture();
    const previousDefaults = (name: "Admin" | "Manager") =>
      defaultRoleCapabilities[name].filter((capability) => !capability.startsWith("fleet:"));
    await f.setRoleCapabilities(f.companyA, "Admin", previousDefaults("Admin"));
    await f.setRoleCapabilities(f.companyA, "Manager", previousDefaults("Manager"));
    // A customized Manager in another company must keep its custom grants.
    await f.setRoleCapabilities(f.companyB, "Manager", [
      ...previousDefaults("Manager"),
      "tasks:jd:pause",
    ]);

    const capabilitiesOf = async (companyId: typeof f.companyA, name: string) => {
      const role = await f.t.run((ctx) =>
        ctx.db
          .query("roles")
          .withIndex("by_company_and_name", (q) => q.eq("companyId", companyId).eq("name", name))
          .unique(),
      );
      return role?.capabilities ?? [];
    };

    expect(await f.t.mutation(internal.roles.enableFleetDefaults, {})).toBe(2);
    expect(await capabilitiesOf(f.companyA, "Admin")).toContain("fleet:manage");
    expect(await capabilitiesOf(f.companyA, "Manager")).toContain("fleet:manage");
    expect(await capabilitiesOf(f.companyA, "Employee")).not.toContain("fleet:view");
    expect(await capabilitiesOf(f.companyB, "Manager")).not.toContain("fleet:view");
    expect(await f.t.mutation(internal.roles.enableFleetDefaults, {})).toBe(0);
  });
});

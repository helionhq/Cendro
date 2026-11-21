import { expect, test } from "vitest";
import {
  alertDisplayTitle,
  dateFieldFromTimestamp,
  isShortGoogleMapsLink,
  monthOverMonthLabel,
  parseCoordinates,
  relativeTime,
  serviceRemainingLabel,
  timestampForEditedDateField,
  timestampForDateField,
  vehicleStatusChip,
} from "./fleet-format";

test("relativeTime keeps recent sightings readable and falls back to a date", () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  expect(relativeTime(now - 20_000, now)).toBe("just now");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hr ago");
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
  expect(relativeTime(null, now)).toBe("never");
});

test("a never-seen vehicle reads as Not seen yet, not Offline", () => {
  expect(vehicleStatusChip({ status: "offline", lastUpdate: null })).toEqual({
    label: "Not seen yet",
    tone: "neutral",
  });
  expect(vehicleStatusChip({ status: "offline", lastUpdate: Date.now() })).toEqual({
    label: "Offline",
    tone: "red",
  });
  expect(vehicleStatusChip({ status: "missing", lastUpdate: Date.now() })).toEqual({
    label: "Offline",
    tone: "red",
  });
});

test("serviceRemainingLabel distinguishes time left from time overdue", () => {
  const base = {
    status: "ok" as const,
    serviceIntervalKm: 5_000,
    serviceIntervalDays: 90,
    lastServicedAt: 0,
    lastServiceOdometerMeters: 0,
    nextDueOdometerMeters: 5_000_000,
    nextDueAt: 0,
  };
  expect(
    serviceRemainingLabel({ ...base, kmRemaining: 1_200, daysRemaining: 12 }),
  ).toBe("1,200 km left · 12 days left");
  expect(
    serviceRemainingLabel({ ...base, status: "overdue", kmRemaining: -230, daysRemaining: -1.2 }),
  ).toBe("230 km overdue · 2 days overdue");
  expect(
    serviceRemainingLabel({ ...base, kmRemaining: null, daysRemaining: null }),
  ).toBe("—");
});

test("monthOverMonthLabel rounds the change and names the no-history case", () => {
  expect(monthOverMonthLabel(null)).toBe("No spend last month");
  expect(monthOverMonthLabel(0)).toBe("Same as last month");
  expect(monthOverMonthLabel(0.126)).toBe("+13% vs last month");
  expect(monthOverMonthLabel(-0.08)).toBe("-8% vs last month");
});

test("parseCoordinates accepts the three supported Google Maps share forms", () => {
  expect(parseCoordinates("https://www.google.com/maps/@31.5820,74.3290,15z")).toEqual({
    lat: 31.582,
    lng: 74.329,
  });
  expect(parseCoordinates("https://maps.google.com/?q=31.582,74.329")).toEqual({
    lat: 31.582,
    lng: 74.329,
  });
  expect(parseCoordinates("31.582, 74.329")).toEqual({ lat: 31.582, lng: 74.329 });
  expect(parseCoordinates("https://www.google.com/maps/place/Peco+Road/@31.5,74.3,17z/data=!3m1")).toEqual({
    lat: 31.5,
    lng: 74.3,
  });
});

test("parseCoordinates rejects short links, prose, and out-of-range values", () => {
  expect(parseCoordinates("https://maps.app.goo.gl/abc123")).toBeNull();
  expect(parseCoordinates("Saggian Plant, Lahore")).toBeNull();
  expect(parseCoordinates("91, 74")).toBeNull();
  expect(parseCoordinates("31.58, 181")).toBeNull();
  expect(parseCoordinates("")).toBeNull();
});

test("short Google Maps links are detected so the dialog can explain them", () => {
  expect(isShortGoogleMapsLink("https://maps.app.goo.gl/abc123")).toBe(true);
  expect(isShortGoogleMapsLink("maps.app.goo.gl/abc123")).toBe(true);
  expect(isShortGoogleMapsLink("https://goo.gl/maps/abc123")).toBe(true);
  expect(isShortGoogleMapsLink("https://www.google.com/maps/@31.58,74.32,15z")).toBe(false);
  expect(isShortGoogleMapsLink("31.58, 74.32")).toBe(false);
});

test("fuel/service date fields use the company time zone", () => {
  // 20:00 UTC is already the next calendar day in Lahore (UTC+5).
  const eveningUtc = Date.UTC(2026, 10, 4, 20, 0, 0);
  expect(dateFieldFromTimestamp(eveningUtc, "Asia/Karachi")).toBe("2026-11-05");
  // Today keeps the real instant.
  expect(
    timestampForDateField("2026-11-05", eveningUtc, "Asia/Karachi"),
  ).toBe(eveningUtc);

  const noonPkt = timestampForEditedDateField(
    "2026-11-04",
    eveningUtc,
    "Asia/Karachi",
  );
  expect(dateFieldFromTimestamp(noonPkt, "Asia/Karachi")).toBe("2026-11-04");
  // Lahore is UTC+5 year-round, so company-local noon is 07:00 UTC.
  expect(new Date(noonPkt).getUTCHours()).toBe(7);
});

test("reviewed overdue alerts freeze the hours at the review time", () => {
  const raisedAt = Date.UTC(2026, 10, 4, 8);
  const alert = {
    kind: "trip_overdue" as const,
    vehicleName: "APL-079",
    occurredAt: raisedAt,
    title: "Trip overdue: APL-079",
    status: "open" as const,
    resolvedAt: null,
  };
  expect(alertDisplayTitle(alert, raisedAt + 2 * 3_600_000)).toBe(
    "APL-079 has been out for 14 hours",
  );
  expect(
    alertDisplayTitle(
      { ...alert, status: "resolved", resolvedAt: raisedAt + 3_600_000 },
      raisedAt + 100 * 3_600_000,
    ),
  ).toBe("APL-079 has been out for 13 hours");
});

test("editing a fill-up preserves its instant unless the day changed", () => {
  const original = new Date(2026, 10, 4, 16, 35, 0, 0).getTime();
  expect(timestampForEditedDateField("2026-11-04", original)).toBe(original);
  const moved = timestampForEditedDateField("2026-11-03", original);
  expect(new Date(moved).getDate()).toBe(3);
  expect(new Date(moved).getHours()).toBe(12);
});

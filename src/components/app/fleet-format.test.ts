import { expect, test } from "vitest";
import {
  monthOverMonthLabel,
  relativeTime,
  serviceRemainingLabel,
  timestampForEditedDateField,
} from "./fleet-format";

test("relativeTime keeps recent sightings readable and falls back to a date", () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  expect(relativeTime(now - 20_000, now)).toBe("just now");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hr ago");
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
  expect(relativeTime(null, now)).toBe("never");
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

test("editing a fill-up preserves its instant unless the day changed", () => {
  const original = new Date(2026, 10, 4, 16, 35, 0, 0).getTime();
  expect(timestampForEditedDateField("2026-11-04", original)).toBe(original);
  const moved = timestampForEditedDateField("2026-11-03", original);
  expect(new Date(moved).getDate()).toBe(3);
  expect(new Date(moved).getHours()).toBe(12);
});

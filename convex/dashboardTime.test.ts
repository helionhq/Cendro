import { describe, expect, test } from "vitest";
import { resolveDashboardPeriod } from "./dashboardTime";

const timeZone = "UTC";
const at = (month: number, day: number) => Date.UTC(2026, month - 1, day);

describe("resolveDashboardPeriod", () => {
  test("week returns the eight weeks ending with the selected week", () => {
    const period = resolveDashboardPeriod({ unit: "week", date: "2026-09-12" }, Date.UTC(2026, 8, 12, 10), timeZone);
    // Sep 12 2026 is a Saturday; the week runs Mon Sep 7 – Sun Sep 13.
    expect(period).toMatchObject({
      unit: "week",
      start: at(9, 7),
      end: at(9, 14) - 1,
      isCurrent: true,
      previous: { start: at(8, 31), end: at(9, 7) - 1 },
      next: null,
    });
    expect(period.buckets).toHaveLength(8);
    expect(period.buckets[0]).toEqual({ start: at(7, 20), end: at(7, 27) - 1 });
    expect(period.buckets[7]).toEqual({ start: at(9, 7), end: at(9, 14) - 1 });
  });

  test("month buckets are Monday weeks clipped to the month", () => {
    const period = resolveDashboardPeriod({ unit: "month", date: "2026-10-15" }, Date.UTC(2026, 9, 15, 10), timeZone);
    // Oct 1 2026 is a Thursday, so the first week bucket opens on the 1st.
    expect(period).toMatchObject({
      unit: "month",
      start: at(10, 1),
      end: at(11, 1) - 1,
      isCurrent: true,
      previous: { start: at(9, 1), end: at(10, 1) - 1 },
      next: null,
    });
    expect(period.buckets).toEqual([
      { start: at(10, 1), end: at(10, 5) - 1 },
      { start: at(10, 5), end: at(10, 12) - 1 },
      { start: at(10, 12), end: at(10, 19) - 1 },
      { start: at(10, 19), end: at(10, 26) - 1 },
      { start: at(10, 26), end: at(11, 1) - 1 },
    ]);
  });

  test("quarter splits into its three calendar months and navigates around a past period", () => {
    const period = resolveDashboardPeriod({ unit: "quarter", date: "2025-11-10" }, Date.UTC(2026, 8, 12, 10), timeZone);
    expect(period).toMatchObject({
      unit: "quarter",
      start: Date.UTC(2025, 9, 1),
      end: Date.UTC(2026, 0, 1) - 1,
      isCurrent: false,
      previous: { start: Date.UTC(2025, 6, 1), end: Date.UTC(2025, 9, 1) - 1 },
      next: { start: Date.UTC(2026, 0, 1) },
    });
    expect(period.buckets).toEqual([
      { start: Date.UTC(2025, 9, 1), end: Date.UTC(2025, 10, 1) - 1 },
      { start: Date.UTC(2025, 10, 1), end: Date.UTC(2025, 11, 1) - 1 },
      { start: Date.UTC(2025, 11, 1), end: Date.UTC(2026, 0, 1) - 1 },
    ]);
  });

  test("year splits into twelve calendar months, including months still in the future", () => {
    const period = resolveDashboardPeriod({ unit: "year", date: "2026-03-01" }, Date.UTC(2026, 8, 12, 10), timeZone);
    expect(period).toMatchObject({
      unit: "year",
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2027, 0, 1) - 1,
      isCurrent: true,
      previous: { start: Date.UTC(2025, 0, 1), end: Date.UTC(2026, 0, 1) - 1 },
      next: null,
    });
    expect(period.buckets).toHaveLength(12);
    expect(period.buckets[0]).toEqual({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 1) - 1 });
    expect(period.buckets[11]).toEqual({ start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) - 1 });
  });

  test("a future date collapses onto the current period", () => {
    const period = resolveDashboardPeriod({ unit: "month", date: "2027-03-15" }, Date.UTC(2026, 8, 12, 10), timeZone);
    expect(period).toMatchObject({
      start: at(9, 1),
      end: at(10, 1) - 1,
      isCurrent: true,
      next: null,
    });
  });

  test("omitting the date resolves the period containing now in the company time zone", () => {
    // Oct 1 01:00 in GMT+5, while a browser still on September 30 would have
    // filled in September. The server picks the company's month instead.
    const now = Date.UTC(2026, 8, 30, 20);
    const period = resolveDashboardPeriod({ unit: "month" }, now, "Etc/GMT-5");
    expect(period).toMatchObject({
      start: Date.UTC(2026, 8, 30, 19),
      end: Date.UTC(2026, 9, 31, 19) - 1,
      isCurrent: true,
      previous: { start: Date.UTC(2026, 7, 31, 19), end: Date.UTC(2026, 8, 30, 19) - 1 },
    });
  });

  test("rejects dates that are not real calendar days", () => {
    expect(() => resolveDashboardPeriod({ unit: "month", date: "2026-02-30" }, Date.UTC(2026, 8, 12, 10), timeZone)).toThrow("Invalid date.");
    expect(() => resolveDashboardPeriod({ unit: "month", date: "2026-9-1" }, Date.UTC(2026, 8, 12, 10), timeZone)).toThrow("Invalid date.");
  });
});

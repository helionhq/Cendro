import { expect, test } from "vitest";
import {
  chartBucketLabel,
  comparison,
  dashboardQueryString,
  heroCaption,
  noneDueNote,
  parseDashboardSearchParams,
  periodStepperLabel,
  previousPeriodLabel,
} from "./dashboard-format";

test("week period labels cross a month and a year without time-zone drift", () => {
  expect(periodStepperLabel({ unit: "week", startDate: "2026-10-19", endDate: "2026-10-25" })).toBe("19 – 25 Oct 2026");
  expect(periodStepperLabel({ unit: "week", startDate: "2026-09-28", endDate: "2026-10-04" })).toBe("28 Sep – 4 Oct 2026");
  expect(periodStepperLabel({ unit: "week", startDate: "2025-12-29", endDate: "2026-01-04" })).toBe("29 Dec 2025 – 4 Jan 2026");
});

test("month, quarter and year labels include the year and mark a running period", () => {
  expect(periodStepperLabel({ unit: "month", startDate: "2026-10-01", endDate: "2026-10-31" })).toBe("October 2026");
  expect(periodStepperLabel({ unit: "quarter", startDate: "2026-10-01", endDate: "2026-12-31" })).toBe("Q4 2026");
  expect(periodStepperLabel({ unit: "year", startDate: "2026-01-01", endDate: "2026-12-31" })).toBe("2026");

  const october = { unit: "month" as const, startDate: "2026-10-01", endDate: "2026-10-31" };
  expect(heroCaption("jd", { ...october, isCurrent: true })).toBe("October so far");
  expect(heroCaption("jd", { ...october, isCurrent: false })).toBe("October 2026");
  expect(heroCaption("tasks", { ...october, isCurrent: true })).toBe("Assigned in October");

  const q4 = { unit: "quarter" as const, startDate: "2026-10-01", endDate: "2026-12-31" };
  expect(heroCaption("jd", { ...q4, isCurrent: true })).toBe("Q4 so far");
  expect(heroCaption("jd", { ...q4, isCurrent: false })).toBe("Q4 2026");
  expect(heroCaption("tasks", { ...q4, isCurrent: false })).toBe("Assigned in Q4 2026");

  const week = { unit: "week" as const, startDate: "2026-09-28", endDate: "2026-10-04" };
  expect(heroCaption("jd", { ...week, isCurrent: false })).toBe("Mon 28 Sep – Sun 4 Oct");
  expect(heroCaption("tasks", { ...week, isCurrent: false })).toBe("Assigned 28 Sep – 4 Oct");
});

test("comparison reports the point difference, handles a single point, and names the previous period", () => {
  expect(comparison(92, 87, "September")).toEqual({
    tone: "better",
    headline: "5 points better",
    suffix: " than September (87%)",
  });
  expect(comparison(84, 85, "the week before")).toEqual({
    tone: "worse",
    headline: "1 point worse",
    suffix: " than the week before (85%)",
  });
  expect(comparison(100, 100, "Q3")).toEqual({ tone: "same", headline: "Same as Q3 (100%)", suffix: "" });
  expect(comparison(null, 87, "September")).toBeNull();
  expect(comparison(92, null, "September")).toBeNull();
});

test("chart labels split week buckets and clip month-unit weeks", () => {
  expect(chartBucketLabel("week", { startDate: "2026-08-31", endDate: "2026-09-06" }, 0)).toEqual({
    primary: "31 Aug",
    secondary: "– 6 Sep",
    title: "31 Aug – 6 Sep",
    aria: "31 Aug – 6 Sep",
  });
  expect(chartBucketLabel("week", { startDate: "2026-10-19", endDate: "2026-10-25" }, 7)).toMatchObject({
    primary: "19 Oct",
    secondary: "– 25 Oct",
  });
  expect(chartBucketLabel("month", { startDate: "2026-10-01", endDate: "2026-10-04" }, 0)).toEqual({
    primary: "Week 1",
    secondary: "1–4 Oct",
    title: "Week 1 · 1–4 Oct",
    aria: "Week 1, 1–4 Oct",
  });
  expect(chartBucketLabel("quarter", { startDate: "2026-10-01", endDate: "2026-10-31" }, 0)).toEqual({
    primary: "Oct",
    title: "October 2026",
    aria: "October 2026",
  });
});

test("the previous-period name adds a year only when the previous period is in another year", () => {
  expect(previousPeriodLabel({ unit: "week", startDate: "2026-10-19", previousDate: "2026-10-12" })).toBe("the week before");
  expect(previousPeriodLabel({ unit: "month", startDate: "2026-10-01", previousDate: "2026-09-01" })).toBe("September");
  expect(previousPeriodLabel({ unit: "month", startDate: "2026-01-01", previousDate: "2025-12-01" })).toBe("December 2025");
  expect(previousPeriodLabel({ unit: "quarter", startDate: "2026-10-01", previousDate: "2026-07-01" })).toBe("Q3");
  expect(previousPeriodLabel({ unit: "quarter", startDate: "2026-01-01", previousDate: "2025-10-01" })).toBe("Q4 2025");
  expect(previousPeriodLabel({ unit: "year", startDate: "2026-01-01", previousDate: "2025-01-01" })).toBe("2025");
});

test("the none-due note joins labels and reads naturally for a week", () => {
  expect(noneDueNote(["Quarterly", "Bi-yearly", "Yearly"], "October")).toBe(
    "Quarterly, Bi-yearly and Yearly JDs: none were due in October.",
  );
  expect(noneDueNote(["Daily", "Weekly"], "this week")).toBe("Daily and Weekly JDs: none were due this week.");
});

test("search-param parsing ignores invalid values and the URL omits defaults", () => {
  expect(
    parseDashboardSearchParams({
      tab: "tasks",
      unit: "quarter",
      date: "2026-10-19",
      branch: "branch-id",
      department: ["ignored", "array"],
    }),
  ).toEqual({ tab: "tasks", unit: "quarter", date: "2026-10-19", branch: "branch-id", department: null });

  expect(parseDashboardSearchParams({ tab: "nope", unit: "nope", date: "2026-02-31" })).toEqual({
    tab: "jd",
    unit: "month",
    date: null,
    branch: null,
    department: null,
  });

  expect(dashboardQueryString({ tab: "jd", unit: "month", date: null })).toBe("");
  expect(dashboardQueryString({ tab: "tasks", unit: "week", date: "2026-10-19", branch: "b1", department: null })).toBe(
    "tab=tasks&unit=week&date=2026-10-19&branch=b1",
  );
});

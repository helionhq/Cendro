import { ConvexError, v, type Infer } from "convex/values";
import {
  currentJdCycle,
  localDayStart,
  nextJdCycleStart,
  previousJdCycleStart,
  type JdRecurrence,
} from "./taskCycles";

export const dashboardPeriodValidator = v.object({
  unit: v.union(v.literal("week"), v.literal("month"), v.literal("quarter"), v.literal("year")),
  // "YYYY-MM-DD", any company-local day inside the wanted period. Omitted
  // means the period containing server `now` in the company's time zone, so a
  // client whose own date has not rolled over still lands on the right month.
  date: v.optional(v.string()),
});
export type DashboardPeriodArg = Infer<typeof dashboardPeriodValidator>;
export type DashboardUnit = DashboardPeriodArg["unit"];

export type DashboardBucket = { start: number; end: number }; // end inclusive (next start - 1)
export type DashboardPeriod = {
  unit: DashboardUnit;
  start: number;        // first instant of the selected period (company-local midnight)
  end: number;          // last instant of the FULL selected period (inclusive), even if in the future
  isCurrent: boolean;   // the period contains "now"
  previous: { start: number; end: number }; // the full period immediately before (same unit)
  next: { start: number } | null;           // start of the following period, or null when the selected period is current
  buckets: DashboardBucket[];               // ordered oldest → newest
};

const customDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

// Period boundaries reuse the JD recurrence grid so the period a report shows
// is exactly the cycle the task ledger closes on.
const unitRecurrence: Record<DashboardUnit, JdRecurrence> = {
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
  year: "annually",
};

function customDayStart(timeZone: string | null | undefined, value: string) {
  const match = customDatePattern.exec(value);
  if (!match) return null;
  return localDayStart(timeZone, Number(match[1]), Number(match[2]), Number(match[3]));
}

export function resolveDashboardPeriod(
  arg: DashboardPeriodArg,
  now: number,
  timeZone: string | null | undefined,
): DashboardPeriod {
  const dayStart = arg.date === undefined ? now : customDayStart(timeZone, arg.date);
  if (dayStart === null) throw new ConvexError("Invalid date.");

  const recurrence = unitRecurrence[arg.unit];
  const current = currentJdCycle(recurrence, now, timeZone);
  // A future period collapses onto the current one: client clocks and time
  // zones can run ahead of the company's, so never report a period that has
  // not started yet.
  const start = Math.min(currentJdCycle(recurrence, dayStart, timeZone).start, current.start);
  const end = nextJdCycleStart(start, recurrence, timeZone) - 1;
  const isCurrent = start === current.start;
  const previousStart = previousJdCycleStart(start, recurrence, timeZone);

  const buckets: DashboardBucket[] = [];
  if (arg.unit === "week") {
    // The trailing eight weeks, selected week last.
    const starts = [start];
    for (let index = 0; index < 7; index += 1) starts.push(previousJdCycleStart(starts[starts.length - 1], recurrence, timeZone));
    for (const bucketStart of starts.reverse()) buckets.push({ start: bucketStart, end: nextJdCycleStart(bucketStart, recurrence, timeZone) - 1 });
  } else if (arg.unit === "month") {
    // Monday-start weeks clipped to the month: the first bucket opens on the
    // 1st and the last closes on the month's final instant.
    let cursor = start;
    let boundary = nextJdCycleStart(currentJdCycle("weekly", start, timeZone).start, "weekly", timeZone);
    while (boundary - 1 < end) {
      buckets.push({ start: cursor, end: boundary - 1 });
      cursor = boundary;
      boundary = nextJdCycleStart(boundary, "weekly", timeZone);
    }
    buckets.push({ start: cursor, end });
  } else {
    const months = arg.unit === "quarter" ? 3 : 12;
    let cursor = start;
    for (let index = 0; index < months; index += 1) {
      const boundary = nextJdCycleStart(cursor, "monthly", timeZone);
      buckets.push({ start: cursor, end: boundary - 1 });
      cursor = boundary;
    }
  }

  return {
    unit: arg.unit,
    start,
    end,
    isCurrent,
    previous: { start: previousStart, end: start - 1 },
    next: isCurrent ? null : { start: nextJdCycleStart(start, recurrence, timeZone) },
    buckets,
  };
}

export function bucketIndexFor(buckets: DashboardBucket[], at: number): number {
  let low = 0;
  let high = buckets.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (buckets[mid].start <= at) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index === -1 || at > buckets[index].end) return -1;
  return index;
}

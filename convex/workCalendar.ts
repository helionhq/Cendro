import { ConvexError, v } from "convex/values";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { currentJdCycle, localDayBoundaryUtc, localDayIndexAt, nextJdCycleStart, previousJdCycleStart, timeZoneOrDefault, type JdRecurrence } from "./taskCycles";
import { requireCapability, requireMembership } from "./permissions";
import { companyManagementCapabilities, type Capability } from "../src/lib/permissions";
import { nonEmpty } from "./validation";

const dayMs = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Monday–Saturday; the default when no calendar document exists. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6];
const MAX_HOLIDAYS = 200;
const MAX_HOLIDAY_SPAN_DAYS = 366;
// Working-day scans only need to outlive the longest single holiday range
// plus one week; the bound exists so pathological stored data degrades to
// "no shift" instead of looping forever.
const WORKING_DAY_SCAN_LIMIT = MAX_HOLIDAY_SPAN_DAYS + 14;

export type HolidayRange = { startDate: string; endDate: string; recursYearly?: boolean };

export type WorkCalendar = {
  /** Weekday numbers that count as working days (0 = Sunday … 6 = Saturday). */
  workingDays: ReadonlySet<number>;
  /** Merged, sorted one-time holiday ranges as UTC-indexed calendar dates. */
  holidayRanges: { start: number; end: number }[];
  /** Repeating ranges as month*100+day (Dec 24 → 1224); a start past the end
   *  wraps the year boundary (Dec 24 – Jan 6). */
  yearlyRanges: { startMonthDay: number; endMonthDay: number }[];
};

export const allWorkingCalendar: WorkCalendar = { workingDays: new Set([0, 1, 2, 3, 4, 5, 6]), holidayRanges: [], yearlyRanges: [] };

function dayIndexOfParts(year: number, month: number, day: number) {
  return Math.floor(Date.UTC(year, month - 1, day) / dayMs);
}

function calendarDateString(dayIndex: number) {
  const date = new Date(dayIndex * dayMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** UTC day index of a "YYYY-MM-DD" calendar date, or null when it isn't a real date. */
export function parseCalendarDate(value: string): number | null {
  const match = datePattern.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const index = dayIndexOfParts(year, month, day);
  return calendarDateString(index) === `${match[1]}-${match[2]}-${match[3]}` ? index : null;
}

function weekdayOf(dayIndex: number) {
  return new Date(dayIndex * dayMs).getUTCDay();
}

function mergedRanges(ranges: { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Month-day of a UTC day index as month*100+day (Dec 24 → 1224). */
function monthDayOf(dayIndex: number) {
  const date = new Date(dayIndex * dayMs);
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/** UTC day index of a month-day in `year`, clamping Feb 29 to Feb 28 off leap years. */
function yearlyDayIndex(year: number, monthDay: number) {
  const month = Math.floor(monthDay / 100);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return dayIndexOfParts(year, month, Math.min(monthDay % 100, daysInMonth));
}

export function buildWorkCalendar(workingDays: readonly number[] | null | undefined, holidays: readonly HolidayRange[]): WorkCalendar {
  const valid = (workingDays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  // An empty weekday list would make no day working, which breaks every shift
  // lookup; fall back to the default instead of carrying a unusable calendar.
  const days = new Set(valid.length ? valid : DEFAULT_WORKING_DAYS);
  const parsed = holidays
    .map((holiday) => ({ start: parseCalendarDate(holiday.startDate), end: parseCalendarDate(holiday.endDate), yearly: holiday.recursYearly === true }))
    .filter((range): range is { start: number; end: number; yearly: boolean } => range.start !== null && range.end !== null);
  // Repeating ranges keep their entered month-day order: a start after the
  // end wraps the year boundary; one-time ranges normalize to start <= end.
  const yearlyRanges = parsed
    .filter((range) => range.yearly)
    .map((range) => ({ startMonthDay: monthDayOf(range.start), endMonthDay: monthDayOf(range.end) }));
  const merged = mergedRanges(parsed.filter((range) => !range.yearly).map((range) => (range.start <= range.end ? { start: range.start, end: range.end } : { start: range.end, end: range.start })));
  return { workingDays: days, holidayRanges: merged, yearlyRanges };
}

function holidayRangeAt(calendar: WorkCalendar, dayIndex: number) {
  let lo = 0;
  let hi = calendar.holidayRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = calendar.holidayRanges[mid];
    if (dayIndex < range.start) hi = mid - 1;
    else if (dayIndex > range.end) lo = mid + 1;
    else return range;
  }
  return null;
}

function yearlyRangeAt(calendar: WorkCalendar, dayIndex: number) {
  const year = new Date(dayIndex * dayMs).getUTCFullYear();
  return calendar.yearlyRanges.find((range) => {
    // Compare materialized dates, not month-days, so a bound clamped off a
    // leap year (Feb 29 → Feb 28) still covers the day it lands on.
    if (dayIndex >= yearlyDayIndex(year, range.startMonthDay)) {
      if (range.startMonthDay <= range.endMonthDay) return dayIndex <= yearlyDayIndex(year, range.endMonthDay);
      return true; // wrapped range: the probe sits in the Dec–Jan head
    }
    // Wrapped range tail (Jan 1 … clamped end of the same year).
    return range.startMonthDay > range.endMonthDay && dayIndex <= yearlyDayIndex(year, range.endMonthDay);
  }) ?? null;
}

/** UTC day index where the repeating range covering `dayIndex` ends. */
function yearlyRangeEndIndex(range: { startMonthDay: number; endMonthDay: number }, dayIndex: number) {
  const year = new Date(dayIndex * dayMs).getUTCFullYear();
  const endYear = range.startMonthDay <= range.endMonthDay || monthDayOf(dayIndex) <= range.endMonthDay ? year : year + 1;
  return yearlyDayIndex(endYear, range.endMonthDay);
}

export function isWorkingDayIndex(calendar: WorkCalendar, dayIndex: number) {
  return calendar.workingDays.has(weekdayOf(dayIndex)) && holidayRangeAt(calendar, dayIndex) === null && yearlyRangeAt(calendar, dayIndex) === null;
}

/** First working day index strictly after `dayIndex`. */
export function nextWorkingDayIndex(calendar: WorkCalendar, dayIndex: number) {
  let index = dayIndex + 1;
  // Jumping past the merged range containing a probe keeps multi-year
  // closures cheap; the cap only guards a non-working weekday set.
  for (let i = 0; i < WORKING_DAY_SCAN_LIMIT; i++) {
    if (!calendar.workingDays.has(weekdayOf(index))) { index += 1; continue; }
    const covering = holidayRangeAt(calendar, index);
    if (covering !== null) { index = covering.end + 1; continue; }
    const yearly = yearlyRangeAt(calendar, index);
    if (yearly === null) return index;
    index = yearlyRangeEndIndex(yearly, index) + 1;
  }
  return index;
}

/**
 * Longest contiguous holiday span in days. Bounds how far a shifted deadline
 * can land past its grid end, which the analytics completion lookback needs.
 */
export function maxHolidaySpanDays(calendar: WorkCalendar) {
  const spanSum = (ranges: { start: number; end: number }[]) => ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
  // Materialize repeating ranges in a leap year (wrapping ones end in the
  // next). One-time ranges can join yearly closures into a longer contiguous
  // shutdown — and a year-long one can rejoin the same yearly range on its
  // far side — so the bound counts every yearly span twice.
  const yearly = mergedRanges(calendar.yearlyRanges.map((range) => {
    const endYear = range.startMonthDay <= range.endMonthDay ? 2024 : 2025;
    return { start: yearlyDayIndex(2024, range.startMonthDay), end: yearlyDayIndex(endYear, range.endMonthDay) };
  }));
  return spanSum(calendar.holidayRanges) + 2 * spanSum(yearly);
}

/** Local calendar date a cycle's deadline instant falls on. */
export function cycleDueDayIndex(cycleEnd: number, timeZone?: string | null) {
  return localDayIndexAt(cycleEnd - 1, timeZone);
}

/**
 * The instant a cycle occurrence is due, or null when the occurrence is
 * skipped entirely — daily and every-other-day occurrences whose due date is
 * a non-working day simply do not exist. For every other recurrence a
 * non-working due date moves the deadline to the end of the next working day;
 * the recurrence grid itself never moves.
 */
export function occurrenceDeadline(calendar: WorkCalendar, recurrence: JdRecurrence, cycleEnd: number, timeZone?: string | null): number | null {
  const zone = timeZoneOrDefault(timeZone);
  const dueIndex = cycleDueDayIndex(cycleEnd, zone);
  if (isWorkingDayIndex(calendar, dueIndex)) return cycleEnd;
  if (recurrence === "daily" || recurrence === "every_other_day") return null;
  return localDayBoundaryUtc(nextWorkingDayIndex(calendar, dueIndex) + 1, zone);
}

/**
 * The occurrence currently open for work. That is usually the grid cycle
 * containing `now`, with two adjustments: cycles whose shifted deadline is
 * still pending stay open until the deadline passes — a closure covering
 * several due dates can leave several pending at once, and work credits the
 * earliest open one — and daily/every-other-day cycles skip ahead past
 * non-working due dates, so completing on a skipped day counts toward the
 * next working occurrence.
 */
export function effectiveCurrentJdCycle(calendar: WorkCalendar, recurrence: JdRecurrence, now = Date.now(), timeZone?: string | null) {
  const cycle = currentJdCycle(recurrence, now, timeZone);
  // A cycle ends where the next begins, so the deadline of the occurrence
  // ending at `start` decides whether that predecessor is still open. Skipped
  // (null) and on-time (<= now) predecessors always yield to a later one.
  let start = cycle.start;
  for (let i = 0; i < WORKING_DAY_SCAN_LIMIT; i++) {
    const prevDeadline = occurrenceDeadline(calendar, recurrence, start, timeZone);
    if (prevDeadline === null || prevDeadline <= now) break;
    start = previousJdCycleStart(start, recurrence, timeZone);
  }
  if (start !== cycle.start) return { start, end: nextJdCycleStart(start, recurrence, timeZone) };
  if (occurrenceDeadline(calendar, recurrence, cycle.end, timeZone) !== null) return cycle;
  for (let i = 0; i < WORKING_DAY_SCAN_LIMIT; i++) {
    start = nextJdCycleStart(start, recurrence, timeZone);
    const end = nextJdCycleStart(start, recurrence, timeZone);
    if (occurrenceDeadline(calendar, recurrence, end, timeZone) !== null) return { start, end };
  }
  return cycle;
}

export type JdOccurrence = { start: number; end: number; deadline: number };

/**
 * Elapsed occurrences since the task's floor: grid cycles that ended by
 * `now`, minus skipped occurrences, minus occurrences whose shifted deadline
 * is still pending. `nextActiveAt` is the first grid start the caller no
 * longer needs to revisit — it stops at a pending shifted deadline so that
 * cycle is re-evaluated on the next run rather than silently dropped.
 */
export function elapsedJdOccurrences(calendar: WorkCalendar, recurrence: JdRecurrence, activeAt: number, now = Date.now(), maxCycles = 200, timeZone?: string | null, throughStart?: number): { occurrences: JdOccurrence[]; nextActiveAt: number } {
  // `throughStart` bounds the walk to cycles that started before it; callers
  // replaying a past schedule pass the grid position where that schedule
  // stopped so cycles it never covered are not re-evaluated.
  const currentStart = throughStart ?? currentJdCycle(recurrence, now, timeZone).start;
  let start = currentJdCycle(recurrence, activeAt, timeZone).start;
  const occurrences: JdOccurrence[] = [];
  while (start < currentStart && occurrences.length < maxCycles) {
    const end = nextJdCycleStart(start, recurrence, timeZone);
    if (end <= now) {
      const deadline = occurrenceDeadline(calendar, recurrence, end, timeZone);
      if (deadline !== null && deadline <= now) occurrences.push({ start, end, deadline });
      else if (deadline !== null) return { occurrences, nextActiveAt: start };
    }
    start = end;
  }
  return { occurrences, nextActiveAt: start };
}

/**
 * Occurrences whose effective deadlines fall inside [rangeStart, rangeEnd],
 * walked back from the current cycle so a lagging `activeAt` can never push
 * recent deadlines past `maxCycles`. Stored deadlines are monotonic along the grid,
 * so the walk stops once a cycle's deadline precedes the range.
 */
export function jdOccurrencesDueBetween(calendar: WorkCalendar, recurrence: JdRecurrence, activeAt: number, now: number, rangeStart: number, rangeEnd: number, maxCycles = 200, timeZone?: string | null): { occurrences: JdOccurrence[]; truncated: boolean } {
  const current = currentJdCycle(recurrence, now, timeZone);
  const floor = currentJdCycle(recurrence, activeAt, timeZone).start;
  const occurrences: JdOccurrence[] = [];
  let truncated = false;
  let end = current.start;
  while (end > floor) {
    const start = previousJdCycleStart(end, recurrence, timeZone);
    if (start < floor) break;
    const deadline = occurrenceDeadline(calendar, recurrence, end, timeZone);
    // A skipped occurrence has no deadline; probe with its grid end, which is
    // still monotonic — once it precedes the range, earlier cycles cannot
    // reach back into it.
    if ((deadline ?? end) - 1 < rangeStart) break;
    if (deadline !== null && deadline - 1 <= rangeEnd) {
      if (occurrences.length >= maxCycles) {
        truncated = true;
        break;
      }
      occurrences.push({ start, end, deadline });
    }
    end = start;
  }
  return { occurrences, truncated };
}

async function loadCalendarRows(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) {
  const [doc, holidays] = await Promise.all([
    ctx.db.query("companyCalendars").withIndex("by_company", (q) => q.eq("companyId", companyId)).unique(),
    ctx.db.query("companyHolidays").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(MAX_HOLIDAYS + 1),
  ]);
  return { doc, holidays };
}

export async function loadWorkCalendar(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">): Promise<WorkCalendar> {
  const { doc, holidays } = await loadCalendarRows(ctx, companyId);
  return buildWorkCalendar(doc?.workingDays, holidays);
}

export const get = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { capabilities } = await requireMembership(ctx, args.companyId);
    if (!companyManagementCapabilities.some((capability) => capabilities.has(capability as Capability))) {
      throw new ConvexError("You do not have access to do that.");
    }
    const { doc, holidays } = await loadCalendarRows(ctx, args.companyId);
    return {
      workingDays: doc?.workingDays ?? [...DEFAULT_WORKING_DAYS],
      holidays: holidays.map(({ _id, name, startDate, endDate, recursYearly }) => ({ _id, name, startDate, endDate, recursYearly: recursYearly === true })),
    };
  },
});

export const setWorkingDays = mutation({
  args: { companyId: v.id("companies"), workingDays: v.array(v.number()) },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "company:manage_calendar");
    const unique = Array.from(new Set(args.workingDays)).sort((a, b) => a - b);
    if (unique.length === 0 || unique.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new ConvexError("Choose at least one working day.");
    }
    const now = Date.now();
    const existing = await ctx.db.query("companyCalendars").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).unique();
    if (existing) await ctx.db.patch(existing._id, { workingDays: unique, updatedAt: now, updatedByMembershipId: membership._id });
    else await ctx.db.insert("companyCalendars", { companyId: args.companyId, workingDays: unique, updatedAt: now, updatedByMembershipId: membership._id });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "work_calendar.update_working_days", targetType: "companyCalendar", metadata: { workingDays: unique }, createdAt: now });
    return null;
  },
});

export const addHoliday = mutation({
  args: { companyId: v.id("companies"), name: v.string(), startDate: v.string(), endDate: v.string(), recursYearly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "company:manage_calendar");
    const name = nonEmpty(args.name, "Holiday name");
    const start = parseCalendarDate(args.startDate);
    const end = parseCalendarDate(args.endDate);
    if (start === null || end === null) throw new ConvexError("Holiday dates must be real calendar dates.");
    const recursYearly = args.recursYearly === true;
    // Repeating ranges keep their entered order — a start after the end wraps
    // the year boundary. One-time ranges normalize to chronological order.
    const first = recursYearly ? start : Math.min(start, end);
    const last = recursYearly ? end : Math.max(start, end);
    if (!recursYearly && last - first > MAX_HOLIDAY_SPAN_DAYS) throw new ConvexError("A holiday range can span at most one year.");
    const existing = await ctx.db.query("companyHolidays").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(MAX_HOLIDAYS + 1);
    if (existing.length >= MAX_HOLIDAYS) throw new ConvexError("Holiday limit reached.");
    const now = Date.now();
    const startDate = calendarDateString(first);
    const endDate = calendarDateString(last);
    const id = await ctx.db.insert("companyHolidays", { companyId: args.companyId, name, startDate, endDate, recursYearly, createdByMembershipId: membership._id, createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "work_calendar.add_holiday", targetType: "companyHoliday", targetId: id, metadata: { name, startDate, endDate, recursYearly }, createdAt: now });
    return id;
  },
});

export const updateHoliday = mutation({
  args: { companyId: v.id("companies"), holidayId: v.id("companyHolidays"), name: v.string(), startDate: v.string(), endDate: v.string(), recursYearly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_calendar");
    const holiday = await ctx.db.get(args.holidayId);
    if (!holiday || holiday.companyId !== args.companyId) throw new ConvexError("Holiday not found.");
    const name = nonEmpty(args.name, "Holiday name");
    const start = parseCalendarDate(args.startDate);
    const end = parseCalendarDate(args.endDate);
    if (start === null || end === null) throw new ConvexError("Holiday dates must be real calendar dates.");
    const recursYearly = args.recursYearly === true;
    // Same ordering rule as addHoliday: repeating ranges keep their entered
    // order (a start after the end wraps the year boundary); one-time ranges
    // normalize to chronological order.
    const first = recursYearly ? start : Math.min(start, end);
    const last = recursYearly ? end : Math.max(start, end);
    if (!recursYearly && last - first > MAX_HOLIDAY_SPAN_DAYS) throw new ConvexError("A holiday range can span at most one year.");
    const startDate = calendarDateString(first);
    const endDate = calendarDateString(last);
    await ctx.db.patch(args.holidayId, { name, startDate, endDate, recursYearly });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "work_calendar.update_holiday", targetType: "companyHoliday", targetId: args.holidayId, metadata: { name, startDate, endDate, recursYearly }, createdAt: Date.now() });
    return null;
  },
});

export const removeHoliday = mutation({
  args: { companyId: v.id("companies"), holidayId: v.id("companyHolidays") },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_calendar");
    const holiday = await ctx.db.get(args.holidayId);
    if (!holiday || holiday.companyId !== args.companyId) throw new ConvexError("Holiday not found.");
    await ctx.db.delete(args.holidayId);
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "work_calendar.remove_holiday", targetType: "companyHoliday", targetId: args.holidayId, metadata: { name: holiday.name, startDate: holiday.startDate, endDate: holiday.endDate }, createdAt: Date.now() });
    return null;
  },
});

/**
 * Grants the calendar permission to existing role documents that hold the
 * whole company-management set — the built-in Admin and admin-equivalent
 * custom roles. Run once after deploy: `npx convex run workCalendar:backfillManageCalendarCapability`.
 */
export const backfillManageCalendarCapability = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("roles").paginate({ numItems: 100, cursor: args.cursor ?? null });
    let granted = 0;
    for (const role of page.page) {
      if (role.capabilities.includes("company:manage_calendar")) continue;
      const isFullAdmin = companyManagementCapabilities.every((capability) => capability === "company:manage_calendar" || role.capabilities.includes(capability));
      if (isFullAdmin) {
        await ctx.db.patch(role._id, { capabilities: [...role.capabilities, "company:manage_calendar"], updatedAt: Date.now() });
        granted += 1;
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.workCalendar.backfillManageCalendarCapability, { cursor: page.continueCursor });
    return { scanned: page.page.length, granted, isDone: page.isDone };
  },
});

import type { Frequency } from "@/lib/task-import/schema";
import type { DashboardUnit } from "../../../convex/dashboardTime";

export type { DashboardUnit };
export type DashboardTab = "jd" | "tasks";

export type DashboardQueryState = {
  tab: DashboardTab;
  unit: DashboardUnit;
  date: string | null;
};

export type DashboardSearchState = DashboardQueryState & {
  branch: string | null;
  department: string | null;
};

type PeriodKey = { unit: DashboardUnit; startDate: string; endDate: string };

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const monthShortFormat = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLongFormat = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });

/**
 * Parses a company-local YYYY-MM-DD string as a UTC calendar date. Every
 * formatter below reads it in UTC, so a client time zone can never shift the
 * displayed day.
 */
export function parseDateField(value: string): Date | null {
  const match = datePattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function isValidDateField(value: string) {
  return parseDateField(value) !== null;
}

function parts(value: string) {
  const date = parseDateField(value);
  if (!date) return null;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

export function dayMonth(value: string) {
  const date = parseDateField(value);
  return date ? `${dayFormat.format(date)} ${monthShortFormat.format(date)}` : "—";
}

export function weekdayDayMonth(value: string) {
  const date = parseDateField(value);
  return date ? `${weekdayFormat.format(date)} ${dayMonth(value)}` : "—";
}

export function monthYear(value: string) {
  const date = parseDateField(value);
  return date ? `${monthLongFormat.format(date)} ${date.getUTCFullYear()}` : "—";
}

export function monthName(value: string) {
  const date = parseDateField(value);
  return date ? monthLongFormat.format(date) : "—";
}

export function monthShort(value: string) {
  const date = parseDateField(value);
  return date ? monthShortFormat.format(date) : "—";
}

export function quarterOf(value: string) {
  const date = parseDateField(value);
  return date ? Math.floor(date.getUTCMonth() / 3) + 1 : 1;
}

export function quarterLabel(value: string) {
  return `Q${quarterOf(value)}`;
}

export function yearOf(value: string) {
  return parts(value)?.year ?? 0;
}

/** "19 – 25 Oct 2026", "28 Sep – 4 Oct 2026", "29 Dec 2025 – 4 Jan 2026". */
export function weekRangeLabel(startDate: string, endDate: string) {
  const start = parts(startDate);
  const end = parts(endDate);
  if (!start || !end) return "—";
  const crossYear = start.year !== end.year;
  const crossMonth = start.month !== end.month;
  const startPart = `${start.day}${crossMonth ? ` ${monthShort(startDate)}` : ""}${crossYear ? ` ${start.year}` : ""}`;
  return `${startPart} – ${end.day} ${monthShort(endDate)} ${end.year}`;
}

/** "19 – 25 Oct", "28 Sep – 4 Oct", "29 Dec 2025 – 4 Jan 2026". */
export function weekRangeShort(startDate: string, endDate: string) {
  const start = parts(startDate);
  const end = parts(endDate);
  if (!start || !end) return "—";
  const crossYear = start.year !== end.year;
  const crossMonth = start.month !== end.month;
  const startPart = `${start.day}${crossMonth ? ` ${monthShort(startDate)}` : ""}${crossYear ? ` ${start.year}` : ""}`;
  return `${startPart} – ${end.day} ${monthShort(endDate)}${crossYear ? ` ${end.year}` : ""}`;
}

/** "1–4 Oct" for a week bucket clipped to the selected month. */
export function clippedWeekRange(startDate: string, endDate: string) {
  const start = parts(startDate);
  const end = parts(endDate);
  if (!start || !end) return "—";
  if (start.month === end.month) return `${start.day}–${end.day} ${monthShort(endDate)}`;
  return `${start.day} ${monthShort(startDate)}–${end.day} ${monthShort(endDate)}`;
}

/** "Mon 19 – Sun 25 Oct" for the week hero caption. */
export function weekCaption(startDate: string, endDate: string) {
  const start = parseDateField(startDate);
  const end = parseDateField(endDate);
  if (!start || !end) return "—";
  const startParts = parts(startDate)!;
  const endParts = parts(endDate)!;
  const crossYear = startParts.year !== endParts.year;
  const crossMonth = startParts.month !== endParts.month;
  const startPart = `${weekdayFormat.format(start)} ${startParts.day}${crossMonth ? ` ${monthShort(startDate)}` : ""}${crossYear ? ` ${startParts.year}` : ""}`;
  return `${startPart} – ${weekdayFormat.format(end)} ${endParts.day} ${monthShort(endDate)}${crossYear ? ` ${endParts.year}` : ""}`;
}

export function periodStepperLabel(period: Pick<PeriodKey, "unit" | "startDate" | "endDate">) {
  if (period.unit === "week") return weekRangeLabel(period.startDate, period.endDate);
  if (period.unit === "month") return monthYear(period.startDate);
  if (period.unit === "quarter") return `${quarterLabel(period.startDate)} ${yearOf(period.startDate)}`;
  return String(yearOf(period.startDate));
}

/** Hero card caption for the selected unit and mode. */
export function heroCaption(
  mode: DashboardTab,
  period: { unit: DashboardUnit; startDate: string; endDate: string; isCurrent: boolean },
) {
  if (period.unit === "week") {
    const range = weekRangeShort(period.startDate, period.endDate);
    return mode === "jd" ? weekCaption(period.startDate, period.endDate) : `Assigned ${range}`;
  }
  if (period.unit === "month") {
    const name = monthName(period.startDate);
    if (mode === "jd") return period.isCurrent ? `${name} so far` : monthYear(period.startDate);
    return period.isCurrent ? `Assigned in ${name}` : `Assigned in ${monthYear(period.startDate)}`;
  }
  if (period.unit === "quarter") {
    const name = quarterLabel(period.startDate);
    const label = period.isCurrent ? name : `${name} ${yearOf(period.startDate)}`;
    return mode === "jd" ? (period.isCurrent ? `${name} so far` : label) : `Assigned in ${label}`;
  }
  const year = yearOf(period.startDate);
  return mode === "jd" ? (period.isCurrent ? `${year} so far` : String(year)) : `Assigned in ${year}`;
}

/** "the week before", "September", "December 2025", "Q3", "Q4 2025", "2025". */
export function previousPeriodLabel(period: { unit: DashboardUnit; startDate: string; previousDate: string }) {
  if (period.unit === "week") return "the week before";
  const previous = parts(period.previousDate);
  const current = parts(period.startDate);
  if (!previous || !current) return "the previous period";
  if (period.unit === "month") {
    return previous.year === current.year ? monthName(period.previousDate) : monthYear(period.previousDate);
  }
  if (period.unit === "quarter") {
    return previous.year === current.year ? quarterLabel(period.previousDate) : `${quarterLabel(period.previousDate)} ${previous.year}`;
  }
  return String(previous.year);
}

/** Period name used in plain-language notes: "this week", "October", "Q4", "2026". */
export function periodDisplayName(period: { unit: DashboardUnit; startDate: string }) {
  if (period.unit === "week") return "this week";
  if (period.unit === "month") return monthName(period.startDate);
  if (period.unit === "quarter") return quarterLabel(period.startDate);
  return String(yearOf(period.startDate));
}

export type Comparison = { tone: "better" | "worse" | "same"; headline: string; suffix: string };

export function comparison(current: number | null, previous: number | null, previousLabel: string): Comparison | null {
  if (current === null || previous === null) return null;
  const difference = current - previous;
  if (difference === 0) return { tone: "same", headline: `Same as ${previousLabel} (${previous}%)`, suffix: "" };
  const points = `${Math.abs(difference)} point${Math.abs(difference) === 1 ? "" : "s"}`;
  if (difference > 0) return { tone: "better", headline: `${points} better`, suffix: ` than ${previousLabel} (${previous}%)` };
  return { tone: "worse", headline: `${points} worse`, suffix: ` than ${previousLabel} (${previous}%)` };
}

export type ChartBucketLabel = { primary: string; secondary?: string; title: string; aria: string };

/** Labels for one bar: week buckets, month-unit weeks, and month-unit bars. */
export function chartBucketLabel(
  unit: DashboardUnit,
  bucket: { startDate: string; endDate: string },
  index: number,
): ChartBucketLabel {
  if (unit === "week") {
    const range = weekRangeShort(bucket.startDate, bucket.endDate);
    return { primary: dayMonth(bucket.startDate), secondary: `– ${dayMonth(bucket.endDate)}`, title: range, aria: range };
  }
  if (unit === "month") {
    const range = clippedWeekRange(bucket.startDate, bucket.endDate);
    const week = index + 1;
    return { primary: `Week ${week}`, secondary: range, title: `Week ${week} · ${range}`, aria: `Week ${week}, ${range}` };
  }
  const month = monthShort(bucket.startDate);
  return { primary: month, title: monthYear(bucket.startDate), aria: monthYear(bucket.startDate) };
}

const recurrenceSublineLabels: Record<Frequency, string> = {
  daily: "Every working day",
  every_other_day: "Every other calendar day, excluding non-working due dates",
  weekly: "Once a week",
  semimonthly: "Twice a month",
  monthly: "Once a month",
  quarterly: "Every 3 months",
  semiannually: "Every 6 months",
  annually: "Once a year",
};

export function recurrenceSubline(recurrence: Frequency) {
  return recurrenceSublineLabels[recurrence];
}

/** "2 JDs · every working day" / "1 JD · once a month". */
export function frequencySubline(recurrence: Frequency, jdCount: number) {
  const phrase = recurrenceSubline(recurrence);
  return `${jdCount} JD${jdCount === 1 ? "" : "s"} · ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
}

export function joinedLabels(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** "Quarterly, Bi-yearly and Yearly JDs: none were due in October." */
export function noneDueNote(labels: string[], periodName: string) {
  const when = periodName === "this week" ? "this week" : `in ${periodName}`;
  return `${joinedLabels(labels)} JDs: none were due ${when}.`;
}

export function daysLateLabel(days: number) {
  return `${days} day${days === 1 ? "" : "s"}`;
}

function stringParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTab(value: string | string[] | undefined): DashboardTab {
  return value === "tasks" ? "tasks" : "jd";
}

function parseUnit(value: string | string[] | undefined): DashboardUnit {
  return value === "week" || value === "month" || value === "quarter" || value === "year" ? value : "month";
}

export function parseDashboardSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): DashboardSearchState {
  const date = stringParam(searchParams.date);
  return {
    tab: parseTab(searchParams.tab),
    unit: parseUnit(searchParams.unit),
    date: date && isValidDateField(date) ? date : null,
    branch: stringParam(searchParams.branch),
    department: stringParam(searchParams.department),
  };
}

export type DashboardLinkState = DashboardQueryState & {
  branch?: string | null;
  department?: string | null;
};

/** Canonical query string: only non-default values are written. */
export function dashboardQueryString(state: DashboardLinkState) {
  const params = new URLSearchParams();
  if (state.tab !== "jd") params.set("tab", state.tab);
  if (state.unit !== "month") params.set("unit", state.unit);
  if (state.date) params.set("date", state.date);
  if (state.branch) params.set("branch", state.branch);
  if (state.department) params.set("department", state.department);
  return params.toString();
}

export function dashboardHref(state: DashboardLinkState) {
  const query = dashboardQueryString(state);
  return `/dashboard${query ? `?${query}` : ""}`;
}

export function employeeDashboardHref(membershipId: string, state: DashboardLinkState) {
  const query = dashboardQueryString(state);
  return `/dashboard/employees/${encodeURIComponent(membershipId)}${query ? `?${query}` : ""}`;
}

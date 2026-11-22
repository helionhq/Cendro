/**
 * When a month-based JD task's cycles end: monthly work that closes on the
 * 25th, or a yearly task that follows a 30 June tax year. Stored as
 * month * 100 + day (30 June → 630), the shape repeating holidays use; day 31
 * means the month's last day. Daily to semi-monthly tasks have no cycle end,
 * and the calendar default (31 December) is never stored.
 */
export const cycleEndRecurrences = ["monthly", "quarterly", "semiannually", "annually"] as const;
export type CycleEndRecurrence = (typeof cycleEndRecurrences)[number];
export type CalendarDate = { year: number; month: number; day: number };

export const DEFAULT_CYCLE_END = 1231;
export const LAST_DAY_OF_MONTH = 31;
/** Later days would not exist in every month, so only the last day is offered past the 28th. */
export const MAX_FIXED_CYCLE_END_DAY = 28;

const monthsPerCycle: Record<CycleEndRecurrence, number> = { monthly: 1, quarterly: 3, semiannually: 6, annually: 12 };

export function hasCycleEnd(recurrence: string): recurrence is CycleEndRecurrence {
  return (cycleEndRecurrences as readonly string[]).includes(recurrence);
}

export function cycleEndMonth(monthDay: number) {
  return Math.floor(monthDay / 100);
}

export function cycleEndDay(monthDay: number) {
  return monthDay % 100;
}

export function isValidCycleEnd(monthDay: number) {
  const month = cycleEndMonth(monthDay);
  const day = cycleEndDay(monthDay);
  return Number.isInteger(monthDay) && month >= 1 && month <= 12 && ((day >= 1 && day <= MAX_FIXED_CYCLE_END_DAY) || day === LAST_DAY_OF_MONTH);
}

/**
 * The stored form of a valid cycle end for a frequency, or undefined when it
 * is the calendar default or the frequency has none. A quarter ending 30 June
 * also ends 30 September, so each grid keeps one spelling: its December-most
 * month.
 */
export function normalizeCycleEnd(recurrence: string, monthDay: number | undefined): number | undefined {
  if (monthDay === undefined || !hasCycleEnd(recurrence)) return undefined;
  const span = monthsPerCycle[recurrence];
  const canonical = (12 - ((12 - cycleEndMonth(monthDay)) % span)) * 100 + cycleEndDay(monthDay);
  return canonical === DEFAULT_CYCLE_END ? undefined : canonical;
}

/**
 * The months a frequency's cycles can end in, one entry per grid: a quarterly
 * entry lists all four months it closes in, under its stored month.
 */
export function cycleEndMonthGroups(recurrence: CycleEndRecurrence): { month: number; months: number[] }[] {
  const span = monthsPerCycle[recurrence];
  return Array.from({ length: span }, (_, offset) => {
    const months = Array.from({ length: 12 / span }, (_, index) => offset + 1 + index * span);
    return { month: months[months.length - 1], months };
  });
}

function daysInMonth(monthIndex: number) {
  return new Date(Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 0)).getUTCDate();
}

function endDateIn(monthIndex: number, day: number): CalendarDate {
  return { year: Math.floor(monthIndex / 12), month: (monthIndex % 12) + 1, day: Math.min(day, daysInMonth(monthIndex)) };
}

/** The cycle containing `date`, as inclusive calendar dates. */
export function cycleDatesContaining(recurrence: CycleEndRecurrence, cycleEnd: number | undefined, date: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  const span = monthsPerCycle[recurrence];
  const anchor = cycleEnd ?? DEFAULT_CYCLE_END;
  const day = cycleEndDay(anchor);
  const monthIndex = date.year * 12 + date.month - 1;
  // The first month at or after this one that closes a cycle; once its end
  // day has passed, the cycle closes a whole span later.
  let endIndex = monthIndex + ((((cycleEndMonth(anchor) - 1 - monthIndex) % span) + span) % span);
  if (endIndex === monthIndex && date.day > endDateIn(endIndex, day).day) endIndex += span;
  const previousEnd = endDateIn(endIndex - span, day);
  const start = new Date(Date.UTC(previousEnd.year, previousEnd.month - 1, previousEnd.day + 1));
  return {
    start: { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() },
    end: endDateIn(endIndex, day),
  };
}

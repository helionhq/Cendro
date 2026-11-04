import { currentJdCycle, previousJdCycleStart } from "./taskCycles";

export const DAY_MS = 86_400_000;
export const SERVICE_DUE_SOON_KM = 500;
export const SERVICE_DUE_SOON_DAYS = 7;
export const FUEL_ANOMALY_RATIO = 0.75;
export const FUEL_ANOMALY_WINDOW_MS = 30 * DAY_MS;
export const FUEL_SPEND_SPIKE_RATIO = 1.3;
const FUEL_ANOMALY_PRIOR_VALUES = 5;

export type ServiceStatusValue = "overdue" | "due_soon" | "ok" | "unknown" | "not_configured";

export type ServiceStatus = {
  status: ServiceStatusValue;
  serviceIntervalKm: number | null;
  serviceIntervalDays: number | null;
  lastServicedAt: number | null;
  lastServiceOdometerMeters: number | null;
  nextDueOdometerMeters: number | null;
  nextDueAt: number | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
};

/**
 * Due status is derived on every read, never stored. The next due odometer is
 * the last service odometer plus the interval; the next due date is the last
 * service date plus the interval. Either passing makes the vehicle overdue.
 */
export function computeServiceStatus(args: {
  serviceIntervalKm?: number | null;
  serviceIntervalDays?: number | null;
  lastService: { servicedAt: number; odometerMeters?: number | null } | null;
  currentOdometerMeters?: number | null;
  now: number;
}): ServiceStatus {
  const serviceIntervalKm = args.serviceIntervalKm ?? null;
  const serviceIntervalDays = args.serviceIntervalDays ?? null;
  const lastService = args.lastService;
  const base: ServiceStatus = {
    status: "not_configured",
    serviceIntervalKm,
    serviceIntervalDays,
    lastServicedAt: lastService?.servicedAt ?? null,
    lastServiceOdometerMeters: lastService?.odometerMeters ?? null,
    nextDueOdometerMeters: null,
    nextDueAt: null,
    kmRemaining: null,
    daysRemaining: null,
  };

  if (serviceIntervalKm === null && serviceIntervalDays === null) return base;
  if (!lastService) return { ...base, status: "unknown" };

  let nextDueOdometerMeters: number | null = null;
  let kmRemaining: number | null = null;
  if (serviceIntervalKm !== null && lastService.odometerMeters != null) {
    nextDueOdometerMeters = lastService.odometerMeters + serviceIntervalKm * 1000;
    if (args.currentOdometerMeters != null) {
      kmRemaining = (nextDueOdometerMeters - args.currentOdometerMeters) / 1000;
    }
  }

  const nextDueAt = serviceIntervalDays !== null ? lastService.servicedAt + serviceIntervalDays * DAY_MS : null;
  const daysRemaining = nextDueAt !== null ? (nextDueAt - args.now) / DAY_MS : null;

  if (kmRemaining === null && daysRemaining === null) return { ...base, status: "unknown" };

  const overdue = (kmRemaining !== null && kmRemaining <= 0) || (daysRemaining !== null && daysRemaining <= 0);
  const dueSoon =
    (kmRemaining !== null && kmRemaining <= SERVICE_DUE_SOON_KM) ||
    (daysRemaining !== null && daysRemaining <= SERVICE_DUE_SOON_DAYS);

  return {
    ...base,
    status: overdue ? "overdue" : dueSoon ? "due_soon" : "ok",
    nextDueOdometerMeters,
    nextDueAt,
    kmRemaining,
    daysRemaining,
  };
}

export function serviceStatusRank(status: ServiceStatusValue) {
  switch (status) {
    case "overdue":
      return 0;
    case "due_soon":
      return 1;
    case "unknown":
      return 2;
    case "ok":
      return 3;
    case "not_configured":
      return 4;
  }
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export type FuelFill = {
  id: string;
  filledAt: number;
  litres: number;
  amount: number;
  odometerMeters: number | null;
};

export type FuelPoint = FuelFill & {
  kmPerL: number | null;
  medianKmPerL: number | null;
  anomaly: boolean;
};

/**
 * Full-to-full efficiency: for every fill-up after the first, km/L is the
 * odometer distance since the previous fill-up divided by this fill-up's
 * litres. An anomaly is a value below 75% of the median of that vehicle's
 * previous up-to-5 efficiencies, judged only with at least 3 prior values.
 */
export function computeFuelSeries(fills: readonly FuelFill[]): FuelPoint[] {
  const sorted = [...fills].sort((a, b) =>
    a.filledAt === b.filledAt ? a.id.localeCompare(b.id) : a.filledAt - b.filledAt,
  );
  const efficiencies: (number | null)[] = sorted.map(() => null);

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (current.odometerMeters === null || previous.odometerMeters === null) continue;
    if (!(current.litres > 0)) continue;
    const km = (current.odometerMeters - previous.odometerMeters) / 1000;
    if (!(km > 0)) continue;
    efficiencies[index] = km / current.litres;
  }

  return sorted.map((fill, index) => {
    const priorEfficiencies = efficiencies
      .slice(Math.max(0, index - FUEL_ANOMALY_PRIOR_VALUES), index)
      .filter((value): value is number => value !== null);
    const medianKmPerL = priorEfficiencies.length >= 3 ? median(priorEfficiencies) : null;
    const kmPerL = efficiencies[index];
    return {
      ...fill,
      kmPerL,
      medianKmPerL,
      anomaly:
        kmPerL !== null && medianKmPerL !== null && kmPerL < medianKmPerL * FUEL_ANOMALY_RATIO,
    };
  });
}

export type MonthWindows = {
  currentStart: number;
  previousStart: number;
  threeMonthsAgoStart: number;
};

/** Company-local month boundaries, reusing the JD calendar grid. */
export function fleetMonthWindows(now: number, timeZone: string | null | undefined): MonthWindows {
  const current = currentJdCycle("monthly", now, timeZone);
  const previousStart = previousJdCycleStart(current.start, "monthly", timeZone);
  const twoMonthsAgoStart = previousJdCycleStart(previousStart, "monthly", timeZone);
  const threeMonthsAgoStart = previousJdCycleStart(twoMonthsAgoStart, "monthly", timeZone);
  return {
    currentStart: current.start,
    previousStart,
    threeMonthsAgoStart,
  };
}

export type SpendSummary = {
  currentMonthSpend: number;
  previousMonthSpend: number;
  previousThreeMonthAverage: number;
  monthOverMonthChange: number | null;
  spendSpike: boolean;
  hasThreeMonthsHistory: boolean;
};

/**
 * A spike is this month's spend already above 130% of the previous three
 * complete months' average, only once the company has three months of history.
 * History is determined by the caller from the true earliest fill-up, because
 * the insight scan deliberately loads only the recent window.
 */
export function computeSpendSummary(
  fills: readonly { filledAt: number; amount: number }[],
  windows: MonthWindows,
  now: number,
  hasThreeMonthsHistory: boolean,
): SpendSummary {
  let currentMonthSpend = 0;
  let previousMonthSpend = 0;
  let previousThreeMonthSpend = 0;

  for (const fill of fills) {
    if (fill.filledAt >= windows.threeMonthsAgoStart && fill.filledAt < windows.currentStart) {
      previousThreeMonthSpend += fill.amount;
    }
    if (fill.filledAt >= windows.previousStart && fill.filledAt < windows.currentStart) {
      previousMonthSpend += fill.amount;
    }
    if (fill.filledAt >= windows.currentStart && fill.filledAt <= now) {
      currentMonthSpend += fill.amount;
    }
  }

  const previousThreeMonthAverage = hasThreeMonthsHistory ? previousThreeMonthSpend / 3 : 0;
  const spendSpike =
    hasThreeMonthsHistory &&
    (previousThreeMonthAverage > 0
      ? currentMonthSpend > previousThreeMonthAverage * FUEL_SPEND_SPIKE_RATIO
      : currentMonthSpend > 0);

  return {
    currentMonthSpend,
    previousMonthSpend,
    previousThreeMonthAverage,
    monthOverMonthChange:
      previousMonthSpend > 0 ? (currentMonthSpend - previousMonthSpend) / previousMonthSpend : null,
    spendSpike,
    hasThreeMonthsHistory,
  };
}

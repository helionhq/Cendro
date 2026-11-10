"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  formatInteger,
  formatLongDay,
  weekdayShort,
  type FleetDestinationCount,
  type FleetKmDay,
} from "./fleet-format";
import { EmptyPanel } from "./fleet-ui";
import { Route } from "lucide-react";

const stripedFill: CSSProperties = {
  background:
    "repeating-linear-gradient(135deg, var(--primary) 0 6px, color-mix(in srgb, var(--primary) 70%, white) 6px 12px)",
};

export function FleetKmChart({
  days,
  timeZone,
}: {
  days: FleetKmDay[];
  timeZone?: string;
}) {
  const maxKm = days.reduce((max, day) => Math.max(max, day.km), 0);
  const allZero = maxKm <= 0;
  const today = days[days.length - 1]?.dayStart;
  const summary = days
    .map((day) => `${weekdayShort(day.dayStart, timeZone)} ${Math.round(day.km)} km`)
    .join(", ");

  return (
    <div className="w-full">
      <p className="sr-only">This week: {summary}.</p>
      <div className="relative pt-5">
        <ul className="relative flex h-[160px] items-end gap-2 border-b border-[var(--hairline-strong)] sm:h-[180px]" aria-label="Distance by day, last 7 days">
          {days.map((day) => {
            const current = day.dayStart === today;
            const pct = maxKm > 0 ? (day.km / maxKm) * 100 : 0;
            const label = `${formatLongDay(day.dayStart, timeZone)}: ${Math.round(day.km)} km, ${day.trips} ${day.trips === 1 ? "trip" : "trips"}`;
            return (
              <li key={day.dayStart} className="group relative h-full min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]" tabIndex={0} aria-label={label}>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-max max-w-[200px] -translate-x-1/2 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] px-2.5 py-2 text-left shadow-[var(--shadow-popover)] group-hover:block group-focus-visible:block">
                  <div className="text-[12px] font-medium text-[var(--ink)]">
                    {formatLongDay(day.dayStart, timeZone)}
                  </div>
                  <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                    {Math.round(day.km)} km · {day.trips} {day.trips === 1 ? "trip" : "trips"}
                  </div>
                </div>
                {day.km > 0 ? (
                  <div
                    className="absolute bottom-0 left-1/2 w-full max-w-[36px] -translate-x-1/2"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                    aria-hidden="true"
                  >
                    <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap text-[12px] font-semibold tabular-nums text-[var(--ink)]">
                      {Math.round(day.km)}
                    </span>
                    <div
                      className="h-full w-full rounded-t-[4px]"
                      style={current ? stripedFill : { background: "var(--primary)" }}
                    />
                  </div>
                ) : (
                  <span className="absolute bottom-0 left-1/2 h-[2px] w-full max-w-[36px] -translate-x-1/2 bg-[var(--hairline-strong)]" aria-hidden="true" />
                )}
                <span className="sr-only">{label}</span>
              </li>
            );
          })}
          {allZero && (
            <div className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-[12.5px] text-[var(--ink-faint)]">
              No distance recorded this week.
            </div>
          )}
        </ul>
        <div className="mt-2 flex gap-2">
          {days.map((day, index) => {
            const current = index === days.length - 1;
            return (
              <div key={day.dayStart} className="min-w-0 flex-1 text-center" aria-hidden="true">
                <span
                  className={cn(
                    "text-[12px]",
                    current ? "font-semibold text-[var(--ink)]" : "text-[var(--ink-muted)]",
                  )}
                >
                  {weekdayShort(day.dayStart, timeZone)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export type DestinationBarRow = FleetDestinationCount & {
  key: string;
  other?: boolean;
};

export function DestinationBars({ rows }: { rows: DestinationBarRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyPanel
        icon={Route}
        title="No trips yet"
        body="Your top destinations will appear here after a few trips."
        className="py-8"
      />
    );
  }
  const maxCount = rows.reduce((max, row) => Math.max(max, row.count), 0);
  return (
    <ul className="grid gap-2.5" aria-label="Trips by destination, last 30 days">
      {rows.map((row) => {
        const width = maxCount > 0 ? Math.max(4, (row.count / maxCount) * 100) : 0;
        const isOther = row.other === true;
        return (
          <li
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_64px]"
          >
            <div className="min-w-0">
              <div className="truncate text-[13px] text-[var(--ink)]" title={row.destination}>
                {row.destination}
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-pressed)]">
                <div
                  className={cn("h-full rounded-full", isOther ? "bg-[var(--ink-faint)]" : "bg-[var(--primary)]")}
                  style={{ width: `${width}%` }}
                  aria-hidden="true"
                />
              </div>
              <span className="sr-only">
                {row.count} {row.count === 1 ? "trip" : "trips"} to {row.destination}
              </span>
            </div>
            <span className="text-right text-[12px] tabular-nums text-[var(--ink-muted)]">
              {formatInteger(row.count)} {row.count === 1 ? "trip" : "trips"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

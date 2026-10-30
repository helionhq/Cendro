"use client";

import type { FunctionReturnType } from "convex/server";
import type { CSSProperties } from "react";
import { api } from "../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { chartBucketLabel } from "./dashboard-format";

type DashboardData = FunctionReturnType<typeof api.analytics.dashboard>;
type Bucket = DashboardData["buckets"][number];
type DashboardUnit = DashboardData["period"]["unit"];
export type DashboardChartMode = "jd" | "tasks";

const stripedFill: CSSProperties = {
  background: "repeating-linear-gradient(135deg, var(--primary) 0 6px, color-mix(in srgb, var(--primary) 70%, white) 6px 12px)",
};
const dimmedFill: CSSProperties = {
  background: "color-mix(in srgb, var(--primary) 35%, var(--surface))",
};

function BucketTooltip({
  title,
  total,
  done,
  mode,
  align,
}: {
  title: string;
  total: number;
  done: number;
  mode: DashboardChartMode;
  align: "start" | "center" | "end";
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-full z-10 mb-2 hidden w-max max-w-[180px] rounded-xl border border-[var(--hairline)] bg-[var(--surface)] px-2.5 py-2 text-left shadow-[var(--shadow-popover)] group-hover:block group-focus-visible:block",
        align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
      )}
    >
      <div className="text-[12px] font-medium text-[var(--ink)]">{title}</div>
      {total === 0 ? (
        <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{mode === "jd" ? "No JDs due" : "No tasks assigned"}</div>
      ) : (
        <div className="mt-0.5 flex items-center justify-between gap-4 text-[12px] text-[var(--ink-muted)]">
          <span>Done</span>
          <span className="tabular-nums text-[var(--ink-secondary)]">
            {done} of {total}
          </span>
        </div>
      )}
    </div>
  );
}

export function DashboardBarChart({
  buckets,
  unit,
  mode,
}: {
  buckets: Bucket[];
  unit: DashboardUnit;
  mode: DashboardChartMode;
}) {
  const count = buckets.length;
  // Wide screens get a comfortable bar; narrow screens let flex shrink each
  // column so a 12-bar year fits a 360px phone without horizontal scrolling.
  const maxBarWidth = count <= 5 ? 60 : count <= 8 ? 44 : 34;
  const valueSize = count > 8 ? "text-[13px]" : "text-[14px]";
  // A value label ("100%" at this font size) needs about 38px to clear its
  // neighbour. Below these plot widths the labels are hidden; the bars, axis
  // and tooltips still carry the values.
  const valueVisibility =
    count > 8 ? "hidden @min-[520px]:block" : count > 6 ? "hidden @min-[360px]:block" : count > 5 ? "hidden @min-[268px]:block" : "block";
  const hasCurrent = buckets.some((bucket) => bucket.state === "current");
  const caption = mode === "jd" ? "JD completion by period" : "Task completion by period";

  return (
    <div className="w-full">
      <div className="flex">
        <div className="w-[38px] shrink-0" aria-hidden="true">
          <div className="relative mt-5 h-[206px]">
            {[
              { top: "0%", label: "100%" },
              { top: "50%", label: "50%" },
              { top: "100%", label: "0%" },
            ].map((line) => (
              <span
                key={line.label}
                className="absolute right-2 -translate-y-1/2 text-[11px] leading-none text-[var(--ink-faint)]"
                style={{ top: line.top }}
              >
                {line.label}
              </span>
            ))}
          </div>
        </div>
        <div className="@container min-w-0 flex-1">
          <div className="pt-5">
            <div className="relative h-[206px]">
              <div className="absolute inset-x-0 top-0 border-t border-dashed border-[var(--hairline-strong)]" aria-hidden="true" />
              <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--hairline-strong)]" aria-hidden="true" />
              <div className="absolute inset-x-0 bottom-0 border-t border-[var(--hairline-strong)]" aria-hidden="true" />
              <ul className="absolute inset-0 flex items-stretch gap-1 sm:gap-2" aria-label={caption}>
                {buckets.map((bucket, index) => {
                  const label = chartBucketLabel(unit, bucket, index);
                  const rate = mode === "jd" ? bucket.jd.completionRate : bucket.tasks.completionRate;
                  const total = mode === "jd" ? bucket.jd.due : bucket.tasks.assigned;
                  const done = mode === "jd" ? bucket.jd.done : bucket.tasks.done;
                  const selected = unit === "week" && index === count - 1;
                  const dimmed = unit === "week" && !selected;
                  const striped = bucket.state === "current";
                  const ariaLabel =
                    total === 0
                      ? `${label.aria}: ${mode === "jd" ? "no JDs due" : "no tasks assigned"}`
                      : `${label.aria}: ${rate}%, ${done} of ${total} done`;
                  return (
                    <li
                      key={`${bucket.startDate}-${bucket.endDate}`}
                      tabIndex={0}
                      aria-label={ariaLabel}
                      className="group relative min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                    >
                      <BucketTooltip
                        title={label.title}
                        total={total}
                        done={done}
                        mode={mode}
                        align={index === 0 ? "start" : index === count - 1 ? "end" : "center"}
                      />
                      {rate === null ? (
                        <span className="absolute inset-x-0 bottom-0 text-center text-[13px] leading-none text-[var(--ink-faint)]" aria-hidden="true">
                          —
                        </span>
                      ) : (
                        <div
                          className="absolute bottom-0 left-1/2 -translate-x-1/2"
                          style={{ width: "100%", maxWidth: `${maxBarWidth}px`, height: `${Math.max(0, Math.min(100, rate))}%` }}
                        >
                          <span
                            className={cn(
                              "absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap tabular-nums leading-none",
                              valueSize,
                              valueVisibility,
                              dimmed ? "font-medium text-[var(--ink-muted)]" : "font-semibold text-[var(--ink)]",
                            )}
                            aria-hidden="true"
                          >
                            {rate}%
                          </span>
                          <div
                            className="h-full w-full rounded-t-[4px]"
                            style={striped ? stripedFill : dimmed ? dimmedFill : { background: "var(--primary)" }}
                            aria-hidden="true"
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
          <ul className="mt-2 flex gap-1 sm:gap-2" aria-hidden="true">
            {buckets.map((bucket, index) => {
              const label = chartBucketLabel(unit, bucket, index);
              const selected = unit === "week" && index === count - 1;
              const muted = bucket.state === "future";
              return (
                <li key={`${bucket.startDate}-${bucket.endDate}-label`} className="flex min-w-0 flex-1 justify-center">
                  <div className="min-w-0 text-center">
                    <div
                      className={cn(
                        "truncate text-[12.5px] leading-tight",
                        selected ? "font-semibold text-[var(--ink)]" : muted ? "text-[var(--ink-faint)]" : "text-[var(--ink-secondary)]",
                      )}
                    >
                      {label.primary}
                    </div>
                    {label.secondary && (
                      <div
                        className={cn(
                          "truncate text-[11.5px] leading-tight",
                          selected ? "font-semibold text-[var(--ink)]" : "text-[var(--ink-faint)]",
                        )}
                      >
                        {label.secondary}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {hasCurrent && (
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[11.5px] text-[var(--ink-muted)]">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={stripedFill} aria-hidden="true" />
          {unit === "week" || unit === "month" ? "Week still running" : "Month still running"}
        </div>
      )}
    </div>
  );
}

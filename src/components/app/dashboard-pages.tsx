"use client";

import { ConvexError } from "convex/values";
import { useQuery_experimental } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { priorityLabels, recurrenceLabels } from "@/lib/task-import/labels";
import { canViewDashboard } from "@/lib/permissions";
import { cn, initials } from "@/lib/utils";
import { useCompany } from "./company-context";
import { DashboardBarChart, type DashboardChartMode } from "./dashboard-charts";
import {
  comparison,
  dashboardHref,
  dashboardQueryString,
  daysLateLabel,
  employeeDashboardHref,
  frequencySubline,
  heroCaption,
  noneDueNote,
  parseDashboardSearchParams,
  periodDisplayName,
  periodStepperLabel,
  previousPeriodLabel,
  recurrenceSubline,
  weekdayDayMonth,
  dayMonth,
  type DashboardQueryState,
  type DashboardSearchState,
  type DashboardTab,
  type DashboardUnit,
} from "./dashboard-format";
import { PageHeader } from "./page-header";

type DashboardFilters = FunctionReturnType<typeof api.analytics.dashboardFilters>;
type DashboardData = FunctionReturnType<typeof api.analytics.dashboard>;
type Period = DashboardData["period"];
type FrequencyRow = DashboardData["jd"]["byFrequency"][number];
type PriorityRow = DashboardData["tasks"]["byPriority"][number];
type JdNotDone = DashboardData["jd"]["notDone"][number];
type TaskNotDone = DashboardData["tasks"]["notDone"][number];

const numberFormat = new Intl.NumberFormat("en-US");

const filterTriggerClass =
  "h-[30px] min-w-[136px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] font-normal text-[var(--ink-secondary)] shadow-none hover:bg-[var(--surface-muted)] data-[state=open]:bg-[var(--surface-muted)]";

const cardTitleClass = "px-1.5 pb-2 pt-1";
const tableHeadClass = "text-[11.5px] font-medium text-[var(--ink-faint)]";
const tableRowClass = "border-b border-[var(--hairline)] py-2.5 text-[13px] last:border-0";

function Frame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-2", className)}>{children}</div>;
}

function Inset({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-lg border border-[var(--hairline)] bg-[var(--surface-muted)]", className)}>{children}</div>;
}

function Card({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <Frame>
      <div className={cn(cardTitleClass, "flex items-baseline justify-between gap-3")}>
        <span className="text-[13.5px] font-semibold text-[var(--ink)]">{title}</span>
        {caption && <span className="text-right text-[12.5px] text-[var(--ink-muted)]">{caption}</span>}
      </div>
      {/* Tables switch on their own width: the 246px sidebar can leave a 768px viewport too narrow for the wide columns. */}
      <Inset className="@container px-3.5 py-1.5">{children}</Inset>
    </Frame>
  );
}

// Lists show the newest work up to a cap; the counts above them stay exact.
function shownOf(shown: number, total: number) {
  return shown < total ? `Showing ${numberFormat.format(shown)} of ${numberFormat.format(total)}` : undefined;
}

function EmptyRows({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12.5px] text-[var(--ink-faint)]">{children}</p>;
}

function MiniBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]", className)}>
      <div
        className="h-full rounded-full bg-[var(--primary)]"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function CompletionCell({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <MiniBar value={value} className="w-[52px] flex-none @xl:w-[170px]" />
      <span className="w-9 text-right text-[13px] font-semibold tabular-nums text-[var(--ink)]">{value}%</span>
    </div>
  );
}

const heroPillTone = {
  green: "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]",
  red: "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]",
  yellow: "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
  neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]",
} as const;

const priorityTone = {
  critical: "bg-[var(--priority-critical-bg)] text-[var(--priority-critical-fg)]",
  high: "bg-[var(--priority-high-bg)] text-[var(--priority-high-fg)]",
  medium: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
  low: "bg-[var(--priority-low-bg)] text-[var(--priority-low-fg)]",
} as const;

function PriorityPill({ priority }: { priority: PriorityRow["priority"] }) {
  return (
    <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium", priorityTone[priority])}>
      {priorityLabels[priority]}
    </span>
  );
}

function StatusPill({ status }: { status: "missed" | "waiting" | "overdue" }) {
  const red = status !== "waiting";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium",
        red ? "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]" : "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
      )}
    >
      {status === "waiting" ? "Waiting for approval" : status === "overdue" ? "Overdue" : "Missed"}
    </span>
  );
}

function useRoundedNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 300_000) * 300_000);
  useEffect(() => {
    const interval = setInterval(() => {
      setNow((previous) => {
        const next = Math.floor(Date.now() / 300_000) * 300_000;
        return previous === next ? previous : next;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  if (error instanceof Error) return error.message;
  return "Could not load the dashboard.";
}

function PeriodControl({
  unit,
  period,
  steppingDisabled,
  onUnitChange,
  onPrevious,
  onNext,
}: {
  unit: DashboardUnit;
  period: Period;
  steppingDisabled: boolean;
  onUnitChange: (unit: DashboardUnit) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const stepButtonClass =
    "grid h-full w-8 place-items-center text-[var(--ink-muted)] outline-none hover:bg-[var(--surface-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={unit} onValueChange={(value) => onUnitChange(value as DashboardUnit)}>
        <TabsList aria-label="Period unit" className="h-8 gap-0 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] p-0.5">
          {(["week", "month", "quarter", "year"] as const).map((value) => (
            <TabsTrigger key={value} value={value} className="px-2.5 py-1 text-[12.5px]">
              {value === "week" ? "Week" : value === "month" ? "Month" : value === "quarter" ? "Quarter" : "Year"}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="inline-flex h-8 items-center rounded-md border border-[var(--hairline)] bg-[var(--surface)]">
        <button type="button" aria-label="Previous period" onClick={onPrevious} disabled={steppingDisabled} className={cn(stepButtonClass, "rounded-l-md")}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[148px] whitespace-nowrap px-2 text-center text-[13px] font-medium tabular-nums text-[var(--ink)]">
          {periodStepperLabel(period)}
        </span>
        <button
          type="button"
          aria-label="Next period"
          onClick={onNext}
          disabled={steppingDisabled || period.nextDate === null}
          className={cn(stepButtonClass, "rounded-r-md")}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function HeroCard({ mode, data }: { mode: DashboardChartMode; data: DashboardData }) {
  const isJd = mode === "jd";
  const rate = isJd ? data.jd.completionRate : data.tasks.completionRate;
  const previous = isJd ? data.jd.previousCompletionRate : data.tasks.previousCompletionRate;
  const done = isJd ? data.jd.done : data.tasks.done;
  const total = isJd ? data.jd.due : data.tasks.assigned;
  const change = comparison(rate, previous, previousPeriodLabel(data.period));
  const rows = isJd
    ? [
        { label: "Done", value: data.jd.done, tone: "green" as const },
        { label: "Missed", value: data.jd.missed, tone: "red" as const },
        { label: "Waiting for approval", value: data.jd.waiting, tone: "yellow" as const },
      ]
    : [
        { label: "Done", value: data.tasks.done, tone: "green" as const },
        { label: "Overdue", value: data.tasks.overdue, tone: "red" as const },
        { label: "Not due yet", value: data.tasks.notDueYet, tone: "neutral" as const },
        { label: "Waiting for approval", value: data.tasks.waiting, tone: "yellow" as const },
      ];

  return (
    <Frame>
      <div className={cn(cardTitleClass, "flex items-baseline justify-between gap-3")}>
        <span className="text-[13.5px] font-semibold text-[var(--ink)]">{isJd ? "JD completion" : "Task completion"}</span>
        <span className="text-right text-[12.5px] text-[var(--ink-muted)]">{heroCaption(mode, data.period)}</span>
      </div>
      <Inset>
        <div className="px-[18px] pb-4 pt-5">
          <div className="text-[60px] font-[650] leading-[0.95] tracking-[-0.04em] tabular-nums text-[var(--ink)]">
            {rate === null ? "—" : `${rate}%`}
          </div>
          <div className="mt-1.5 text-[12.5px] text-[var(--ink-muted)]">
            {total === 0
              ? isJd
                ? "No JDs were due"
                : "No tasks were assigned"
              : `${numberFormat.format(done)} of ${numberFormat.format(total)} ${isJd ? "JDs" : "tasks"} done`}
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--hairline)]">
            <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: `${rate ?? 0}%` }} />
          </div>
          <div className="mt-4 divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span className="text-[var(--ink-secondary)]">{row.label}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums", heroPillTone[row.tone])}>
                  {numberFormat.format(row.value)}
                </span>
              </div>
            ))}
          </div>
          {change && (
            <p className="mt-3 flex items-center gap-1 text-[12.5px] text-[var(--ink-muted)]">
              {change.tone === "better" && <ArrowUp className="h-3 w-3 shrink-0 text-[var(--badge-green-fg)]" aria-hidden="true" />}
              {change.tone === "worse" && <ArrowDown className="h-3 w-3 shrink-0 text-[var(--badge-red-fg)]" aria-hidden="true" />}
              <span>
                <span
                  className={cn(
                    change.tone === "better" && "font-semibold text-[var(--badge-green-fg)]",
                    change.tone === "worse" && "font-semibold text-[var(--badge-red-fg)]",
                  )}
                >
                  {change.headline}
                </span>
                {change.suffix && <span>{change.suffix}</span>}
              </span>
            </p>
          )}
        </div>
      </Inset>
    </Frame>
  );
}

function ChartCard({ mode, data }: { mode: DashboardChartMode; data: DashboardData }) {
  const unit = data.period.unit;
  const monthlyBuckets = unit === "quarter" || unit === "year";
  const title = unit === "week" ? "Last 8 weeks" : unit === "month" ? "Week by week" : "Month by month";
  const selectedNote = unit === "week" ? " · selected week in dark blue" : "";
  const caption =
    mode === "jd"
      ? `% of JDs done each ${monthlyBuckets ? "month" : "week"}${selectedNote}`
      : `% of tasks assigned each ${monthlyBuckets ? "month" : "week"} that are done${selectedNote}`;
  return (
    <Frame className="min-w-0">
      <div className={cn(cardTitleClass, "flex items-baseline justify-between gap-3")}>
        <span className="text-[13.5px] font-semibold text-[var(--ink)]">{title}</span>
        <span className="text-right text-[12.5px] text-[var(--ink-muted)]">{caption}</span>
      </div>
      <Inset className="px-3 pb-3 pt-1 sm:px-4">
        <DashboardBarChart buckets={data.buckets} unit={unit} mode={mode} />
      </Inset>
    </Frame>
  );
}

function ByFrequencyCard({ rows, showJdCounts, period }: { rows: FrequencyRow[]; showJdCounts: boolean; period: Period }) {
  const shown = rows.filter((row) => row.due > 0 || row.upcoming !== null);
  const otherLabels = rows
    .filter((row) => row.due === 0 && row.upcoming === null && row.jdCount > 0)
    .map((row) => recurrenceLabels[row.recurrence]);
  const grid = "grid grid-cols-[minmax(0,1fr)_56px_112px] items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_64px_52px_110px_220px]";
  return (
    <Card title="By frequency">
      {shown.length === 0 && otherLabels.length === 0 ? (
        <EmptyRows>No JDs in this period.</EmptyRows>
      ) : (
        <>
          {shown.length > 0 && (
            <>
              <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
                <div>Frequency</div>
                <div className="text-right">Done</div>
                <div className="hidden text-right @xl:block">Missed</div>
                <div className="hidden text-right @xl:block">Waiting for approval</div>
                <div>Completion</div>
              </div>
              {shown.map((row) => (
                <div key={row.recurrence} className={cn(grid, tableRowClass)}>
                  <div className="min-w-0">
                    <div className="truncate text-[var(--ink)]">{recurrenceLabels[row.recurrence]}</div>
                    <div className="truncate text-[11.5px] text-[var(--ink-faint)]">
                      {showJdCounts
                        ? frequencySubline(row.recurrence, row.jdCount)
                        : recurrenceSubline(row.recurrence)}
                    </div>
                  </div>
                  <div className="text-right tabular-nums text-[var(--ink-secondary)]">
                    {row.due > 0 ? `${numberFormat.format(row.done)} of ${numberFormat.format(row.due)}` : "—"}
                  </div>
                  <div
                    className={cn(
                      "hidden text-right tabular-nums @xl:block",
                      row.due === 0 ? "text-[var(--ink-faint)]" : row.missed > 0 ? "text-[var(--badge-red-fg)]" : "text-[var(--ink-faint)]",
                    )}
                  >
                    {row.due > 0 ? numberFormat.format(row.missed) : "—"}
                  </div>
                  <div className={cn("hidden text-right tabular-nums @xl:block", row.due > 0 ? "text-[var(--ink-secondary)]" : "text-[var(--ink-faint)]")}>
                    {row.due > 0 ? numberFormat.format(row.waiting) : "—"}
                  </div>
                  <div className="min-w-0">
                    {row.due > 0 ? (
                      <CompletionCell value={row.completionRate ?? 0} />
                    ) : (
                      <span className="text-[12.5px] leading-snug text-[var(--ink-muted)]">
                        {row.upcoming
                          ? `${row.upcoming.count} JD${row.upcoming.count === 1 ? "" : "s"} due on ${dayMonth(row.upcoming.dueDate)} · counted then`
                          : "—"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
          {otherLabels.length > 0 && (
            <p className="py-2.5 text-[12.5px] text-[var(--ink-muted)]">{noneDueNote(otherLabels, periodDisplayName(period))}</p>
          )}
        </>
      )}
    </Card>
  );
}

type EmployeeRow = {
  membershipId: Id<"companyMemberships">;
  name: string;
  departments: string;
  done: number;
  total: number;
  problems: number;
  completionRate: number;
};

function EmployeesCard({
  rows,
  doneLabel,
  problemLabel,
  emptyText,
  state,
}: {
  rows: EmployeeRow[];
  doneLabel: string;
  problemLabel: string;
  emptyText: string;
  state: DashboardQueryState;
}) {
  const grid = "grid grid-cols-[18px_minmax(0,1fr)_56px_92px_12px] items-center gap-2 @lg:grid-cols-[18px_minmax(0,1fr)_76px_52px_190px_12px]";
  return (
    <Card title="Employees">
      {rows.length === 0 ? (
        <EmptyRows>{emptyText}</EmptyRows>
      ) : (
        <>
          <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
            <div>#</div>
            <div>Employee</div>
            <div className="text-right">{doneLabel}</div>
            <div className="hidden text-right @lg:block">{problemLabel}</div>
            <div>Completion</div>
            <div />
          </div>
          {rows.map((row, index) => (
            <Link
              key={row.membershipId}
              href={employeeDashboardHref(row.membershipId, state)}
              className={cn(
                grid,
                tableRowClass,
                "tabular-nums outline-none hover:bg-[var(--surface)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
              )}
            >
              <span className="text-[12px] text-[var(--ink-faint)]">{index + 1}</span>
              <span className="min-w-0">
                <span className="block truncate text-[var(--ink)]">{row.name}</span>
                {row.departments && <span className="block truncate text-[11.5px] text-[var(--ink-faint)]">{row.departments}</span>}
              </span>
              <span className="text-right text-[var(--ink-secondary)]">
                {numberFormat.format(row.done)} of {numberFormat.format(row.total)}
              </span>
              <span className={cn("hidden text-right @lg:block", row.problems > 0 ? "text-[var(--badge-red-fg)]" : "text-[var(--ink-faint)]")}>
                {numberFormat.format(row.problems)}
              </span>
              <span className="flex items-center gap-2">
                <MiniBar value={row.completionRate} className="w-12 flex-none @lg:w-[140px]" />
                <span className="w-9 text-right font-semibold text-[var(--ink)]">{row.completionRate}%</span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-[var(--ink-faint)]" aria-hidden="true" />
            </Link>
          ))}
        </>
      )}
    </Card>
  );
}

function JdNotDoneCard({ rows, total }: { rows: JdNotDone[]; total: number }) {
  const grid = "grid grid-cols-[72px_minmax(0,1fr)_120px] items-center gap-2 @lg:grid-cols-[92px_minmax(0,1fr)_110px_132px]";
  return (
    <Card title="JDs not done" caption={shownOf(rows.length, total)}>
      {rows.length === 0 ? (
        <EmptyRows>Nothing was missed in this period.</EmptyRows>
      ) : (
        <>
          <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
            <div>Due</div>
            <div>Job description</div>
            <div className="hidden @lg:block">Frequency</div>
            <div>Status</div>
          </div>
          {rows.map((row) => (
            <div key={`${row.taskId}-${row.dueDate}`} className={cn(grid, tableRowClass)}>
              <div className="whitespace-nowrap text-[12.5px] text-[var(--ink-secondary)]">{weekdayDayMonth(row.dueDate)}</div>
              <div className="min-w-0">
                <div className="truncate text-[var(--ink)]">{row.title}</div>
                <div className="truncate text-[11.5px] text-[var(--ink-faint)]">{row.reference}</div>
              </div>
              <div className="hidden truncate text-[12.5px] text-[var(--ink-secondary)] @lg:block">{recurrenceLabels[row.recurrence]}</div>
              <div>
                <StatusPill status={row.status} />
              </div>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function ByPriorityCard({ rows }: { rows: PriorityRow[] }) {
  const assigned = rows.filter((row) => row.assigned > 0);
  const grid = "grid grid-cols-[minmax(0,1fr)_48px_44px_104px] items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_64px_62px_110px_220px]";
  return (
    <Card title="By priority">
      {assigned.length === 0 ? (
        <EmptyRows>No tasks were assigned in this period.</EmptyRows>
      ) : (
        <>
          <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
            <div>Priority</div>
            <div className="text-right">Done</div>
            <div className="text-right">Overdue</div>
            <div className="hidden text-right @xl:block">Waiting for approval</div>
            <div>Completion</div>
          </div>
          {assigned.map((row) => (
            <div key={row.priority} className={cn(grid, tableRowClass)}>
              <div>
                <PriorityPill priority={row.priority} />
              </div>
              <div className="text-right tabular-nums text-[var(--ink-secondary)]">
                {numberFormat.format(row.done)} of {numberFormat.format(row.assigned)}
              </div>
              <div className={cn("text-right tabular-nums", row.overdue > 0 ? "text-[var(--badge-red-fg)]" : "text-[var(--ink-faint)]")}>
                {numberFormat.format(row.overdue)}
              </div>
              <div className="hidden text-right tabular-nums text-[var(--ink-secondary)] @xl:block">{numberFormat.format(row.waiting)}</div>
              <div className="min-w-0">
                <CompletionCell value={row.completionRate ?? 0} />
              </div>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function OverdueTasksCard({ rows, total }: { rows: TaskNotDone[]; total: number }) {
  const overdue = rows.filter((row) => row.status === "overdue");
  const grid = "grid grid-cols-[minmax(0,1fr)_56px_72px] items-center gap-2 @lg:grid-cols-[minmax(0,1fr)_120px_96px_70px_84px]";
  return (
    <Card title="Overdue tasks" caption={shownOf(overdue.length, total)}>
      {overdue.length === 0 ? (
        <EmptyRows>No overdue tasks.</EmptyRows>
      ) : (
        <>
          <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
            <div>Task</div>
            <div className="hidden @lg:block">Assigned to</div>
            <div className="hidden @lg:block">Was due</div>
            <div className="text-right">Late by</div>
            <div>Priority</div>
          </div>
          {overdue.map((row) => (
            <div key={row.taskId} className={cn(grid, tableRowClass)}>
              <div className="min-w-0">
                <div className="truncate text-[var(--ink)]">{row.title}</div>
                <div className="truncate text-[11.5px] text-[var(--ink-faint)]">{row.reference}</div>
              </div>
              <div className="hidden truncate text-[12.5px] text-[var(--ink-secondary)] @lg:block">
                {row.assignees.length > 0 ? row.assignees.join(", ") : "—"}
              </div>
              <div className="hidden whitespace-nowrap text-[12.5px] text-[var(--ink-secondary)] @lg:block">
                {row.dueDate ? weekdayDayMonth(row.dueDate) : "—"}
              </div>
              <div className="text-right text-[12.5px] text-[var(--badge-red-fg)]">
                {row.daysLate === null ? "—" : daysLateLabel(row.daysLate)}
              </div>
              <div>
                <PriorityPill priority={row.priority} />
              </div>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function TasksNotDoneCard({ rows, total }: { rows: TaskNotDone[]; total: number }) {
  const grid = "grid grid-cols-[minmax(0,1fr)_48px_124px] items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_96px_72px_80px_140px]";
  return (
    <Card title="Tasks not done" caption={shownOf(rows.length, total)}>
      {rows.length === 0 ? (
        <EmptyRows>Nothing is overdue or waiting in this period.</EmptyRows>
      ) : (
        <>
          <div className={cn(grid, "border-b border-[var(--hairline)] pb-2", tableHeadClass)}>
            <div>Task</div>
            <div className="hidden @xl:block">Was due</div>
            <div className="text-right">Late by</div>
            <div className="hidden @xl:block">Priority</div>
            <div>Status</div>
          </div>
          {rows.map((row) => (
            <div key={row.taskId} className={cn(grid, tableRowClass)}>
              <div className="min-w-0">
                <div className="truncate text-[var(--ink)]">{row.title}</div>
                <div className="truncate text-[11.5px] text-[var(--ink-faint)]">{row.reference}</div>
                <div className="mt-1 @xl:hidden">
                  <PriorityPill priority={row.priority} />
                </div>
              </div>
              <div className="hidden whitespace-nowrap text-[12.5px] text-[var(--ink-secondary)] @xl:block">
                {row.dueDate ? weekdayDayMonth(row.dueDate) : "—"}
              </div>
              <div className={cn("text-right text-[12.5px]", row.status === "overdue" ? "text-[var(--badge-red-fg)]" : "text-[var(--ink-faint)]")}>
                {row.daysLate === null ? "—" : daysLateLabel(row.daysLate)}
              </div>
              <div className="hidden @xl:block">
                <PriorityPill priority={row.priority} />
              </div>
              <div>
                <StatusPill status={row.status} />
              </div>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function EmployeeHeader({
  data,
  state,
  actions,
}: {
  data: DashboardData;
  state: DashboardSearchState;
  actions: React.ReactNode;
}) {
  const name = data.employee?.name ?? "Employee";
  const subline = [data.employee?.departments, data.employee?.branches].filter(Boolean).join(" · ");
  return (
    <div className="mb-5">
      <Link
        href={dashboardHref(state)}
        className="inline-flex items-center gap-0.5 rounded text-[12.5px] font-medium text-[var(--ink-muted)] outline-none hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Dashboard
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--surface-pressed)] text-[15px] font-semibold text-[var(--ink-secondary)]"
            aria-hidden="true"
          >
            {initials(name)}
          </span>
          <div className="min-w-0">
            <h1 className="page-title truncate">{name}</h1>
            {subline && <p className="mt-0.5 truncate text-[13px] text-[var(--ink-muted)]">{subline}</p>}
          </div>
        </div>
        <div className="shrink-0">{actions}</div>
      </div>
    </div>
  );
}

const tabTriggerClass =
  "relative rounded-none border-0 bg-transparent px-0 pb-3 pt-1 text-[13.5px] font-medium text-[var(--ink-muted)] shadow-none outline-none transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent after:content-[''] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--ink)] data-[state=active]:after:bg-[var(--ink)]";

type ViewBase = {
  data: DashboardData;
  pending: boolean;
  steppingDisabled: boolean;
  tab: DashboardTab;
  unit: DashboardUnit;
  date: string | null;
  onTabChange: (tab: DashboardTab) => void;
  onUnitChange: (unit: DashboardUnit) => void;
  onPrevious: () => void;
  onNext: () => void;
};

type DashboardViewProps = ViewBase &
  (
    | {
        mode: "dashboard";
        filters: DashboardFilters | null;
        branchId: Id<"branches"> | null;
        departmentId: Id<"departments"> | null;
        onBranchChange: (branchId: Id<"branches"> | null) => void;
        onDepartmentChange: (departmentId: Id<"departments"> | null) => void;
      }
    | { mode: "employee"; returnBranch: string | null; returnDepartment: string | null }
  );

function DashboardView(props: DashboardViewProps) {
  const { data, pending, steppingDisabled, tab, unit, date, onTabChange, onUnitChange, onPrevious, onNext } = props;
  const linkState: DashboardSearchState =
    props.mode === "dashboard"
      ? { tab, unit, date, branch: props.branchId, department: props.departmentId }
      : { tab, unit, date, branch: props.returnBranch, department: props.returnDepartment };
  const filters = props.mode === "dashboard" ? props.filters : null;
  const filterOptions = props.mode === "dashboard" && data.scope === "team" ? filters : null;
  const personView = props.mode === "employee" || data.scope === "self";
  const departments =
    props.mode === "dashboard" && filterOptions
      ? props.branchId
        ? filterOptions.departments.filter((department) => department.branchId === props.branchId)
        : filterOptions.departments
      : [];
  const truncated = data.isTruncated || (props.mode === "dashboard" && Boolean(props.filters?.isTruncated));

  const periodControl = (
    <PeriodControl
      unit={unit}
      period={data.period}
      steppingDisabled={steppingDisabled}
      onUnitChange={onUnitChange}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  );

  return (
    <div className="app-page @container">
      {props.mode === "employee" ? (
        <EmployeeHeader data={data} state={linkState} actions={periodControl} />
      ) : (
        <PageHeader
          title="Dashboard"
          description="How much work got done, and by whom."
          actions={periodControl}
        />
      )}
      <div className={cn("transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined}>
        <Tabs value={tab} onValueChange={(value) => onTabChange(value === "tasks" ? "tasks" : "jd")}>
          <div className="flex items-end justify-between gap-3 border-b border-[var(--hairline)]">
            <TabsList className="flex items-stretch gap-5 rounded-none border-0 bg-transparent p-0">
              <TabsTrigger value="jd" className={tabTriggerClass}>
                Job descriptions
              </TabsTrigger>
              <TabsTrigger value="tasks" className={tabTriggerClass}>
                One-time tasks
              </TabsTrigger>
            </TabsList>
            {filterOptions && props.mode === "dashboard" && (
              <div className="flex flex-wrap items-center justify-end gap-2 pb-2">
                {filterOptions.branches.length >= 2 && (
                  <Select
                    value={props.branchId ?? "all"}
                    onValueChange={(value) => props.onBranchChange(value === "all" ? null : (value as Id<"branches">))}
                  >
                    <SelectTrigger aria-label="Branch" className={cn(filterTriggerClass, props.branchId && "text-[var(--ink)]")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-[13px]">All branches</SelectItem>
                      {filterOptions.branches.map((branch) => (
                        <SelectItem key={branch._id} value={branch._id} className="text-[13px]">{branch.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {filterOptions.departments.length >= 2 && (
                  <Select
                    value={props.departmentId ?? "all"}
                    onValueChange={(value) => props.onDepartmentChange(value === "all" ? null : (value as Id<"departments">))}
                  >
                    <SelectTrigger aria-label="Department" className={cn(filterTriggerClass, props.departmentId && "text-[var(--ink)]")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-[13px]">All departments</SelectItem>
                      {departments.map((department) => (
                        <SelectItem key={department._id} value={department._id} className="text-[13px]">{department.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
          {truncated && (
            <p className="mt-3 text-[12.5px] text-[var(--ink-muted)]">
              Some records and filter options were omitted because this workspace exceeds the reporting limit.
            </p>
          )}
          <TabsContent value="jd" className="mt-5 space-y-4 outline-none">
            <div className="grid gap-4 @3xl:grid-cols-[330px_minmax(0,1fr)]">
              <HeroCard mode="jd" data={data} />
              <ChartCard mode="jd" data={data} />
            </div>
            <ByFrequencyCard rows={data.jd.byFrequency} showJdCounts={props.mode === "employee"} period={data.period} />
            {personView ? (
              <JdNotDoneCard rows={data.jd.notDone} total={data.jd.missed + data.jd.waiting} />
            ) : (
              <EmployeesCard
                rows={data.jd.employees.map((row) => ({ ...row, total: row.due, problems: row.missed }))}
                doneLabel="JDs done"
                problemLabel="Missed"
                emptyText="No JDs were due for anyone in this period."
                state={linkState}
              />
            )}
          </TabsContent>
          <TabsContent value="tasks" className="mt-5 space-y-4 outline-none">
            <div className="grid gap-4 @3xl:grid-cols-[330px_minmax(0,1fr)]">
              <HeroCard mode="tasks" data={data} />
              <ChartCard mode="tasks" data={data} />
            </div>
            <ByPriorityCard rows={data.tasks.byPriority} />
            {personView ? (
              <TasksNotDoneCard rows={data.tasks.notDone} total={data.tasks.overdue + data.tasks.waiting} />
            ) : (
              <>
                <OverdueTasksCard rows={data.tasks.notDone} total={data.tasks.overdue} />
                <EmployeesCard
                  rows={data.tasks.employees.map((row) => ({ ...row, total: row.assigned, problems: row.overdue }))}
                  doneLabel="Tasks done"
                  problemLabel="Overdue"
                  emptyText="No tasks were assigned to anyone in this period."
                  state={linkState}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  const block = "animate-pulse rounded-xl bg-[var(--surface-muted)]";
  return (
    <div className="app-page @container">
      <div className={cn(block, "mb-5 h-8 w-44")} />
      <div className={cn(block, "mb-5 h-9 w-full max-w-md")} />
      <div className="grid gap-4 @3xl:grid-cols-[330px_minmax(0,1fr)]">
        <div className={cn(block, "h-[300px]")} />
        <div className={cn(block, "h-[300px]")} />
      </div>
      <div className={cn(block, "mt-4 h-[220px]")} />
      <div className={cn(block, "mt-4 h-[220px]")} />
    </div>
  );
}

type DashboardQueryOptions = {
  companyId: Id<"companies"> | null;
  now: number;
  unit: DashboardUnit;
  date: string | null;
  branchId: string | null;
  departmentId: string | null;
  membershipId?: Id<"companyMemberships">;
  withFilters: boolean;
};

function useDashboardData({
  companyId,
  now,
  unit,
  date,
  branchId,
  departmentId,
  membershipId,
  withFilters,
}: DashboardQueryOptions) {
  const [cachedFilters, setCachedFilters] = useState<{ companyId: Id<"companies">; filters: DashboardFilters } | null>(null);
  // Per-key result cache: revisiting a combination restores instantly while
  // the query revalidates in the background.
  const [dataCache] = useState(() => new Map<string, DashboardData>());
  const [last, setLast] = useState<{ companyId: Id<"companies">; membershipId: string | null; data: DashboardData } | null>(null);

  useEffect(() => {
    dataCache.clear();
    setLast(null);
  }, [companyId, dataCache]);

  const filtersResult = useQuery_experimental({
    query: api.analytics.dashboardFilters,
    args: withFilters && companyId ? { companyId } : "skip",
  });
  const filtersData = withFilters && filtersResult.status === "success" ? filtersResult.data : null;

  const validBranchId =
    branchId && filtersData?.branches.some((branch) => branch._id === branchId) ? (branchId as Id<"branches">) : undefined;
  const validDepartmentId =
    departmentId &&
    filtersData?.departments.some(
      (department) => department._id === departmentId && (!validBranchId || department.branchId === validBranchId),
    )
      ? (departmentId as Id<"departments">)
      : undefined;

  const cacheKey = `${companyId ?? ""}|${unit}|${date ?? ""}|${validBranchId ?? ""}|${validDepartmentId ?? ""}|${membershipId ?? ""}`;
  const result = useQuery_experimental({
    query: api.analytics.dashboard,
    args: companyId
      ? {
          companyId,
          now,
          period: date ? { unit, date } : { unit },
          branchId: validBranchId,
          departmentId: validDepartmentId,
          membershipId,
        }
      : "skip",
  });

  const liveData = result.status === "success" ? result.data : null;
  useEffect(() => {
    if (!liveData || !companyId) return;
    dataCache.set(cacheKey, liveData);
    if (dataCache.size > 24) dataCache.delete(dataCache.keys().next().value!);
    setLast({ companyId, membershipId: membershipId ?? null, data: liveData });
  }, [liveData, cacheKey, companyId, membershipId, dataCache]);

  useEffect(() => {
    if (filtersData && companyId) setCachedFilters({ companyId, filters: filtersData });
  }, [filtersData, companyId]);

  const viewFilters = filtersData ?? (cachedFilters?.companyId === companyId ? cachedFilters.filters : null);
  const cachedData = dataCache.get(cacheKey);
  const lastData = last?.companyId === companyId && last.membershipId === (membershipId ?? null) ? last.data : null;
  // The requested selection is served from the live result or the cache for
  // its key; the last successful result is only a placeholder for another
  // selection while the new one loads.
  const requestedData = liveData ?? cachedData ?? null;
  const viewData = requestedData ?? lastData;

  const filtersError = withFilters && filtersResult.status === "error" ? filtersResult.error : null;
  const queryError = filtersError ?? (result.status === "error" ? result.error : null);
  const pending = result.status !== "success" || (withFilters && filtersResult.status !== "success");

  return {
    filters: viewFilters,
    branchId: validBranchId ?? null,
    departmentId: validDepartmentId ?? null,
    data: viewData,
    pending,
    stale: requestedData === null,
    error: queryError,
  };
}

/**
 * The URL is the single source of truth for the dashboard selection, so a
 * same-page navigation (for example the sidebar's Dashboard link) updates the
 * report even when this component stays mounted.
 */
function useDashboardState() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = useMemo(
    () => parseDashboardSearchParams(Object.fromEntries(searchParams.entries())),
    [searchParams],
  );
  const navigate = useCallback(
    (patch: Partial<DashboardSearchState>) => {
      const query = dashboardQueryString({ ...state, ...patch });
      window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}`);
    },
    [pathname, state],
  );
  return { state, navigate };
}

/**
 * A period step reads the neighbouring period from the loaded report, so only
 * one step may be in flight. The buttons' disabled state updates after the
 * router transition commits, so a synchronous lock also ignores a click that
 * lands in that gap. The lock releases once the requested selection changes.
 */
function usePeriodStep(
  navigate: (patch: Partial<DashboardSearchState>) => void,
  selection: Pick<DashboardSearchState, "unit" | "date">,
) {
  const waiting = useRef(false);
  const { unit, date } = selection;
  useEffect(() => {
    waiting.current = false;
  }, [unit, date]);
  return useCallback(
    (nextDate: string | null) => {
      if (!nextDate || waiting.current) return;
      waiting.current = true;
      navigate({ date: nextDate });
    },
    [navigate],
  );
}

// A selected period hands its most recent day to the new unit; an omitted
// date stays omitted so the server keeps resolving the live current period.
function unitChangeDate(data: DashboardData, date: string | null) {
  if (date === null) return null;
  return data.period.endDate < data.today ? data.period.endDate : data.today;
}

function blockedScreen(active: ReturnType<typeof useCompany>["active"], error: unknown) {
  if (active && !canViewDashboard(active.capabilities)) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" description="Dashboard access is disabled for your account." />
      </div>
    );
  }
  if (error) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" />
        <div className="alert-error rounded-md p-3 text-sm">{errorMessage(error)}</div>
      </div>
    );
  }
  return null;
}

export function DashboardPage() {
  const { activeCompanyId, active } = useCompany();
  const now = useRoundedNow();
  const { state, navigate } = useDashboardState();
  const { tab, unit, date, branch, department } = state;
  const previousCompany = useRef<Id<"companies"> | null>(activeCompanyId);

  useEffect(() => {
    const previous = previousCompany.current;
    previousCompany.current = activeCompanyId;
    if (previous !== null && activeCompanyId !== null && previous !== activeCompanyId && (branch || department)) {
      navigate({ branch: null, department: null });
    }
  }, [activeCompanyId, branch, department, navigate]);

  const query = useDashboardData({
    companyId: activeCompanyId,
    now,
    unit,
    date,
    branchId: branch,
    departmentId: department,
    withFilters: true,
  });
  const step = usePeriodStep(navigate, state);

  const blocked = blockedScreen(active, query.error);
  if (blocked) return blocked;
  const data = query.data;
  if (!data || (data.scope === "team" && !query.filters)) return <DashboardSkeleton />;

  function handleBranchChange(next: Id<"branches"> | null) {
    const keepDepartment =
      next === null ||
      department === null ||
      !query.filters ||
      query.filters.departments.some((option) => option._id === department && option.branchId === next);
    navigate({ branch: next, department: keepDepartment ? department : null });
  }

  return (
    <DashboardView
      mode="dashboard"
      data={data}
      pending={query.pending}
      steppingDisabled={query.stale}
      filters={query.filters}
      tab={tab}
      unit={unit}
      date={date}
      branchId={query.branchId}
      departmentId={query.departmentId}
      onTabChange={(tab) => navigate({ tab })}
      onUnitChange={(unit) => navigate({ unit, date: unitChangeDate(data, date) })}
      onPrevious={() => step(data.period.previousDate)}
      onNext={() => step(data.period.nextDate)}
      onBranchChange={handleBranchChange}
      onDepartmentChange={(departmentId) => navigate({ department: departmentId })}
    />
  );
}

export function EmployeeDashboardPage({ membershipId }: { membershipId: Id<"companyMemberships"> }) {
  const { activeCompanyId, active } = useCompany();
  const now = useRoundedNow();
  const { state, navigate } = useDashboardState();
  const { tab, unit, date, branch, department } = state;

  const query = useDashboardData({
    companyId: activeCompanyId,
    now,
    unit,
    date,
    branchId: null,
    departmentId: null,
    membershipId,
    withFilters: false,
  });
  const step = usePeriodStep(navigate, state);

  const blocked = blockedScreen(active, query.error);
  if (blocked) return blocked;
  const data = query.data;
  if (!data) return <DashboardSkeleton />;

  return (
    <DashboardView
      mode="employee"
      data={data}
      pending={query.pending}
      steppingDisabled={query.stale}
      tab={tab}
      unit={unit}
      date={date}
      returnBranch={branch}
      returnDepartment={department}
      onTabChange={(tab) => navigate({ tab })}
      onUnitChange={(unit) => navigate({ unit, date: unitChangeDate(data, date) })}
      onPrevious={() => step(data.period.previousDate)}
      onNext={() => step(data.period.nextDate)}
    />
  );
}

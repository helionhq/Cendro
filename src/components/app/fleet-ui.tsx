"use client";

import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FleetAlertFeedRow, FleetBoardVehicle } from "./fleet-format";
import { formatTime, vehicleStatusChip } from "./fleet-format";

export function KpiTile({
  label,
  value,
  subline,
  icon: Icon,
  danger = false,
}: {
  label: string;
  value: React.ReactNode;
  subline: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
}) {
  return (
    <div className="relative rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5 sm:p-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[24px] font-semibold tracking-[-0.02em] tabular-nums sm:text-[26px]",
          danger ? "text-[var(--badge-red-fg)]" : "text-[var(--ink)]",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">{subline}</div>
      <Icon className="absolute right-3.5 top-3.5 h-4 w-4 text-[var(--ink-faint)]" aria-hidden="true" />
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
  id,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold text-[var(--ink)]">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-[12px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
    >
      {children}
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

export function EmptyPanel({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("task-empty", className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      <p className="mt-1 max-w-[320px] text-[13px] text-[var(--ink-muted)]">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function DashedPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed border-[var(--hairline-strong)] px-4 py-5 text-[13px] text-[var(--ink-muted)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FleetCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5 sm:p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function LoadMore({
  status,
  onLoadMore,
  label,
}: {
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  onLoadMore: (count: number) => void;
  label: string;
}) {
  if (status === "Exhausted") return null;
  return (
    <div className="flex justify-center py-3" aria-live="polite">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-10"
        disabled={status !== "CanLoadMore"}
        onClick={() => onLoadMore(20)}
      >
        {status === "CanLoadMore" ? label : "Loading…"}
      </Button>
    </div>
  );
}

/**
 * The app has no toast library; this is the inline status banner the UX spec
 * asks for. Success notices dismiss themselves; errors never do.
 */
export function FleetNotice({
  message,
  onDismiss,
  tone = "status",
  action,
}: {
  message: React.ReactNode;
  onDismiss?: () => void;
  tone?: "status" | "error" | "warning";
  action?: React.ReactNode;
}) {
  useEffect(() => {
    if (tone !== "status" || !onDismiss) return;
    const timer = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, tone]);

  if (tone === "error") {
    return (
      <div className="alert-error flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[13px]" role="alert">
        <span className="min-w-0 flex-1">{message}</span>
        {action}
      </div>
    );
  }
  if (tone === "warning") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] px-3 py-2 text-[13px] text-[var(--ink-secondary)]" role="status">
        <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--badge-yellow-fg)]" aria-hidden="true" />
        <span className="min-w-0 flex-1">{message}</span>
        {action}
      </div>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--surface-muted)] px-3 py-2 text-[13px] text-[var(--ink-secondary)]"
      role="status"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {action}
      {onDismiss && (
        <button
          type="button"
          className="text-[12px] font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function QueryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="alert-error flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-[13px]" role="alert">
      <span className="min-w-0 flex-1">{message}</span>
      <Button type="button" variant="secondary" className="h-9 shrink-0" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A vehicle board card; the whole card is the link. */
export function VehicleBoardCard({
  vehicle,
  now,
  timeZone,
  lastUpdateLabel,
}: {
  vehicle: FleetBoardVehicle;
  now: number;
  timeZone?: string;
  lastUpdateLabel: string;
}) {
  const chip = vehicleStatusChip({
    status: vehicle.status,
    place: vehicle.place,
    arrivedAt: vehicle.arrivedAt,
    requiresTripLogging: vehicle.requiresTripLogging,
    lastUpdate: vehicle.lastUpdate,
  });
  const context = vehicleContext(vehicle, now, timeZone);
  return (
    <Link
      href={`/fleet/vehicles/${vehicle._id}`}
      className="group flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:p-4"
      aria-label={`${vehicle.name}: ${chip.label}, ${context.primary} ${context.secondary}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="block min-w-0">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
            {vehicle.name}
          </span>
          {vehicle.displayName && (
            <span className="block truncate text-[12px] text-[var(--ink-faint)]">
              {vehicle.registrationNumber}
            </span>
          )}
        </span>
        <Badge tone={chip.tone} className="max-w-[55%] truncate" title={chip.label}>
          {chip.label}
        </Badge>
      </span>

      <span className="min-w-0 text-[13px] leading-5 text-[var(--ink-secondary)]">
        <span className="block truncate">{context.primary}</span>
        {context.secondary && (
          <span className="block truncate text-[12px] text-[var(--ink-muted)]">
            {context.secondary}
          </span>
        )}
      </span>

      <span className="flex items-center justify-between gap-2 border-t border-[var(--hairline)] pt-2 text-[12px] text-[var(--ink-muted)]">
        <span className="truncate">{lastUpdateLabel}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-faint)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

function vehicleContext(vehicle: FleetBoardVehicle, now: number, timeZone?: string) {
  switch (vehicle.status) {
    case "on_trip": {
      const driver = vehicle.driverName ?? "Driver";
      const destination = vehicle.destination ?? "destination";
      const when =
        vehicle.arrivedAt != null
          ? `Arrived ${formatTime(vehicle.arrivedAt, timeZone)} · waiting to return`
          : vehicle.departedAt != null
            ? `Left ${formatTime(vehicle.departedAt, timeZone)}`
            : "On a logged trip";
      return { primary: `${driver} → ${destination}`, secondary: when };
    }
    case "moving":
      return vehicle.requiresTripLogging === false
        ? { primary: "Personal vehicle — no trip alerts", secondary: `Last update ${relativeBoard(vehicle.lastUpdate, now)}` }
        : { primary: "No trip logged", secondary: `Last update ${relativeBoard(vehicle.lastUpdate, now)}` };
    case "parked":
      if (vehicle.place) {
        return {
          primary:
            vehicle.parkedSince != null
              ? `since ${formatTime(vehicle.parkedSince, timeZone)}`
              : "Parked",
          secondary: vehicle.address ?? "",
        };
      }
      return {
        primary: vehicle.address || "Location unknown",
        secondary:
          vehicle.parkedSince != null
            ? `since ${formatTime(vehicle.parkedSince, timeZone)}`
            : "",
      };
    case "offline":
      return vehicle.lastUpdate == null
        ? { primary: "Waiting for the first tracker update", secondary: "" }
        : { primary: `Last seen ${relativeBoard(vehicle.lastUpdate, now)}`, secondary: vehicle.place ? `Last at ${vehicle.place.name}` : vehicle.address ?? "" };
  }
}

function relativeBoard(ms: number | null, now: number) {
  if (ms == null) return "never";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function AlertSeverityDot({ severity }: { severity: "critical" | "warning" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
        severity === "critical" ? "bg-[var(--badge-red-fg)]" : "bg-[var(--badge-yellow-fg)]",
      )}
    />
  );
}

export function AttentionRow({
  alert,
  title,
  meta,
}: {
  alert: FleetAlertFeedRow;
  title?: string;
  meta: string;
}) {
  const displayTitle = title ?? alert.title;
  const label = `${alert.severity === "critical" ? "Needs review" : "Heads up"}: ${displayTitle}`;
  return (
    <Link
      href={`/fleet/alerts?status=open&focus=${encodeURIComponent(alert._id ?? alert.key)}`}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      aria-label={label}
    >
      <AlertSeverityDot severity={alert.severity} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-[var(--ink)]">{displayTitle}</span>
        <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">{meta}</span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ink-faint)]" aria-hidden="true" />
    </Link>
  );
}

export function AllClear({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <CheckCircle2 className="h-6 w-6 text-[var(--badge-green-fg)]" aria-hidden="true" />
      <div className="mt-2 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      <p className="mt-1 max-w-[320px] text-[13px] text-[var(--ink-muted)]">{body}</p>
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-xl bg-[var(--surface-pressed)]", className)}
    />
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading Fleet">
      <SkeletonBlock className="h-28" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <SkeletonBlock key={index} className="h-[92px]" />
        ))}
      </div>
      <SkeletonBlock className="h-32" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <SkeletonBlock key={index} className="h-32" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <SkeletonBlock className="h-56" />
        <SkeletonBlock className="h-56" />
      </div>
    </div>
  );
}

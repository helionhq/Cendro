"use client";

import { useQuery_experimental } from "convex/react";
import { Settings2, Truck } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { api } from "../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import { EmptyPanel } from "./fleet-ui";
import { PageHeader } from "./page-header";

export type FleetTabKey = "overview" | "trips" | "places" | "alerts" | "costs";

export function useFleetAccess() {
  const { active } = useCompany();
  return {
    active,
    canView: Boolean(active?.capabilities.includes("fleet:view")),
    canLog: Boolean(active?.capabilities.includes("fleet:log")),
    canManage: Boolean(active?.capabilities.includes("fleet:manage")),
    // Mirrors the backend fallback; the company is Lahore-based (UTC+5, no DST).
    timeZone: active?.company.timeZone ?? "Etc/GMT-5",
  };
}

export function FleetBackLink() {
  return (
    <Link
      href="/fleet"
      className="page-eyebrow inline-flex items-center gap-1 text-[var(--ink-secondary)] hover:text-[var(--ink)]"
    >
      <span aria-hidden="true">←</span> Fleet
    </Link>
  );
}

const tabItems: { key: FleetTabKey; href: string; label: string }[] = [
  { key: "overview", href: "/fleet", label: "Overview" },
  { key: "trips", href: "/fleet/trips", label: "Trips" },
  { key: "places", href: "/fleet/places", label: "Places" },
  { key: "alerts", href: "/fleet/alerts", label: "Alerts" },
  { key: "costs", href: "/fleet/costs", label: "Costs" },
];

export function FleetTabs({ active }: { active: FleetTabKey }) {
  const { activeCompanyId } = useCompany();
  const now = useMinuteNow();
  const { canView, canManage } = useFleetAccess();
  const feed = useQuery_experimental({
    query: api.fleetMonitoring.alertsFeed,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now, status: "open" } : "skip",
  });
  const alertCount = feed.status === "success" ? feed.data.openCount : 0;
  // Avoid a flash of "Alerts 0" before the first subscription result.
  const showCount = feed.status === "success" && alertCount > 0;

  return (
    <div className="flex items-center border-b border-[var(--hairline)] md:sticky md:top-0 md:z-20 md:bg-[var(--canvas)]">
      <nav
        aria-label="Fleet sections"
        className="scrollbar-hidden -mb-px flex min-h-11 min-w-0 flex-1 items-stretch gap-5 overflow-x-auto"
      >
        {tabItems.map((tab) => {
          const current = tab.key === active;
          const label =
            tab.key === "alerts" && showCount
              ? `Alerts, ${alertCount} open`
              : undefined;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={current ? "page" : undefined}
              aria-label={label}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 pb-3 pt-1 text-[13.5px] font-medium outline-none transition-colors",
                "after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent after:content-['']",
                "hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
                current
                  ? "text-[var(--ink)] after:bg-[var(--ink)]"
                  : "text-[var(--ink-muted)]",
              )}
            >
              {tab.label}
              {tab.key === "alerts" && showCount ? (
                <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-[var(--badge-red-bg)] px-1.5 text-[11px] font-semibold leading-[18px] text-[var(--badge-red-fg)]">
                  {alertCount > 99 ? "99+" : alertCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      {canManage && (
        <Link
          href="/fleet/settings"
          aria-label="Fleet settings"
          className="ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

export function FleetPage({
  title,
  description,
  actions,
  activeTab,
  children,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  activeTab: FleetTabKey;
  children: React.ReactNode;
}) {
  const { canView } = useFleetAccess();
  // Each tab is its own route, so moving focus to the new heading on mount is
  // how a screen reader learns that the page changed.
  useEffect(() => {
    document.querySelector<HTMLHeadingElement>(".page-title")?.focus();
  }, [activeTab, title]);

  if (!canView) {
    return (
      <div className="app-page @container pb-[calc(5rem+env(safe-area-inset-bottom))]">
        <PageHeader eyebrow="Fleet" title="Fleet" />
        <EmptyPanel
          icon={Truck}
          title="Fleet is not available"
          body="You do not have access to Fleet in this workspace."
        />
      </div>
    );
  }

  return (
    <div className="app-page @container pb-[calc(5rem+env(safe-area-inset-bottom))]">
      <PageHeader eyebrow="Fleet" title={title} description={description} actions={actions} />
      <FleetTabs active={activeTab} />
      <div className="mt-5 space-y-5">{children}</div>
    </div>
  );
}

/** Settings and vehicle pages: no tab row, just the back link and content. */
export function FleetStandalonePage({
  title,
  description,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="app-page @container pb-[calc(5rem+env(safe-area-inset-bottom))]">
      <PageHeader
        eyebrow={<FleetBackLink />}
        title={title}
        description={description}
        actions={actions}
      />
      {children}
    </div>
  );
}

export function FleetPageSkeleton() {
  return (
    <div className="app-page @container pb-[calc(5rem+env(safe-area-inset-bottom))]" aria-busy="true" aria-label="Loading">
      <div className="space-y-4">
        <div className="h-7 w-40 animate-pulse rounded bg-[var(--surface-pressed)]" />
        <div className="h-4 w-72 animate-pulse rounded bg-[var(--surface-pressed)]" />
        <div className="h-10 w-full animate-pulse rounded bg-[var(--surface-pressed)]" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-[92px] animate-pulse rounded-xl bg-[var(--surface-pressed)]" />
          ))}
        </div>
        <div className="h-48 animate-pulse rounded-xl bg-[var(--surface-pressed)]" />
      </div>
    </div>
  );
}

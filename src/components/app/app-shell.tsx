"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useClerk, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  Check,
  ChevronDown,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Repeat,
  Search,
  Settings,
  SquareCheck,
  Sun,
  Truck,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { CompanyProvider, useCompany, type CompanyAccess } from "./company-context";
import { useTheme } from "./theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canAccessCompanyManagement, canViewDashboard } from "@/lib/permissions";
import { useMinuteNow } from "@/lib/use-minute-now";
import { shellStageLabel, type ShellConnection, type ShellLoadingStage } from "@/lib/shell-access";
import type { AuthDiagnostic } from "@/lib/auth-diagnostics";
import { useShellStall } from "./shell-stall";
import { usePaletteSearch } from "./use-palette-search";
import { normalizePaletteQuery, PALETTE_MAX_QUERY_LENGTH } from "@/lib/palette-search";
import { cn, initials } from "@/lib/utils";

// The assistant panel is heavy (AI SDK, markdown rendering) and rarely opened;
// keep it out of the shell bundle until first use.
const AiPanel = dynamic(() => import("./ai-panel").then((m) => m.AiPanel), { ssr: false });

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, requiresDashboard: true },
  { href: "/jd-tasks", label: "Job Description", icon: Repeat },
  { href: "/one-time-tasks", label: "Tasks", icon: SquareCheck },
  { href: "/sops", label: "SOP's", icon: FileText },
  { href: "/fleet", label: "Fleet", icon: Truck, requiresFleet: true },
  { href: "/company", label: "Settings", icon: Building2, requiresCompanyManagement: true },
];

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  requiresDashboard?: boolean;
  requiresCompanyManagement?: boolean;
  requiresFleet?: boolean;
  badge?: number;
};

const dropdownItemClass =
  "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--ink-secondary)] outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[highlighted]:text-[var(--ink)]";

function navForCapabilities(active: CompanyAccess | null | undefined, fleetAlertCount = 0): NavItem[] {
  const canManage = canAccessCompanyManagement(active?.capabilities);
  const canDash = canViewDashboard(active?.capabilities);
  const canUseFleet = Boolean(active?.capabilities.includes("fleet:view"));
  return nav
    .filter((item) =>
      (!item.requiresCompanyManagement || canManage) &&
      (!item.requiresDashboard || canDash) &&
      (!item.requiresFleet || canUseFleet),
    )
    .map((item) => (item.href === "/fleet" && fleetAlertCount > 0 ? { ...item, badge: fleetAlertCount } : item));
}

function NavLinks({
  items,
  path,
  onNavigate,
  className,
}: {
  items: NavItem[];
  path: string;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        const activeRow = path === item.href || path.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={activeRow ? "page" : undefined}
            aria-label={item.badge ? `${item.label}, ${item.badge} alerts` : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md text-sm uppercase text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-hover)]",
              activeRow && "bg-[var(--surface-pressed)] text-[var(--ink)]",
              className,
            )}
          >
            <Icon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge ? (
              <span className="shrink-0 rounded-full bg-[var(--badge-red-bg)] px-1.5 text-center text-[10px] font-semibold leading-5 text-[var(--badge-red-fg)]">
                {item.badge > 99 ? "99+" : item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

function MobileNavDrawer({
  open,
  onOpenChange,
  items,
  path,
  isPlatformAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
  path: string;
  isPlatformAdmin: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25 md:hidden" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,calc(100vw-64px))] flex-col border-r border-[var(--hairline)] bg-[var(--chrome)] pb-[calc(0.75rem+env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-2 pt-[calc(0.75rem+env(safe-area-inset-top))] text-[var(--ink)] shadow-[var(--shadow-popover)] md:hidden">
          <Dialog.Description className="sr-only">Primary navigation</Dialog.Description>
          <div className="flex shrink-0 items-center justify-between gap-2 pl-2">
            <Dialog.Title className="text-sm font-semibold uppercase tracking-[0.02em]">Cendro</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Close navigation">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <nav className="mt-5 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            <NavLinks items={items} path={path} onNavigate={() => onOpenChange(false)} className="h-11 px-2.5" />
          </nav>
          {isPlatformAdmin && (
            <Button asChild variant="ghost" className="mt-2 h-10 shrink-0 justify-start px-2.5 uppercase">
              <Link href="/admin" onClick={() => onOpenChange(false)}>Platform admin</Link>
            </Button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Lets any part of the shell open the single palette instance mounted by ShellSearch. */
const SearchPaletteContext = createContext<(open: boolean) => void>(() => {});

function ShellCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--chrome)] p-6">
      <div className="w-full max-w-md rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-6 shadow-[var(--shadow-popover)]">{children}</div>
    </div>
  );
}

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useUser();
  const { theme, toggleTheme } = useTheme();
  const profile = useQuery(api.users.me);
  const updateName = useMutation(api.users.updateCurrentName).withOptimisticUpdate((localStore, args) => {
    const me = localStore.getQuery(api.users.me, {}) as any;
    if (me) {
      const cleanSecondName = args.secondName?.trim() ?? "";
      const firstName = args.firstName.trim();
      localStore.setQuery(api.users.me, {}, {
        ...me,
        firstName,
        secondName: cleanSecondName,
      });
    }
  });
  const [firstName, setFirstName] = useState("");
  const [secondName, setSecondName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFirstName(profile?.firstName || user?.firstName || user?.fullName || "");
      setSecondName(profile?.secondName || user?.lastName || "");
      setError(null);
    }
  }, [open, profile?.firstName, profile?.secondName, user?.firstName, user?.lastName, user?.fullName]);

  async function saveName() {
    const trimmedFirstName = firstName.trim();
    const trimmedSecondName = secondName.trim();
    if (!trimmedFirstName || !user || saving) return;
    setSaving(true);
    setError(null);
    try {
      await user.update({ firstName: trimmedFirstName, lastName: trimmedSecondName || null });
      await updateName({ firstName: trimmedFirstName, secondName: trimmedSecondName });
      await user.reload();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your name.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow-popover)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold">Settings</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-[var(--ink-muted)]">Update the names shown in Cendro.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close settings">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-[var(--ink-secondary)]" htmlFor="profile-first-name">
                First name
              </label>
              <Input id="profile-first-name" className="mt-2" value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="First name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ink-secondary)]" htmlFor="profile-second-name">
                Second name
              </label>
              <Input id="profile-second-name" className="mt-2" value={secondName} onChange={(event) => setSecondName(event.target.value)} placeholder="Second name" />
            </div>
          </div>
          {error && <p className="alert-error mt-3 rounded-md p-2 text-sm">{error}</p>}
          <div className="mt-5 border-t border-[var(--hairline)] pt-4">
            <div className="mb-2 text-sm font-medium text-[var(--ink-secondary)]">Appearance</div>
            <Button variant="secondary" onClick={toggleTheme} type="button">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Use light mode" : "Use dark mode"}
            </Button>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveName} disabled={saving || !firstName.trim()}>
              {saving ? "Saving..." : "Save names"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const paletteScopeLabels: Record<string, string> = {
  company: "Company",
  branch: "Branch",
  department: "Department",
  user: "User",
};

type PaletteRow = {
  key: string;
  icon: React.ComponentType<{ className?: string }> | null;
  letter?: string;
  label: string;
  meta?: string;
  trailing?: React.ReactNode;
  onSelect: () => void;
};

function SearchCommandDialog({
  open,
  onOpenChange,
  items,
  companies,
  activeCompanyId,
  setActiveCompanyId,
  canSearchEntities,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
  companies: CompanyAccess[];
  activeCompanyId: CompanyAccess["company"]["_id"] | null;
  setActiveCompanyId: (id: CompanyAccess["company"]["_id"]) => void;
  canSearchEntities: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const normalized = normalizePaletteQuery(query);
  const { results: entityResults, failed: entityFailed, searching, inputError } = usePaletteSearch({
    open, query, companyId: activeCompanyId, canSearch: canSearchEntities,
  });

  const sections: { title: string; rows: PaletteRow[] }[] = [];
  {
    const close = () => onOpenChange(false);
    const filteredItems = items.filter((item) => item.label.toLowerCase().includes(normalized));
    if (filteredItems.length > 0) {
      sections.push({
        title: "Pages",
        rows: filteredItems.map((item) => ({
          key: `page:${item.href}`,
          icon: item.icon,
          label: item.label,
          onSelect: () => {
            close();
            router.push(item.href);
          },
        })),
      });
    }
    if (entityResults?.jd && entityResults.jd.tasks.length > 0) {
      sections.push({
        title: "Job Description tasks",
        rows: entityResults.jd.tasks.map((task) => ({
          key: `jd:${task._id}`,
          icon: Repeat,
          label: task.title,
          meta: task.reference,
          onSelect: () => {
            close();
            router.push(`/jd-tasks/${task._id}`);
          },
        })),
      });
    }
    if (entityResults?.oneTime && entityResults.oneTime.tasks.length > 0) {
      sections.push({
        title: "One-time tasks",
        rows: entityResults.oneTime.tasks.map((task) => ({
          key: `one:${task._id}`,
          icon: SquareCheck,
          label: task.title,
          meta: task.reference,
          onSelect: () => {
            close();
            router.push(`/one-time-tasks/${task._id}`);
          },
        })),
      });
    }
    if (entityResults?.sops && entityResults.sops.sops.length > 0) {
      sections.push({
        title: "SOPs",
        rows: entityResults.sops.sops.map((sop) => ({
          key: `sop:${sop._id}`,
          icon: FileText,
          label: sop.title,
          meta: `${sop.reference} · ${paletteScopeLabels[sop.scopeType] ?? sop.scopeType}`,
          onSelect: () => {
            close();
            router.push(`/sops/${sop._id}`);
          },
        })),
      });
    }
    const filteredCompanies = companies.filter((company) => company.company.name.toLowerCase().includes(normalized));
    if (filteredCompanies.length > 0) {
      sections.push({
        title: "Workspaces",
        rows: filteredCompanies.map((company) => ({
          key: `company:${company.company._id}`,
          icon: null,
          letter: company.company.name?.[0]?.toUpperCase() ?? "C",
          label: company.company.name,
          trailing: company.company._id === activeCompanyId ? <Check className="h-4 w-4 text-[var(--ink)]" /> : undefined,
          onSelect: () => {
            setActiveCompanyId(company.company._id);
            close();
          },
        })),
      });
    }
  }

  const flatRows = sections.flatMap((section) => section.rows);
  // Selection is tracked by row key, not position, so async results arriving
  // above the highlighted row can't silently move the Enter target.
  const activeRowIndex = Math.max(0, flatRows.findIndex((row) => row.key === activeKey));
  const truncated = Boolean(entityResults?.jd?.truncated || entityResults?.oneTime?.truncated || entityResults?.sops?.truncated);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveKey(null);
    }
  }, [open]);

  useEffect(() => {
    setActiveKey(null);
  }, [normalized]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeRowIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeRowIndex]);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flatRows.length) setActiveKey(flatRows[(activeRowIndex + 1) % flatRows.length].key);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flatRows.length) setActiveKey(flatRows[(activeRowIndex - 1 + flatRows.length) % flatRows.length].key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      flatRows[activeRowIndex]?.onSelect();
    }
  }

  let rowIndex = 0;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content className="fixed left-1/2 top-[22vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-popover)]">
          <Dialog.Title className="sr-only">Search Cendro</Dialog.Title>
          <div className="flex h-11 items-center gap-2 px-3">
            <Search className="h-4 w-4 text-[var(--ink-faint)]" />
            <Input
              autoFocus
              value={query}
              maxLength={PALETTE_MAX_QUERY_LENGTH}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search pages, tasks, SOPs, workspaces..."
              className="h-9 border-0 bg-transparent px-0 focus:border-0"
              role="combobox"
              aria-expanded="true"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls="palette-results"
              aria-activedescendant={flatRows.length ? `palette-row-${activeRowIndex}` : undefined}
            />
          </div>
          <div ref={listRef} id="palette-results" className="max-h-[360px] overflow-auto px-2 pb-2" role="listbox" aria-label="Search results">
            {sections.map((section) => (
              <div key={section.title}>
                <div className="px-2 py-1 text-xs font-medium text-[var(--ink-faint)] first:pt-1">{section.title}</div>
                {section.rows.map((row) => {
                  const index = rowIndex++;
                  const Icon = row.icon;
                  const isActive = row.key === flatRows[activeRowIndex]?.key;
                  return (
                    <button
                      key={row.key}
                      id={`palette-row-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={isActive}
                      className={cn(
                        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--ink-secondary)]",
                        isActive ? "bg-[var(--surface-hover)] text-[var(--ink)]" : "hover:bg-[var(--surface-hover)]",
                      )}
                      onMouseEnter={() => setActiveKey(row.key)}
                      onClick={row.onSelect}
                    >
                      {Icon ? (
                        <Icon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                      ) : (
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-[var(--surface-muted)] text-xs text-[var(--ink-muted)]">{row.letter}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      {row.meta && <span className="shrink-0 truncate text-xs text-[var(--ink-faint)]">{row.meta}</span>}
                      {row.trailing}
                    </button>
                  );
                })}
              </div>
            ))}
            {flatRows.length === 0 && !searching && !entityFailed && !inputError && <div className="px-2 py-8 text-center text-sm text-[var(--ink-muted)]">No results found.</div>}
            {inputError && <div role="status" className="px-2 py-3 text-center text-xs text-[var(--ink-muted)]">{inputError}</div>}
            {searching && <div className="px-2 py-3 text-center text-xs text-[var(--ink-muted)]">Searching tasks and SOPs…</div>}
            {entityFailed && <div className="px-2 py-3 text-center text-xs text-[var(--ink-muted)]">Couldn&apos;t search tasks and SOPs — keep typing to retry.</div>}
            {truncated && !searching && <div className="border-t border-[var(--hairline)] px-2 py-2 text-center text-xs text-[var(--ink-faint)]">Showing top matches — keep typing to refine</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountCompanyMenu() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { companies, activeCompanyId, setActiveCompanyId, active } = useCompany();
  const setSearchOpen = useContext(SearchPaletteContext);
  const profile = useQuery(api.users.me);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profileName = profile ? [profile.firstName, profile.secondName].filter(Boolean).join(" ").trim() : "";
  const displayName = active?.displayName || profileName || user?.fullName || profile?.email || user?.primaryEmailAddress?.emailAddress || "User";
  const displayImage = profile?.imageUrl || user?.imageUrl;

  return (
    <>
      <div className="flex h-9 items-center gap-1 md:h-8">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[var(--ink)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-md bg-[var(--surface-pressed)] text-[11px] font-medium text-[var(--ink-secondary)]">
                {displayImage ? <span aria-hidden="true" className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${displayImage})` }} /> : initials(displayName)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium tracking-[-0.01em]">{displayName}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
            </button>
          </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={7} className="z-50 w-76 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-2 shadow-[var(--shadow-popover)]">
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-md bg-[var(--surface-pressed)] text-base font-medium text-[var(--ink-secondary)]">
                {displayImage ? <span aria-hidden="true" className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(${displayImage})` }} /> : initials(displayName)}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--ink)]">{displayName}</div>
                {(profile?.email || user?.primaryEmailAddress?.emailAddress) && <div className="truncate text-xs text-[var(--ink-faint)]">{profile?.email || user?.primaryEmailAddress?.emailAddress}</div>}
              </div>
            </div>
            <DropdownMenu.Item className={dropdownItemClass} onSelect={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
              Settings
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />
            <div className="px-2 py-1 text-xs font-medium text-[var(--ink-faint)]">Workspaces</div>
            {companies.map((company: CompanyAccess) => {
              const isActive = company.company._id === activeCompanyId;
              return (
                <DropdownMenu.Item key={company.company._id} className={dropdownItemClass} onSelect={() => setActiveCompanyId(company.company._id)}>
                  <div className="grid h-6 w-6 place-items-center rounded-md bg-[var(--surface-muted)] text-xs font-medium text-[var(--ink-muted)]">
                    {company.company.name?.[0]?.toUpperCase() ?? "C"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--ink)]">{company.company.name}</div>
                    <div className="text-xs text-[var(--ink-faint)]">{company.membership.role}{!company.membership.active ? " · Inactive" : ""}</div>
                  </div>
                  {isActive && <Check className="h-4 w-4 text-[var(--ink)]" />}
                </DropdownMenu.Item>
              );
            })}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />
            <DropdownMenu.Item className={dropdownItemClass} onSelect={() => void signOut({ redirectUrl: "/sign-in" })}>
              <LogOut className="h-4 w-4" />
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] md:h-7 md:w-7" aria-label="Open search" aria-keyshortcuts="Control+K Meta+K" title="Search (Ctrl+K)" onClick={() => setSearchOpen(true)}>
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

function AssistantOrb({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] right-[calc(1.25rem+env(safe-area-inset-right))] z-30 grid h-11 w-11 place-items-center rounded-full border border-[var(--assistant-orb-border)] bg-[var(--assistant-orb-bg)] text-zinc-950 shadow-[var(--assistant-orb-shadow)] transition hover:-translate-y-0.5 hover:bg-[var(--assistant-orb-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:translate-y-0 md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] md:right-[calc(1.5rem+env(safe-area-inset-right))]"
      aria-label="Open AI assistant"
    >
      <svg aria-hidden="true" role="graphics-symbol" viewBox="0 0 20 20" className="h-[31px] w-[31px]" xmlns="http://www.w3.org/2000/svg">
        <path d="M12.758 9.976a1.178 1.178 0 1 0 .377-2.326 1.178 1.178 0 0 0-.377 2.326M6.547 8.97a1.178 1.178 0 1 0 .377-2.327 1.178 1.178 0 0 0-.377 2.326" fill="#4F4E49" />
        <path d="M10.573 5.554a3.917 3.917 0 0 1 6.743.035.625.625 0 1 1-1.08.63 2.667 2.667 0 0 0-4.591-.023l-5.398 9.015 4.192.68a.625.625 0 0 1-.2 1.233l-5.102-.827a.625.625 0 0 1-.436-.938zM4.36 3.517a3.92 3.92 0 0 1 5.572.356.625.625 0 1 1-.945.818 2.67 2.67 0 0 0-3.795-.243.625.625 0 1 1-.833-.931" fill="#4F4E49" />
      </svg>
    </button>
  );
}

function stallCopy(accessStatus: string, stage: ShellLoadingStage | null, diagnostic: AuthDiagnostic): { title: string; body: string } {
  if (accessStatus === "convexUnauthenticated") {
    return { title: "Couldn't verify your sign-in", body: diagnostic.token?.result === "obtained" ? "Cendro has not confirmed this session. Authentication failed; try again or share the support diagnostic." : "Clerk is signed in, but Cendro could not obtain or confirm a session token. Try again or share the support diagnostic." };
  }
  if (accessStatus === "profileMissing") {
    return diagnostic.profile === "missing-email"
      ? { title: "Your profile needs attention", body: "Your account is missing the email claim required for setup. Ask an administrator to check your account." }
      : { title: "Your profile is still syncing", body: "Your account record hasn't been created yet. If this keeps happening, ask an administrator to check." };
  }
  if (stage === "session") {
    return { title: "Sign-in is taking a while", body: "The sign-in service hasn't finished loading. Try again if this persists." };
  }
  if (stage === "convex-auth") {
    return { title: "Securing your session", body: diagnostic.token?.result === "obtained" ? "Clerk is signed in; Cendro is waiting to confirm your session." : "Clerk is signed in; Cendro has not confirmed your session. Token acquisition or confirmation may still be pending." };
  }
  if (stage === "data") {
    return { title: "Loading your workspace", body: "Your session is confirmed, but workspace data has not arrived yet." };
  }
  return { title: "Still loading", body: "This is taking longer than usual." };
}

function StallCard({
  accessStatus,
  stage,
  elapsedMs,
  reloads,
  connection,
  email,
  onRetry,
  diagnostic,
}: {
  accessStatus: string;
  diagnostic: AuthDiagnostic;
  stage: ShellLoadingStage | null;
  elapsedMs: number;
  reloads: number;
  connection: ShellConnection | null;
  email: string | null;
  onRetry: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  async function copyDiagnostic() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostic));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }
  const { title, body } = stallCopy(accessStatus, stage, diagnostic);
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const socket = connection
    ? connection.isWebSocketConnected
      ? "websocket connected"
      : connection.hasEverConnected
        ? "websocket disconnected"
        : "websocket not connected"
    : "websocket state unknown";
  return (
    <ShellCard>
      {accessStatus !== "loading" || stage !== "session" ? (
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
      ) : null}
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">{body}</p>
      <p className="mt-3 text-xs text-[var(--ink-faint)]">
        {stage ? `Waiting on ${shellStageLabel(stage)} · ` : ""}
        {elapsedSeconds}s · {socket} · connection retries {connection?.connectionRetries ?? 0}
        {reloads > 0 ? ` · retried ${reloads}x` : ""}
        {typeof navigator !== "undefined" && navigator.onLine === false ? " · offline" : ""}
      </p>
      {email && <p className="mt-1 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
      <details className="mt-3 text-xs text-[var(--ink-muted)]">
        <summary className="cursor-pointer">Support diagnostic</summary>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all select-text">{JSON.stringify(diagnostic, null, 2)}</pre>
      </details>
      <p className="mt-3 text-xs text-[var(--ink-muted)]">Copy the support diagnostic and send it to your administrator. No developer tools needed; it excludes tokens and workspace content.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={() => void copyDiagnostic()}>Copy support diagnostic</Button>
      </div>
      <p role="status" className="mt-2 text-xs text-[var(--ink-muted)]">
        {copyStatus === "copied" ? "Copied. Paste it into your message to support." : copyStatus === "failed" ? "Copy was blocked. Open Support diagnostic above and select and copy the text." : ""}
      </p>
    </ShellCard>
  );
}

function ShellInner({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const { accessStatus, email, activeCompanyId, active, loadingStage, connection } = useCompany();
  const [aiOpen, setAiOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { stalled, elapsedMs, reloads, diagnostic, retry } = useShellStall(accessStatus, loadingStage, connection);
  const clockNow = useMinuteNow();
  const canUseFleet = Boolean(active?.capabilities.includes("fleet:view"));
  const fleetAlerts = useQuery(
    api.fleet.alerts,
    activeCompanyId && canUseFleet ? { companyId: activeCompanyId, now: clockNow } : "skip",
  );

  useEffect(() => {
    if (accessStatus === "signedOut") router.replace(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
  }, [accessStatus, path, router]);

  // A navigation can complete before the drawer's close handler runs (e.g. a
  // route push from another control); never leave the drawer over a new page.
  useEffect(() => {
    setNavOpen(false);
  }, [path]);

  // The drawer is hidden by layout at md; close it so a rotation or resize does
  // not leave an invisible dialog holding focus and the scroll lock.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (wide.matches) setNavOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  const visibleNav = useMemo(
    () => navForCapabilities(active, fleetAlerts?.count ?? 0),
    [active, fleetAlerts?.count],
  );

  if (accessStatus === "loading") {
    if (stalled) {
      return (
        <StallCard
          accessStatus={accessStatus}
          stage={loadingStage}
          elapsedMs={elapsedMs}
          reloads={reloads}
          connection={connection}
          email={email}
          onRetry={retry}
          diagnostic={diagnostic!}
        />
      );
    }
    return (
      <div className="min-h-dvh bg-[var(--chrome)] p-8">
        <div className="mx-auto max-w-5xl space-y-3">
          <div className="h-8 w-48 animate-pulse rounded bg-[var(--surface-pressed)]" />
          <div className="h-24 w-full animate-pulse rounded bg-[var(--surface-pressed)]" />
          <div className="h-24 w-full animate-pulse rounded bg-[var(--surface-pressed)]" />
        </div>
      </div>
    );
  }

  if (accessStatus === "signedOut") return null;

  if (accessStatus === "convexUnauthenticated" || accessStatus === "profileMissing") {
    if (stalled) {
      return (
        <StallCard
          accessStatus={accessStatus}
          stage={loadingStage}
          elapsedMs={elapsedMs}
          reloads={reloads}
          connection={connection}
          email={email}
          onRetry={retry}
          diagnostic={diagnostic!}
        />
      );
    }
    return (
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">Finishing sign-in</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">We are setting up your authenticated session. Refresh the page in a moment.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
      </ShellCard>
    );
  }

  if (accessStatus === "noCompanies") {
    return (
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">No company access yet</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">Accept an invitation or ask an admin to add you to a company.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
        {isPlatformAdmin && (
          <Button asChild className="mt-4" variant="primary">
            <Link href="/admin">Open platform admin</Link>
          </Button>
        )}
      </ShellCard>
    );
  }

  if (active && !active.membership.active) {
    return (
      <ShellCard>
        <div className="mb-4">
          <AccountCompanyMenu />
        </div>
        <h1 className="text-xl font-semibold">User inactive</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">Your user is currently inactive in this company. Please contact the administrator.</p>
        {email && <p className="mt-3 text-xs text-[var(--ink-faint)]">Signed in as {email}</p>}
        {isPlatformAdmin && (
          <Button asChild className="mt-4" variant="primary">
            <Link href="/admin">Open platform admin</Link>
          </Button>
        )}
      </ShellCard>
    );
  }

  return (
    <div className={cn("flex h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--ink)] md:bg-[var(--chrome)] md:pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pl-[max(0.375rem,env(safe-area-inset-left))] md:pt-[max(0.5rem,env(safe-area-inset-top))]", aiOpen ? "md:pr-[max(0.375rem,env(safe-area-inset-right))]" : "md:pr-[max(0.625rem,env(safe-area-inset-right))]")}>
      <aside className="hidden w-[246px] shrink-0 flex-col bg-[var(--chrome-translucent)] px-2 pb-2 pt-1 backdrop-blur-sm md:flex">
        <AccountCompanyMenu />
        <nav className="mt-4 space-y-0.5">
          <NavLinks items={visibleNav} path={path} className="h-8 px-2" />
        </nav>
        {isPlatformAdmin && (
          <Button asChild variant="ghost" className="mt-auto justify-start px-2 uppercase">
            <Link href="/admin">Platform admin</Link>
          </Button>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-[var(--hairline)] bg-[var(--canvas)] pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] md:hidden">
          <div className="flex h-11 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              aria-label="Open navigation"
              aria-haspopup="dialog"
              aria-expanded={navOpen}
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <AccountCompanyMenu />
            </div>
          </div>
        </header>
        <MobileNavDrawer
          open={navOpen}
          onOpenChange={setNavOpen}
          items={visibleNav}
          path={path}
          isPlatformAdmin={isPlatformAdmin}
        />

        <div className="flex min-h-0 flex-1 gap-1 overflow-hidden">
          <section className="relative min-w-0 flex-1 overflow-hidden bg-[var(--canvas)] md:rounded-xl md:border md:border-[var(--page-outline)]">
            <div className="h-full overflow-auto pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:pb-0 md:pl-0 md:pr-0">
              {children}
            </div>
          </section>
          {!aiOpen && activeCompanyId && <AssistantOrb onClick={() => setAiOpen(true)} />}
          {aiOpen && activeCompanyId && <AiPanel companyId={activeCompanyId} onClose={() => setAiOpen(false)} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Owns the single command-palette instance and its global Ctrl/Cmd+K shortcut.
 * Both shell layouts mount an AccountCompanyMenu, so the dialog lives here to
 * avoid stacked duplicates.
 */
function ShellSearch({ children }: { children: React.ReactNode }) {
  const { companies, activeCompanyId, setActiveCompanyId, active } = useCompany();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const items = useMemo(() => navForCapabilities(active), [active]);
  return (
    <SearchPaletteContext.Provider value={setOpen}>
      {children}
      <SearchCommandDialog
        open={open}
        onOpenChange={setOpen}
        items={items}
        companies={companies}
        activeCompanyId={activeCompanyId}
        setActiveCompanyId={setActiveCompanyId}
        canSearchEntities={Boolean(active?.membership.active)}
      />
    </SearchPaletteContext.Provider>
  );
}

export function AppShell({ children, isPlatformAdmin }: { children: React.ReactNode; isPlatformAdmin: boolean }) {
  return (
    <CompanyProvider>
      <ShellSearch>
        <ShellInner isPlatformAdmin={isPlatformAdmin}>{children}</ShellInner>
      </ShellSearch>
    </CompanyProvider>
  );
}

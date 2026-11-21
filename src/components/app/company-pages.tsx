"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Check,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  CirclePause,
  Copy,
  GripVertical,
  Layers,
  LucideIcon,
  MailPlus,
  MailX,
  Network,
  PanelRight,
  Pencil,
  Plus,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCog,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import type { DragEndEvent } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "@/components/app/company-context";
import { DETAIL_DRAWER_CLOSE_MS } from "@/components/app/detail-drawer-motion";
import { TaskCellPopover } from "@/components/app/task-cell-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { browserTimeZone, DEFAULT_TIME_ZONE, timeZoneOptions } from "@/lib/time-zones";
import { cn, formatDate, initials } from "@/lib/utils";
import { canAccessCompanyManagement, capabilityGroups, capabilityLabels, type Capability } from "@/lib/permissions";

/* ============================================================== */
/*  Types                                                          */
/* ============================================================== */

type MembershipCore = { _id: Id<"companyMemberships">; role: string; active: boolean; createdAt: number };
type Scope = { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] };
type UserRow = {
  membership: MembershipCore;
  user: { _id: Id<"appUsers">; name: string; firstName: string; secondName: string; email: string };
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  scope: Scope;
};
type BranchRow = { _id: Id<"branches">; name: string; order?: number };
type DepartmentRow = { _id: Id<"departments">; branchId: Id<"branches">; name: string; order?: number };
type RoleRow = { _id: Id<"roles">; name: string; capabilities: Capability[]; memberCount: number };
type InvitationRow = {
  _id: Id<"invitations">;
  email: string;
  role: string;
  status: string;
  createdAt: number;
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
};
type Overview = {
  isTruncated: boolean;
  truncated: { branches: boolean; departments: boolean; users: boolean; invitations: boolean; userDetails: boolean };
  company?: {
    _id: Id<"companies">;
    name: string;
    timeZone: string;
    hasTimeZone: boolean;
    preferredAdminMembershipId: Id<"companyMemberships"> | null;
    preferredAdmin: { _id: Id<"companyMemberships">; name: string; canConfirm: boolean } | null;
  };
  currentMembership: MembershipCore;
  branches: BranchRow[];
  departments: DepartmentRow[];
  users: UserRow[];
  roles: RoleRow[];
  invitations: InvitationRow[];
};
type TabValue = "general" | "structure" | "people" | "roles";

const roleTone: Record<string, "blue" | "green" | "neutral"> = {
  Admin: "blue",
  Manager: "green",
  Employee: "neutral",
};

const TABS: { value: TabValue; label: string; icon: LucideIcon }[] = [
  { value: "general", label: "General", icon: Settings },
  { value: "structure", label: "Hierarchy", icon: Network },
  { value: "people", label: "Users", icon: Users },
  { value: "roles", label: "Roles", icon: ShieldCheck },
];

function canViewCompanyTab(tab: TabValue, capabilities: readonly string[] | null | undefined) {
  if (tab === "general") return Boolean(capabilities?.some((capability) => capability === "company:manage_settings" || capability === "company:manage_calendar"));
  if (tab === "structure") return Boolean(capabilities?.some((capability) => capability === "company:manage_branches" || capability === "company:manage_departments"));
  if (tab === "people") return Boolean(capabilities?.some((capability) => capability === "company:manage_users" || capability === "company:invite_users" || capability === "company:manage_roles"));
  return Boolean(capabilities?.includes("company:manage_roles"));
}

const TAB_COPY: Record<TabValue, { title: string; description: string }> = {
  general: {
    title: "General",
    description: "Keep the workspace name and identity tidy.",
  },
  structure: {
    title: "Hierarchy",
    description: "Define the branches and departments that shape ownership across the company.",
  },
  people: {
    title: "Users",
    description: "Manage members, pending invitations, team placement, and access level.",
  },
  roles: {
    title: "Roles",
    description: "Create roles and tune the permissions members inherit from them.",
  },
};

function roleBadgeTone(name: string) {
  return roleTone[name] ?? "neutral";
}

/* ============================================================== */
/*  Shared UI                                                      */
/* ============================================================== */

function MemberAvatar({ name, email, size = "sm" }: { name: string; email: string; size?: "sm" | "md" }) {
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : "h-6 w-6 text-[10px]";
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] font-semibold text-[var(--ink-secondary)]",
        dim,
      )}
      title={name || email}
    >
      {initials(name, email)}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  message,
  action,
}: {
  icon: LucideIcon;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="task-empty">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      {message && <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function SelectField<T extends string>({
  value,
  onChange,
  children,
  disabled = false,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        "h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2 text-[13px] text-[var(--ink)] outline-none transition-[border-color,box-shadow] duration-150 hover:border-[var(--hairline-strong)] focus:border-[var(--focus-ring)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_14%,transparent)] disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}

function FilterSubmenu<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="task-menu-item">
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-48">
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {value === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function CompanyFilterMenu({
  roleFilter,
  roleNames,
  activeCount,
  onRoleChange,
}: {
  roleFilter: string | "all";
  roleNames: string[];
  activeCount: number;
  onRoleChange: (value: string | "all") => void;
}) {
  const roleOptions: { value: string | "all"; label: string }[] = [{ value: "all", label: "All roles" }, ...roleNames.map((role) => ({ value: role, label: role }))];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-toolbar-icon" data-active={activeCount > 0} aria-label="Filter people">
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="People filters">
          <FilterSubmenu label="Role" value={roleFilter} options={roleOptions} onChange={onRoleChange} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ColumnHeading({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

function PeopleCellMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "—",
  renderValue,
}: {
  value: T;
  options: { value: T; label: string; helper?: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  renderValue?: (option: { value: T; label: string; helper?: string } | undefined) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label || placeholder;
  const content = renderValue ? renderValue(selected) : <span className={cn("min-w-0 truncate", !selected && "text-[var(--ink-faint)]")}>{label}</span>;

  if (disabled) {
    return <span className="task-cell-control cursor-not-allowed opacity-55">{content}</span>;
  }

  return (
    <TaskCellPopover open={open} onOpenChange={setOpen} ariaLabel={ariaLabel} header={content}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => { setOpen(false); if (option.value !== value) onChange(option.value); }} className="task-cell-popover-item">
          <span className="min-w-0 flex-1">
            <span className="block truncate">{option.label}</span>
            {option.helper && <span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
          </span>
          {option.value === value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
        </button>
      ))}
    </TaskCellPopover>
  );
}

/* ============================================================== */
/*  General tab                                                    */
/* ============================================================== */

function CompanyContentHeader({ tab }: { tab: TabValue }) {
  const copy = TAB_COPY[tab];

  return (
    <header className="company-content-header">
      <div className="min-w-0">
        <h1 className="company-content-title">{copy.title}</h1>
        <p className="company-content-description">{copy.description}</p>
      </div>
    </header>
  );
}

function GeneralTab({
  data,
  companyName,
  setCompanyName,
  timeZone,
  setTimeZone,
  savingTimeZone,
  canManageSettings,
  nameDirty,
  savingName,
  onSaveName,
  onSaveTimeZone,
  preferredAdminOptions,
  onSavePreferredAdmin,
  calendar,
  canManageCalendar,
  onSetWorkingDays,
  onAddHoliday,
  onUpdateHoliday,
  onRemoveHoliday,
}: {
  data: Overview;
  companyName: string;
  setCompanyName: (value: string) => void;
  timeZone: string;
  setTimeZone: (value: string) => void;
  savingTimeZone: boolean;
  canManageSettings: boolean;
  nameDirty: boolean;
  savingName: boolean;
  onSaveName: () => Promise<void> | void;
  onSaveTimeZone: (timeZone: string) => Promise<void> | void;
  preferredAdminOptions?: { _id: Id<"companyMemberships">; name: string }[];
  onSavePreferredAdmin: (membershipId: Id<"companyMemberships"> | null) => void;
  calendar?: WorkCalendarData;
  canManageCalendar: boolean;
  onSetWorkingDays: (workingDays: number[]) => Promise<void> | void;
  onAddHoliday: (name: string, startDate: string, endDate: string, recursYearly: boolean) => Promise<boolean> | boolean;
  onUpdateHoliday: (holidayId: Id<"companyHolidays">, name: string, startDate: string, endDate: string, recursYearly: boolean) => Promise<boolean> | boolean;
  onRemoveHoliday: (holidayId: Id<"companyHolidays">) => Promise<void> | void;
}) {
  const options = timeZoneOptions(timeZone);
  // The saved preferred admin stays visible after they lose the ability to
  // confirm, so the setting reads truthfully and can be cleared.
  const savedPreferredAdminId = data.company?.preferredAdminMembershipId ?? null;
  const savedPreferredAdmin = data.company?.preferredAdmin?._id === savedPreferredAdminId ? data.company?.preferredAdmin : null;
  const preferredAdminChoices = preferredAdminOptions && savedPreferredAdminId && !preferredAdminOptions.some((option) => option._id === savedPreferredAdminId)
    ? [{ _id: savedPreferredAdminId, name: `${savedPreferredAdmin?.name ?? "Saved admin"}${savedPreferredAdmin?.canConfirm ? "" : " (can no longer confirm)"}` }, ...preferredAdminOptions]
    : preferredAdminOptions;
  const savedTimeZone = data.company?.timeZone ?? DEFAULT_TIME_ZONE;
  const timeZoneDirty = timeZone !== savedTimeZone;

  return (
    <div className="company-tab-body">
      <section className="company-settings-section">
        <h2 className="company-tab-section-title">Workspace settings</h2>
        <div className="company-settings-list">
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Company name</div>
              <p className="company-settings-help">Shown in the sidebar, invitations, and company-level records.</p>
            </div>
            <div className="company-settings-control">
              <div className="company-name-field">
                <Input
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="Company name"
                  disabled={!canManageSettings}
                  aria-label="Company name"
                  className="company-name-input w-auto"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && nameDirty && canManageSettings) void onSaveName();
                  }}
                />
                {canManageSettings && nameDirty && (
                  <button
                    type="button"
                    className="company-name-save"
                    disabled={savingName}
                    onClick={() => void onSaveName()}
                  >
                    {savingName ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Time zone</div>
              <p className="company-settings-help">Used for JD task cycle boundaries. Browser detection falls back to GMT+5.</p>
            </div>
            <div className="company-settings-control">
              <div className="company-name-field">
                <SelectField value={timeZone} onChange={(value) => { setTimeZone(value); void onSaveTimeZone(value); }} disabled={!canManageSettings || savingTimeZone} className="min-w-[220px]">
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SelectField>
                {timeZoneDirty && canManageSettings && <span className="text-[12px] text-[var(--ink-muted)]">Saving…</span>}
              </div>
            </div>
          </div>
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Preferred admin</div>
              <p className="company-settings-help">Confirms completed tasks for people who don&apos;t report to anyone. Everyone else&apos;s tasks go to their manager.</p>
            </div>
            <div className="company-settings-control">
              <SelectField
                value={savedPreferredAdminId ?? ""}
                onChange={(value) => onSavePreferredAdmin(value ? value as Id<"companyMemberships"> : null)}
                disabled={!canManageSettings || !preferredAdminChoices}
                className="min-w-[220px]"
              >
                <option value="">None</option>
                {preferredAdminChoices?.map((option) => <option key={option._id} value={option._id}>{option.name}</option>)}
              </SelectField>
            </div>
          </div>
          <div className="company-settings-row">
            <div className="min-w-0">
              <div className="company-settings-label">Icon</div>
              <p className="company-settings-help">A simple workspace mark used in management views.</p>
            </div>
            <div className="company-settings-control justify-start sm:justify-end">
              <div className="company-logo" aria-hidden="true">{initials(companyName || data.company?.name || "Company")}</div>
            </div>
          </div>
        </div>
      </section>
      {calendar && (
        <WorkCalendarSection
          calendar={calendar}
          canManageCalendar={canManageCalendar}
          onSetWorkingDays={onSetWorkingDays}
          onAddHoliday={onAddHoliday}
          onUpdateHoliday={onUpdateHoliday}
          onRemoveHoliday={onRemoveHoliday}
        />
      )}
    </div>
  );
}

type CalendarHoliday = { _id: Id<"companyHolidays">; name: string; startDate: string; endDate: string; recursYearly: boolean };
type WorkCalendarData = { workingDays: number[]; holidays: CalendarHoliday[] };

const WEEKDAY_OPTIONS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

// Stored holiday dates are calendar dates ("YYYY-MM-DD"), not instants:
// formatting in UTC keeps the label on the stored day regardless of the
// viewer's timezone.
function formatCalendarDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatMonthDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

// Yearly ranges print as month-days ("Dec 24 – Jan 6") — the entered year is
// ignored by the backend — with recurrence carried by the "Yearly" badge on the
// row. One-time ranges compress shared year/month ("Dec 24 – 26, 2026").
function holidayRangeLabel(holiday: CalendarHoliday) {
  const start = new Date(holiday.startDate);
  const end = new Date(holiday.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "—";
  const single = holiday.startDate === holiday.endDate;
  if (holiday.recursYearly) {
    return single ? formatMonthDay(holiday.startDate) : `${formatMonthDay(holiday.startDate)} – ${formatMonthDay(holiday.endDate)}`;
  }
  if (single) return formatCalendarDate(holiday.startDate);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  if (sameYear && start.getUTCMonth() === end.getUTCMonth()) {
    const month = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(start);
    return `${month} ${start.getUTCDate()} – ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  if (sameYear) {
    const endMonthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(end);
    return `${formatMonthDay(holiday.startDate)} – ${endMonthDay}, ${end.getUTCFullYear()}`;
  }
  return `${formatCalendarDate(holiday.startDate)} – ${formatCalendarDate(holiday.endDate)}`;
}

type HolidayDialogState = { mode: "add" } | { mode: "edit"; holiday: CalendarHoliday };

function WorkCalendarSection({
  calendar,
  canManageCalendar,
  onSetWorkingDays,
  onAddHoliday,
  onUpdateHoliday,
  onRemoveHoliday,
}: {
  calendar: WorkCalendarData;
  canManageCalendar: boolean;
  onSetWorkingDays: (workingDays: number[]) => Promise<void> | void;
  onAddHoliday: (name: string, startDate: string, endDate: string, recursYearly: boolean) => Promise<boolean> | boolean;
  onUpdateHoliday: (holidayId: Id<"companyHolidays">, name: string, startDate: string, endDate: string, recursYearly: boolean) => Promise<boolean> | boolean;
  onRemoveHoliday: (holidayId: Id<"companyHolidays">) => Promise<void> | void;
}) {
  const [holidayDialog, setHolidayDialog] = useState<HolidayDialogState | null>(null);
  const workingDays = new Set(calendar.workingDays);

  const setWorkingDay = (day: number, on: boolean) => {
    const next = new Set(workingDays);
    if (on) next.add(day);
    else {
      // Keep at least one working day; the backend rejects an empty list.
      if (next.size === 1) return;
      next.delete(day);
    }
    void onSetWorkingDays([...next].sort((a, b) => a - b));
  };

  return (
    <section className="company-settings-section">
      <h2 className="company-tab-section-title">Work calendar</h2>
      <div className="company-settings-list">
        <div className="company-settings-row">
          <div className="min-w-0">
            <div className="company-settings-label">Working days</div>
            <p className="company-settings-help">
              Daily and every-other-day tasks skip these days; other tasks move to the next working day.
            </p>
          </div>
          <div className="company-settings-control">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_OPTIONS.map((day) => {
                const on = workingDays.has(day.value);
                const lastWorkingDay = on && workingDays.size === 1;
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={on}
                    aria-label={day.label}
                    title={lastWorkingDay ? "At least one working day is required" : undefined}
                    disabled={!canManageCalendar}
                    onClick={() => setWorkingDay(day.value, !on)}
                    className={cn(
                      "h-7 min-w-[42px] rounded-md border px-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60",
                      on
                        ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--on-primary)]"
                        : "border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink-muted)] hover:border-[var(--hairline-strong)] hover:text-[var(--ink)]",
                    )}
                  >
                    {day.label.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="company-settings-row">
          <div className="min-w-0">
            <div className="company-settings-label">Holidays</div>
            <p className="company-settings-help">Days off, as a single date or a range. They count as non-working days; turn on Repeats every year to recur annually.</p>
          </div>
          <div className="company-settings-control">
            <div className="flex w-full flex-col gap-2 sm:w-[380px]">
              {calendar.holidays.length === 0 && (
                <p className="rounded-md border border-dashed border-[var(--hairline)] px-3 py-2.5 text-[12px] text-[var(--ink-muted)]">No holidays yet.</p>
              )}
              {calendar.holidays.map((holiday) => (
                <div key={holiday._id} className="flex items-center gap-2 rounded-md border border-[var(--hairline)] px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[var(--ink)]">{holiday.name}</div>
                    <div className="text-[12px] text-[var(--ink-muted)]">{holidayRangeLabel(holiday)}</div>
                  </div>
                  {holiday.recursYearly && (
                    <Badge tone="blue" className="shrink-0 gap-1">
                      <Repeat className="h-3 w-3" />
                      Yearly
                    </Badge>
                  )}
                  {canManageCalendar && (
                    <>
                      <button
                        type="button"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]"
                        onClick={() => setHolidayDialog({ mode: "edit", holiday })}
                        aria-label={`Edit ${holiday.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]"
                        onClick={() => void onRemoveHoliday(holiday._id)}
                        aria-label={`Remove ${holiday.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {canManageCalendar && (
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--hairline)] px-2.5 py-2 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  onClick={() => setHolidayDialog({ mode: "add" })}
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <HolidayDialog
        open={holidayDialog !== null}
        onOpenChange={(open) => {
          if (!open) setHolidayDialog(null);
        }}
        holiday={holidayDialog?.mode === "edit" ? holidayDialog.holiday : undefined}
        onSave={(name, startDate, endDate, recursYearly) =>
          holidayDialog?.mode === "edit"
            ? onUpdateHoliday(holidayDialog.holiday._id, name, startDate, endDate, recursYearly)
            : onAddHoliday(name, startDate, endDate, recursYearly)
        }
      />
    </section>
  );
}

function HolidayDialog({
  open,
  onOpenChange,
  holiday,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holiday?: CalendarHoliday;
  onSave: (name: string, startDate: string, endDate: string, recursYearly: boolean) => Promise<boolean> | boolean;
}) {
  const editing = holiday !== undefined;
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [yearly, setYearly] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed the draft once per dialog session (keyed by the holiday id): the
  // calendar is a live query, so an unrelated update to this row must not
  // reset fields the user is mid-way through editing. sessionRef distinguishes
  // successive opens of the same target for the stale-save guard in submit.
  const seededKeyRef = useRef<string | null>(null);
  const sessionRef = useRef(0);
  useEffect(() => {
    if (!open) {
      seededKeyRef.current = null;
      return;
    }
    const key = holiday?._id ?? "add";
    if (seededKeyRef.current === key) return;
    seededKeyRef.current = key;
    sessionRef.current += 1;
    setName(holiday?.name ?? "");
    setStart(holiday?.startDate ?? "");
    setEnd(holiday?.endDate ?? "");
    setYearly(holiday?.recursYearly ?? false);
    setSaving(false);
  }, [open, holiday]);

  // The non-modal dialog leaves the page behind it in the tab order; inert it
  // so keyboard and assistive-tech users stay inside the dialog. The DateField
  // popover portals to body after this runs, so it stays reachable.
  useEffect(() => {
    if (!open) return;
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement) || el.matches('[role="dialog"]') || el.querySelector('[role="dialog"]')) continue;
      el.inert = true;
      inerted.push(el);
    }
    return () => {
      for (const el of inerted) el.inert = false;
    };
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !start || saving) return;
    // A save from an earlier session must not close or update a dialog the
    // user has since closed and reopened.
    const session = sessionRef.current;
    setSaving(true);
    try {
      // Keep the dialog filled when the save fails so the entry isn't lost.
      if ((await onSave(trimmed, start, end || start, yearly)) && session === sessionRef.current) {
        onOpenChange(false);
      }
    } finally {
      if (session === sessionRef.current) setSaving(false);
    }
  };

  return (
    // Non-modal on purpose: a modal dialog sets pointer-events:none on body
    // and traps focus inside Dialog.Content, which would make DateField's
    // body-portaled calendar popover unreachable by mouse and keyboard. The
    // overlay, the inert background above, and the outside-interaction guards
    // below keep the rest of the page inert and the dialog open, so it still
    // behaves modally.
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(480px,94dvh)] w-[min(400px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
                {editing ? "Edit holiday" : "Add holiday"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                A single date or a start–end range of named days off.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">
                  Name
                </span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Holiday name"
                  aria-label="Holiday name"
                  autoFocus
                />
              </label>
              <div className="mt-3 flex items-center gap-1.5">
                <DateField
                  value={start}
                  onChange={setStart}
                  placeholder="Start date"
                  aria-label="Holiday start date"
                  className="min-w-0 flex-1"
                />
                <span className="shrink-0 px-0.5 text-[12px] text-[var(--ink-faint)]">to</span>
                <DateField
                  value={end}
                  onChange={setEnd}
                  placeholder="End date"
                  aria-label="Holiday end date (optional)"
                  clearable
                  className="min-w-0 flex-1"
                />
              </div>
              <div className="mt-3">
                <Switch checked={yearly} onCheckedChange={setYearly} aria-label="Repeat holiday every year">
                  <span className="text-[13px] text-[var(--ink)]">Repeats every year</span>
                </Switch>
                {yearly && (
                  <p className="mt-2 text-[12px] leading-snug text-[var(--ink-muted)]">
                    {start && end && end.slice(5) < start.slice(5)
                      ? `Wraps the year boundary — runs ${formatMonthDay(start)} through ${formatMonthDay(end)} each year.`
                      : "Repeats on the same dates every year; the picked year is ignored."}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving || !name.trim() || !start}>
                {saving ? "Saving..." : editing ? "Save changes" : "Add holiday"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Structure tab                                                  */
/* ============================================================== */

const BRANCH_GROUP = "branches";
const BRANCH_TYPE = "branch";
const DEPT_TYPE = "department";

type BranchSortableData = { kind: typeof BRANCH_TYPE };
type DepartmentSortableData = { kind: typeof DEPT_TYPE };
type ZoneData = { kind: "branchZone"; branchId: Id<"branches"> };

function arrayMove<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function StructureBranchRow({
  branch,
  index,
  depCount,
  memberCount,
  isCollapsed,
  canDrag,
  onToggleCollapse,
  onDelete,
  children,
}: {
  branch: BranchRow;
  index: number;
  depCount: number;
  memberCount: number;
  isCollapsed: boolean;
  canDrag: boolean;
  onToggleCollapse: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  const { ref, targetRef, handleRef, isDragging } = useSortable<BranchSortableData>({
    id: branch._id,
    index,
    group: BRANCH_GROUP,
    type: BRANCH_TYPE,
    accept: BRANCH_TYPE,
    disabled: !canDrag,
    data: { kind: BRANCH_TYPE },
  });
  return (
    <div ref={ref} className={cn("structure-branch", isDragging && "is-dragging")}>
      <div
        ref={targetRef}
        className={cn("structure-row structure-row-branch", isDragging && "is-dragging")}
      >
        {canDrag && (
          <button type="button" ref={handleRef} className="structure-grip" aria-label="Drag branch">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="structure-chevron"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expand branch" : "Collapse branch"}
        >
          {depCount > 0 ? (isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />) : <span className="h-3.5 w-3.5" />}
        </button>
        <Building2 className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{branch.name}</span>
        <span className="structure-count">{depCount} dept{depCount === 1 ? "" : "s"} · {memberCount} member{memberCount === 1 ? "" : "s"}</span>
        {canDrag && (
          <button
            type="button"
            className="task-icon-btn"
            onClick={onDelete}
            aria-label={`Delete branch ${branch.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function StructureDepartmentRow({
  dep,
  index,
  branchId,
  memberCount,
  canDrag,
  onDelete,
}: {
  dep: DepartmentRow;
  index: number;
  branchId: Id<"branches">;
  memberCount: number;
  canDrag: boolean;
  onDelete: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable<DepartmentSortableData>({
    id: dep._id,
    index,
    group: branchId,
    type: DEPT_TYPE,
    accept: DEPT_TYPE,
    disabled: !canDrag,
    data: { kind: DEPT_TYPE },
  });
  return (
    <div
      ref={ref}
      className={cn("structure-row structure-row-department", isDragging && "is-dragging")}
    >
      {canDrag && (
        <button type="button" ref={handleRef} className="structure-grip" aria-label="Drag department">
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <span className="structure-chevron-placeholder" aria-hidden />
      <Layers className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
      <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{dep.name}</span>
      <span className="structure-count">{memberCount} member{memberCount === 1 ? "" : "s"}</span>
      {canDrag && (
        <button
          type="button"
          className="task-icon-btn"
          onClick={onDelete}
          aria-label={`Delete department ${dep.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function StructureBranchDropZone({ branchId }: { branchId: Id<"branches"> }) {
  const { ref, isDropTarget } = useDroppable<ZoneData>({
    id: `zone-${branchId}`,
    type: "branchZone",
    accept: DEPT_TYPE,
    data: { kind: "branchZone", branchId },
  });
  return <div ref={ref} className={cn("structure-dropzone", isDropTarget && "is-drop-target")} />;
}

function StructureTab({
  data,
  canManageBranches,
  canManageDepartments,
  onCreateBranch,
  onCreateDepartment,
  onDeleteBranch,
  onDeleteDepartment,
  onReorderBranches,
  onMoveDepartment,
}: {
  data: Overview;
  canManageBranches: boolean;
  canManageDepartments: boolean;
  onCreateBranch: (name: string) => void;
  onCreateDepartment: (branchId: Id<"branches">, name: string) => void;
  onDeleteBranch: (id: Id<"branches">) => Promise<void>;
  onDeleteDepartment: (id: Id<"departments">) => Promise<void>;
  onReorderBranches: (orderedBranchIds: Id<"branches">[]) => Promise<void>;
  onMoveDepartment: (departmentId: Id<"departments">, toBranchId: Id<"branches">, orderedDepartmentIds: Id<"departments">[]) => Promise<void>;
}) {
  const [branches, setBranches] = useState<BranchRow[]>(data.branches);
  const [departments, setDepartments] = useState<DepartmentRow[]>(data.departments);
  const [collapsed, setCollapsed] = useState<Set<Id<"branches">>>(new Set());
  const [newBranchName, setNewBranchName] = useState("");
  const [newDeptByBranch, setNewDeptByBranch] = useState<Record<string, string>>({});
  const isDragging = useRef(false);
  // In-flight optimistic structure ops: an unrelated overview update must not
  // snap a just-dropped node back before its mutation commits.
  const pendingStructureOps = useRef(0);
  // Set when an overview update arrives during a drag or pending op; the last
  // settling op replays it so a skipped update cannot stay hidden forever.
  const skippedReseed = useRef(false);
  const [structureOpsDrained, setStructureOpsDrained] = useState(0);

  // Re-seed from real-time data when no drag or pending save is in progress.
  useEffect(() => {
    if (isDragging.current || pendingStructureOps.current > 0) {
      skippedReseed.current = true;
      return;
    }
    skippedReseed.current = false;
    setBranches(data.branches);
    setDepartments(data.departments);
  }, [data.branches, data.departments, structureOpsDrained]);

  async function withStructureOp<T>(op: () => Promise<T>): Promise<T> {
    pendingStructureOps.current += 1;
    try {
      return await op();
    } finally {
      pendingStructureOps.current -= 1;
      if (pendingStructureOps.current === 0 && skippedReseed.current) setStructureOpsDrained((tick) => tick + 1);
    }
  }

  const departmentsByBranch = useMemo(() => {
    const map = new Map<Id<"branches">, DepartmentRow[]>();
    for (const branch of branches) map.set(branch._id, []);
    const sorted = [...departments].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a._id.localeCompare(b._id));
    for (const dep of sorted) {
      const list = map.get(dep.branchId);
      if (list) list.push(dep);
    }
    return map;
  }, [branches, departments]);

  // Single pass over users; per-row lookups become map reads.
  const memberCounts = useMemo(() => {
    const byBranch = new Map<string, number>();
    const byDepartment = new Map<string, number>();
    for (const user of data.users) {
      for (const id of user.branchIds) byBranch.set(id, (byBranch.get(id) ?? 0) + 1);
      for (const id of user.departmentIds) byDepartment.set(id, (byDepartment.get(id) ?? 0) + 1);
    }
    return { byBranch, byDepartment };
  }, [data.users]);
  const memberCountForBranch = (branchId: Id<"branches">) => memberCounts.byBranch.get(branchId) ?? 0;
  const memberCountForDepartment = (departmentId: Id<"departments">) => memberCounts.byDepartment.get(departmentId) ?? 0;

  function toggleCollapse(branchId: Id<"branches">) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  function expand(branchId: Id<"branches">) {
    setCollapsed((prev) => {
      if (!prev.has(branchId)) return prev;
      const next = new Set(prev);
      next.delete(branchId);
      return next;
    });
  }

  // Deletes feel instant: once confirmed, the node leaves the local tree
  // immediately and comes back if the mutation rejects. Confirm before
  // mutating local state — a cancelled confirm resolves without deleting.
  async function deleteBranchOptimistic(branchId: Id<"branches">) {
    if (!window.confirm("Delete this branch? Departments and assignments must be removed first.")) return;
    const previousBranches = branches;
    const previousDepartments = departments;
    setBranches(branches.filter((branch) => branch._id !== branchId));
    setDepartments(departments.filter((dep) => dep.branchId !== branchId));
    try {
      await withStructureOp(() => onDeleteBranch(branchId));
    } catch {
      setBranches(previousBranches);
      setDepartments(previousDepartments);
    }
  }

  async function deleteDepartmentOptimistic(departmentId: Id<"departments">) {
    if (!window.confirm("Delete this department? Assignments must be removed first.")) return;
    const previousDepartments = departments;
    setDepartments(departments.filter((dep) => dep._id !== departmentId));
    try {
      await withStructureOp(() => onDeleteDepartment(departmentId));
    } catch {
      setDepartments(previousDepartments);
    }
  }

  const newDeptName = (branchId: Id<"branches">) => newDeptByBranch[branchId] ?? "";
  const setNewDeptName = (branchId: Id<"branches">, value: string) =>
    setNewDeptByBranch((prev) => ({ ...prev, [branchId]: value }));

  async function commitDepartmentToBranch(deptId: Id<"departments">, toBranchId: Id<"branches">) {
    const previousDepartments = departments;
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranchId);
    toList.push({ ...dragged, branchId: toBranchId });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranchId, order: i }));
    const others = without.filter((d) => d.branchId !== toBranchId);
    setDepartments([...others, ...reindexed]);
    try {
      await withStructureOp(() => onMoveDepartment(deptId, toBranchId, reindexed.map((d) => d._id)));
      expand(toBranchId);
    } catch {
      setDepartments(previousDepartments);
    }
  }

  async function commitDepartmentSort(
    deptId: Id<"departments">,
    fromBranch: Id<"branches">,
    toBranch: Id<"branches">,
    toIndex: number,
  ) {
    const previousDepartments = departments;
    const dragged = departments.find((d) => d._id === deptId);
    if (!dragged) return;
    const without = departments.filter((d) => d._id !== deptId);
    const toList = without.filter((d) => d.branchId === toBranch);
    toList.splice(toIndex, 0, { ...dragged, branchId: toBranch });
    const reindexed = toList.map((d, i) => ({ ...d, branchId: toBranch, order: i }));
    const others = without.filter((d) => d.branchId !== toBranch);
    setDepartments([...others, ...reindexed]);
    try {
      await withStructureOp(() => onMoveDepartment(deptId, toBranch, reindexed.map((d) => d._id)));
      if (fromBranch !== toBranch) expand(toBranch);
    } catch {
      setDepartments(previousDepartments);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    isDragging.current = false;
    try {
      if (event.canceled) return;
      const { source, target } = event.operation;
      if (!source) return;

      // Dropped onto a branch drop zone → append only departments to that branch.
      if (target?.data?.kind === "branchZone") {
        if (source.data?.kind !== DEPT_TYPE) return;
        void commitDepartmentToBranch(source.id as Id<"departments">, target.data.branchId as Id<"branches">);
        return;
      }

      if (!isSortable(source)) return;

      // Branch reorder (top-level group).
      if (source.data?.kind === BRANCH_TYPE) {
        if (source.initialGroup !== BRANCH_GROUP || source.initialIndex === source.index) return;
        const previousBranches = branches;
        const reordered = arrayMove(branches, source.initialIndex, source.index).map((b, i) => ({ ...b, order: i }));
        setBranches(reordered);
        void withStructureOp(() => onReorderBranches(reordered.map((b) => b._id))).catch(() => setBranches(previousBranches));
        return;
      }

      // Department move (within or across branches).
      if (source.data?.kind !== DEPT_TYPE) return;
      const fromBranch = source.initialGroup as Id<"branches">;
      const toBranch = source.group as Id<"branches">;
      if (!fromBranch || !toBranch) return;
      void commitDepartmentSort(source.id as Id<"departments">, fromBranch, toBranch, source.index);
    } finally {
      // A cancelled or no-op drop never reaches withStructureOp — replay any
      // overview update skipped during the drag once nothing is pending.
      if (skippedReseed.current && pendingStructureOps.current === 0) setStructureOpsDrained((tick) => tick + 1);
    }
  }

  return (
    <div className="company-tab-body">
      <div className="company-tab-section">
        <DragDropProvider
          onDragStart={() => { isDragging.current = true; }}
          onDragEnd={handleDragEnd}
        >
          <div className="structure-tree">
            {branches.length === 0 && (
              <EmptyState
                icon={Network}
                title="No branches yet"
                message="Create a branch to start organizing your workspace into teams."
                action={
                  canManageBranches ? (
                    <div className="structure-add-row structure-add-row-inline">
                      <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                      <input
                        autoFocus
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        placeholder="Add a branch…"
                        className="structure-add-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newBranchName.trim()) {
                            onCreateBranch(newBranchName.trim());
                            setNewBranchName("");
                          }
                        }}
                      />
                    </div>
                  ) : undefined
                }
              />
            )}

            {branches.map((branch, branchIndex) => {
              const isCollapsed = collapsed.has(branch._id);
              const deps = departmentsByBranch.get(branch._id) ?? [];
              const depCount = deps.length;
              const memberCount = memberCountForBranch(branch._id);
              return (
                <StructureBranchRow
                  key={branch._id}
                  branch={branch}
                  index={branchIndex}
                  depCount={depCount}
                  memberCount={memberCount}
                  isCollapsed={isCollapsed}
                  canDrag={canManageBranches}
                  onToggleCollapse={() => toggleCollapse(branch._id)}
                  onDelete={() => void deleteBranchOptimistic(branch._id)}
                >
                  {!isCollapsed && (
                    <div className="structure-departments">
                      {deps.map((dep, depIndex) => (
                        <StructureDepartmentRow
                          key={dep._id}
                          dep={dep}
                          index={depIndex}
                          branchId={branch._id}
                          memberCount={memberCountForDepartment(dep._id)}
                          canDrag={canManageDepartments}
                          onDelete={() => void deleteDepartmentOptimistic(dep._id)}
                        />
                      ))}

                      <StructureBranchDropZone branchId={branch._id} />

                      {canManageDepartments && (
                        <div className="structure-add-row">
                          <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                          <input
                            value={newDeptName(branch._id)}
                            onChange={(e) => setNewDeptName(branch._id, e.target.value)}
                            placeholder="Add a department…"
                            className="structure-add-input"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newDeptName(branch._id).trim()) {
                                onCreateDepartment(branch._id, newDeptName(branch._id).trim());
                                setNewDeptName(branch._id, "");
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </StructureBranchRow>
              );
            })}

            {canManageBranches && branches.length > 0 && (
              <div className="structure-add-row structure-add-row-branch">
                <Plus className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                <input
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="Add a branch…"
                  className="structure-add-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newBranchName.trim()) {
                      onCreateBranch(newBranchName.trim());
                      setNewBranchName("");
                    }
                  }}
                />
              </div>
            )}
          </div>
        </DragDropProvider>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  Edit member name dialog                                        */
/* ============================================================== */

function EditMemberNameDialog({
  open,
  onOpenChange,
  user,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user?: UserRow;
  onSave: (user: UserRow, firstName: string, secondName: string) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState("");
  const [secondName, setSecondName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && user) {
      setFirstName(user.user.firstName || user.user.name || "");
      setSecondName(user.user.secondName || "");
      setError(null);
    }
  }, [open, user]);

  async function submit() {
    if (!user || saving) return;
    const trimmedFirst = firstName.trim();
    const trimmedSecond = secondName.trim();
    if (!trimmedFirst) {
      setError("First name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(user, trimmedFirst, trimmedSecond);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update name.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(480px,94dvh)] w-[min(440px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
                Edit name
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                Update name for {user?.user.email}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">
                    First name
                  </span>
                  <Input
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    placeholder="First name"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">
                    Last name
                  </span>
                  <Input
                    value={secondName}
                    onChange={(event) => setSecondName(event.target.value)}
                    placeholder="Last name"
                  />
                </label>
              </div>
              {error && (
                <p className="alert-error mt-4 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving || !firstName.trim()}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  People tab                                                     */
/* ============================================================== */

type PeopleView = "members" | "invited";

function PeopleTab({
  data,
  onInvite,
  onUpdateName,
  onRoleChange,
  onBulkRoleChange,
  onManageAccess,
  onBranchChange,
  onDepartmentChange,
  onStatusChange,
  onRemoveUsers,
  onCancelInvitation,
  canManageUsers,
  canManageRoles,
  canInvite,
}: {
  data: Overview;
  onInvite: () => void;
  onUpdateName: (user: UserRow, firstName: string, secondName: string) => Promise<void>;
  onRoleChange: (user: UserRow, role: string) => Promise<void>;
  onBulkRoleChange: (membershipIds: Id<"companyMemberships">[], role: string) => Promise<void>;
  onManageAccess: (user: UserRow) => void;
  onBranchChange: (user: UserRow, branchId: Id<"branches"> | "") => Promise<void>;
  onDepartmentChange: (user: UserRow, departmentId: Id<"departments"> | "") => Promise<void>;
  onStatusChange: (user: UserRow, active: boolean) => Promise<void>;
  onRemoveUsers: (membershipIds: Id<"companyMemberships">[]) => Promise<void>;
  onCancelInvitation: (invitation: InvitationRow) => Promise<void>;
  canManageUsers: boolean;
  canManageRoles: boolean;
  canInvite: boolean;
}) {
  const [view, setView] = useState<PeopleView>("members");
  const [editingUser, setEditingUser] = useState<UserRow | undefined>();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string | "all">("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<Id<"companyMemberships">>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [assigningRole, setAssigningRole] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const branchMap = useMemo(() => new Map(data.branches.map((b) => [b._id, b.name])), [data.branches]);
  const departmentMap = useMemo(() => new Map(data.departments.map((d) => [d._id, d.name])), [data.departments]);
  const roleNames = useMemo(() => {
    const names = new Set(data.roles.map((role) => role.name));
    for (const user of data.users) names.add(user.membership.role);
    for (const invitation of data.invitations) names.add(invitation.role);
    names.delete("");
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data.roles, data.users, data.invitations]);
  const normalized = query.trim().toLowerCase();
  const filteredUsers = useMemo(() => data.users.filter((user) => (!normalized || `${user.user.name} ${user.user.email}`.toLowerCase().includes(normalized)) && (roleFilter === "all" || user.membership.role === roleFilter)), [data.users, normalized, roleFilter]);
  const filteredInvitations = useMemo(() => data.invitations.filter((invitation) => (!normalized || invitation.email.toLowerCase().includes(normalized)) && (roleFilter === "all" || invitation.role === roleFilter)), [data.invitations, normalized, roleFilter]);
  const visibleUserIds = filteredUsers.map((user) => user.membership._id);
  const selectedVisibleCount = visibleUserIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
  const allVisibleSelected = filteredUsers.length > 0 && selectedVisibleCount === filteredUsers.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectionCount = selectedIds.size;

  useEffect(() => {
    setSelectedIds((current) => {
      const known = new Set(data.users.map((user) => user.membership._id));
      const next = new Set(Array.from(current).filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [data.users]);
  useEffect(() => { if (view !== "members" && selectedIds.size > 0) setSelectedIds(new Set()); }, [selectedIds.size, view]);

  function toggleOne(id: Id<"companyMemberships">) {
    setSelectedIds((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    setRemoveError(null);
  }
  function toggleAllVisible() {
    setSelectedIds((current) => { const next = new Set(current); if (allVisibleSelected) for (const id of visibleUserIds) next.delete(id); else for (const id of visibleUserIds) next.add(id); return next; });
    setRemoveError(null);
  }
  function clearSelection() { setSelectedIds(new Set()); setRemoveError(null); setAssignError(null); }
  async function removeSelected() {
    if (selectionCount === 0 || removing) return;
    setRemoving(true); setRemoveError(null);
    try { await onRemoveUsers(Array.from(selectedIds)); setSelectedIds(new Set()); }
    catch (err) { setRemoveError(err instanceof Error ? err.message : "Could not remove selected users."); }
    finally { setRemoving(false); }
  }
  async function assignRoleToSelected(role: string) {
    if (selectionCount === 0 || assigningRole) return;
    setAssigningRole(true); setAssignError(null);
    try { await onBulkRoleChange(Array.from(selectedIds), role); setSelectedIds(new Set()); }
    catch (err) { setAssignError(err instanceof Error ? err.message : "Could not assign role."); }
    finally { setAssigningRole(false); }
  }

  const filterCount = (roleFilter !== "all" ? 1 : 0) + (query.trim() !== "" ? 1 : 0);
  const isEmpty = view === "members" ? filteredUsers.length === 0 : filteredInvitations.length === 0;

  return (
    <div className="company-tab-body company-people-body">
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-nowrap md:items-center">
        <div className="task-view-toggle min-w-0 flex-1" aria-label="People view">
          <button type="button" className="task-view-button" data-active={view === "members"} onClick={() => setView("members")}><Users className="h-4 w-4" />Members<span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">{data.users.length}</span></button>
          <button type="button" className="task-view-button" data-active={view === "invited"} onClick={() => setView("invited")}><MailPlus className="h-4 w-4" />Invited<span className="rounded-full bg-[var(--surface-pressed)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--ink-muted)]">{data.invitations.length}</span></button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 md:flex-nowrap md:ml-auto">
          <div className="task-search-control" data-open={searchOpen || query.trim() !== ""}>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="task-search-input border-none focus:border-none bg-transparent" placeholder={view === "members" ? "Search by name or email" : "Search invited"} aria-label={view === "members" ? "Search members" : "Search invited"} tabIndex={searchOpen || query.trim() !== "" ? 0 : -1} />
            <button type="button" className="task-search-button" aria-label={query ? "Clear search" : "Search people"} onClick={() => { if (query) setQuery(""); else setSearchOpen((open) => !open); }}>{query ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}</button>
          </div>
          <CompanyFilterMenu roleFilter={roleFilter} roleNames={roleNames} activeCount={filterCount} onRoleChange={setRoleFilter} />
          {canInvite && <Button variant="primary" size="sm" onClick={onInvite}><MailPlus className="h-4 w-4" />Invite</Button>}
        </div>
      </div>

      {view === "members" ? (
        <div className="relative">
          {selectionCount > 0 && <div className="task-selection-layer"><div className="task-selection-pill" role="status" aria-live="polite"><span className="task-selection-pill-count">{selectionCount} selected</span><span className="task-selection-pill-divider" aria-hidden="true" /><button type="button" className="task-selection-pill-btn" onClick={clearSelection} disabled={removing || assigningRole} aria-label="Cancel selection"><X className="h-4 w-4" /></button>{canManageRoles && (<><span className="task-selection-pill-divider" aria-hidden="true" /><DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="task-selection-pill-btn" disabled={removing || assigningRole} aria-label={selectionCount === 1 ? "Assign role to selected user" : `Assign role to ${selectionCount} selected users`} title="Assign role"><UserCog className="h-4 w-4" /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="center" sideOffset={6} className="task-menu min-w-44" aria-label="Assign role">{roleNames.length === 0 ? <DropdownMenu.Item disabled className="task-menu-item">No roles yet</DropdownMenu.Item> : roleNames.map((roleName) => <DropdownMenu.Item key={roleName} onSelect={() => void assignRoleToSelected(roleName)} className="task-menu-item"><span className="min-w-0 flex-1 truncate">{roleName}</span></DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></>)}{canManageUsers && (<><span className="task-selection-pill-divider" aria-hidden="true" /><button type="button" className="task-selection-pill-btn" data-danger="true" onClick={() => void removeSelected()} disabled={removing || assigningRole} aria-label={selectionCount === 1 ? "Remove selected user" : `Remove ${selectionCount} selected users`} title="Remove user"><UserMinus className="h-4 w-4" /></button></>)}</div>{removeError && <p className="alert-error task-selection-error" role="alert">{removeError}</p>}{assignError && <p className="alert-error task-selection-error" role="alert">{assignError}</p>}</div>}
          <div className="company-table-wrap task-table-wrap list-rail-gutter list-rail-gutter--narrow relative overflow-x-auto">
            {(canManageUsers || canManageRoles) && filteredUsers.length > 0 && <div className="task-checkbox-rail pointer-events-none absolute left-0 top-0 z-10 flex w-11 flex-col pr-2"><div className="flex h-9 items-center justify-end group/head pointer-events-auto"><Checkbox checked={allVisibleSelected} indeterminate={someVisibleSelected} onCheckedChange={toggleAllVisible} aria-label={allVisibleSelected ? "Unselect all users" : "Select all users"} className={cn("transition-opacity", selectionCount > 0 ? "opacity-100" : "opacity-0 group-hover/head:opacity-100")} /></div>{filteredUsers.map((user) => { const isChecked = selectedIds.has(user.membership._id); return <div key={`rail-${user.membership._id}`} className="group/rail flex h-[41px] items-center justify-end pointer-events-auto"><Checkbox checked={isChecked} onCheckedChange={() => toggleOne(user.membership._id)} aria-label={isChecked ? `Unselect ${user.user.name || user.user.email}` : `Select ${user.user.name || user.user.email}`} className={cn("transition-opacity", isChecked ? "opacity-100" : "opacity-0 group-hover/rail:opacity-100 focus-visible:opacity-100")} /></div>; })}</div>}
            <table className="task-table">
              <thead><tr className="group/head"><th className="min-w-[220px]"><ColumnHeading icon={Users}>Member</ColumnHeading></th><th className="w-32"><ColumnHeading icon={UserCog}>Role</ColumnHeading></th><th className="min-w-[140px]"><ColumnHeading icon={Building2}>Branch</ColumnHeading></th><th className="min-w-[160px]"><ColumnHeading icon={Layers}>Department</ColumnHeading></th><th className="w-28"><ColumnHeading icon={CirclePause}>Status</ColumnHeading></th><th className="w-32"><ColumnHeading icon={CalendarDays}>Joined</ColumnHeading></th></tr></thead>
              <tbody>
                {isEmpty ? <tr><td colSpan={6} className="!h-auto !border-0 !bg-transparent py-2"><EmptyState icon={Users} title={query || roleFilter !== "all" ? "No matching members" : "No members yet"} message={query || roleFilter !== "all" ? "Try adjusting your search or filters." : "Invite the first person to join this workspace."} action={canInvite && !query && roleFilter === "all" ? <Button size="sm" variant="primary" onClick={onInvite}><MailPlus className="h-3.5 w-3.5" />Invite member</Button> : undefined} /></td></tr> : filteredUsers.map((user) => {
                  const isChecked = selectedIds.has(user.membership._id);
                  const branchId: Id<"branches"> | "" = user.branchIds[0] ?? "";
                  const departmentId: Id<"departments"> | "" = user.departmentIds[0] ?? "";
                  const branchOptions: { value: Id<"branches"> | ""; label: string }[] = [{ value: "", label: "No branch" }, ...data.branches.map((branch) => ({ value: branch._id, label: branch.name }))];
                  const departmentOptions: { value: Id<"departments"> | ""; label: string }[] = [{ value: "", label: "No department" }, ...data.departments.filter((department) => department.branchId === branchId).map((department) => ({ value: department._id, label: department.name }))];
                  return (
                    <tr key={user.membership._id} className="group/row" data-checked={isChecked ? "true" : undefined}>
                      <td className="col-task max-w-[280px]">
                        <div className="task-title-cell">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <MemberAvatar name={user.user.name} email={user.user.email} />
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-medium text-[var(--ink)]">{user.user.name || user.user.email}</div>
                              <div className="truncate text-[12px] text-[var(--ink-muted)]">{user.user.email}</div>
                            </div>
                          </div>
                          {canManageUsers && (
                            <button
                              type="button"
                              data-interactive="true"
                              data-tooltip="Edit name"
                              className="task-title-open task-title-open--secondary"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingUser(user);
                              }}
                              aria-label={`Edit name for ${user.user.name || user.user.email}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span>EDIT</span>
                            </button>
                          )}
                          {(canManageUsers || canManageRoles) && (
                            <button
                              type="button"
                              data-interactive="true"
                              data-tooltip="Manage access"
                              className="task-title-open"
                              onClick={(event) => {
                                event.stopPropagation();
                                onManageAccess(user);
                              }}
                              aria-label={`Manage access for ${user.user.name || user.user.email}`}
                            >
                              <PanelRight className="h-3.5 w-3.5" />
                              <span>OPEN</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td><PeopleCellMenu value={user.membership.role} options={roleNames.map((role) => ({ value: role, label: role }))} onChange={(role) => { if (role !== user.membership.role) void onRoleChange(user, role); }} ariaLabel={`Change role for ${user.user.name || user.user.email}`} disabled={!canManageRoles} renderValue={(option) => <Badge tone={roleBadgeTone(option?.value ?? user.membership.role)}>{option?.label ?? user.membership.role}</Badge>} /></td>
                      <td><PeopleCellMenu value={branchId} options={branchOptions} onChange={(nextBranchId) => { if (nextBranchId !== branchId) void onBranchChange(user, nextBranchId); }} ariaLabel={`Change branch for ${user.user.name || user.user.email}`} disabled={!canManageUsers} /></td>
                      <td><PeopleCellMenu value={departmentId} options={departmentOptions} onChange={(nextDepartmentId) => { if (nextDepartmentId !== departmentId) void onDepartmentChange(user, nextDepartmentId); }} ariaLabel={`Change department for ${user.user.name || user.user.email}`} disabled={!canManageUsers || !branchId} placeholder={branchId ? "—" : "Select branch first"} /></td>
                      <td><PeopleCellMenu value={user.membership.active ? "active" : "inactive"} options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} onChange={(status) => { const active = status === "active"; if (active !== user.membership.active) void onStatusChange(user, active); }} ariaLabel={`Change status for ${user.user.name || user.user.email}`} disabled={!canManageUsers} renderValue={(option) => <Badge tone={(option?.value ?? (user.membership.active ? "active" : "inactive")) === "active" ? "green" : "neutral"}>{option?.label ?? (user.membership.active ? "Active" : "Inactive")}</Badge>} /></td>
                      <td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(user.membership.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="company-table-wrap"><table className="task-table"><thead><tr><th className="min-w-[220px]"><ColumnHeading icon={MailPlus}>Invitation</ColumnHeading></th><th className="w-28"><ColumnHeading icon={UserCog}>Role</ColumnHeading></th><th className="min-w-[120px]"><ColumnHeading icon={Building2}>Branch</ColumnHeading></th><th className="min-w-[140px]"><ColumnHeading icon={Layers}>Department</ColumnHeading></th><th className="w-28"><ColumnHeading icon={CirclePause}>Status</ColumnHeading></th><th className="w-32"><ColumnHeading icon={CalendarDays}>Invited</ColumnHeading></th>{canInvite && <th className="w-16"><span className="sr-only">Actions</span></th>}</tr></thead><tbody>
          {isEmpty ? <tr><td colSpan={canInvite ? 7 : 6} className="!h-auto !border-0 !bg-transparent py-2"><EmptyState icon={MailPlus} title={query || roleFilter !== "all" ? "No matching invitations" : "No pending invitations"} message={query || roleFilter !== "all" ? "Try adjusting your search or filters." : "Invite a person to send them a join link."} action={canInvite && !query && roleFilter === "all" ? <Button size="sm" variant="primary" onClick={onInvite}><MailPlus className="h-3.5 w-3.5" />Invite member</Button> : undefined} /></td></tr> : filteredInvitations.map((invitation) => <tr key={invitation._id} className="group/row"><td><div className="flex items-center gap-2.5"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--ink-faint)]"><MailPlus className="h-3.5 w-3.5" /></span><div className="min-w-0"><div className="truncate text-[13px] font-medium text-[var(--ink)]">{invitation.email}</div><div className="truncate text-[12px] text-[var(--ink-muted)]">Pending invitation</div></div></div></td><td><Badge tone={roleBadgeTone(invitation.role)}>{invitation.role}</Badge></td><td className="text-[var(--ink-secondary)]"><span className="truncate">{invitation.branchIds.map((id) => branchMap.get(id)).filter(Boolean).join(", ") || "—"}</span></td><td className="text-[var(--ink-secondary)]"><span className="truncate">{invitation.departmentIds.map((id) => departmentMap.get(id)).filter(Boolean).join(", ") || "—"}</span></td><td><Badge tone="yellow" className="capitalize">{invitation.status}</Badge></td><td className="text-[12.5px] text-[var(--ink-secondary)]">{formatDate(invitation.createdAt)}</td>{canInvite && <td><div className="flex items-center justify-end gap-1"><button type="button" className="task-icon-btn" aria-label={`Cancel invitation to ${invitation.email}`} title="Cancel invitation" onClick={() => { if (!window.confirm(`Cancel the invitation to ${invitation.email}? The invite link will stop working.`)) return; void onCancelInvitation(invitation); }}><MailX className="h-3.5 w-3.5" /></button></div></td>}</tr>)}
        </tbody></table></div>
      )}

      <EditMemberNameDialog
        open={Boolean(editingUser)}
        onOpenChange={(open) => !open && setEditingUser(undefined)}
        user={editingUser}
        onSave={onUpdateName}
      />
    </div>
  );
}

/* ============================================================== */
/*  Roles tab                                                      */
/* ============================================================== */

type RoleDraft = { name: string; capabilities: Set<Capability> };

function RoleCapabilityPicker({
  draft,
  onChange,
  disabled = false,
}: {
  draft: RoleDraft;
  onChange: (next: RoleDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-5">
      {capabilityGroups.map((group) => (
        <section key={group.title}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">{group.title}</div>
          <div className="grid gap-px lg:grid-cols-2">
            {group.capabilities.map((capability) => {
              const checked = draft.capabilities.has(capability);
              const toggle = () => {
                const next = new Set(draft.capabilities);
                if (next.has(capability)) next.delete(capability);
                else next.add(capability);
                onChange({ ...draft, capabilities: next });
              };
              return (
                <div key={capability} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hover)]">
                  <Checkbox checked={checked} disabled={disabled} aria-label={capabilityLabels[capability]} onCheckedChange={toggle} />
                  <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60" disabled={disabled} onClick={toggle}>
                    <span className="block text-[13px] text-[var(--ink)]">{capabilityLabels[capability]}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function RoleDialog({
  open,
  onOpenChange,
  role,
  existingNames,
  onSave,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: RoleRow;
  existingNames: string[];
  onSave: (draft: { name: string; capabilities: string[] }) => Promise<void>;
  canEdit: boolean;
}) {
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<Set<Capability>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existingNameSet = useMemo(() => new Set(existingNames.map((value) => value.trim().toLowerCase())), [existingNames]);

  useEffect(() => {
    if (open) {
      setName(role?.name ?? "");
      setCapabilities(new Set(role?.capabilities ?? []));
      setError(null);
    }
  }, [open, role]);

  async function submit() {
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Role name is required.");
      return;
    }
    if (!role && existingNameSet.has(trimmed.toLowerCase())) {
      setError("A role with this name already exists.");
      return;
    }
    if (role && trimmed.toLowerCase() !== role.name.trim().toLowerCase() && existingNameSet.has(trimmed.toLowerCase())) {
      setError("A role with this name already exists.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, capabilities: Array.from(capabilities) });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save role.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(720px,94dvh)] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
                {role ? "Edit role" : "New role"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                {role ? `Rename ${role.name} or change what its members can do.` : "Name the role and choose what its members can do."}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Role name" autoFocus disabled={!canEdit} />
              </label>
              <div className="mt-5">
                <RoleCapabilityPicker
                  draft={{ name, capabilities }}
                  onChange={(next) => setCapabilities(next.capabilities)}
                  disabled={!canEdit}
                />
              </div>
              {error && (
                <p className="alert-error mt-4 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button">Cancel</Button>
              </Dialog.Close>
              {canEdit && (
                <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
                  {saving ? "Saving..." : role ? "Save changes" : "Create role"}
                </Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RolesTab({
  data,
  canManageRoles,
  onSaveRole,
  onDuplicateRole,
  onDeleteRole,
}: {
  data: Overview;
  canManageRoles: boolean;
  onSaveRole: (roleId: Id<"roles"> | undefined, draft: { name: string; capabilities: string[] }) => Promise<void>;
  onDuplicateRole: (roleId: Id<"roles">) => Promise<void>;
  onDeleteRole: (roleId: Id<"roles">) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRow | undefined>();
  const [actionError, setActionError] = useState<string | null>(null);
  const normalized = query.trim().toLowerCase();
  const roles = useMemo(() => data.roles.filter((role) => !normalized || role.name.toLowerCase().includes(normalized)), [data.roles, normalized]);

  function openCreate() {
    setEditingRole(undefined);
    setDialogOpen(true);
  }
  function openEdit(role: RoleRow) {
    setEditingRole(role);
    setDialogOpen(true);
  }

  return (
    <div className="company-tab-body company-permissions-body">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-1 items-center justify-end gap-2">
          <div className="task-search-control" data-open={searchOpen || query.trim() !== ""}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="task-search-input border-none focus:border-none bg-transparent"
              placeholder="Search roles"
              aria-label="Search roles by name"
              tabIndex={searchOpen || query.trim() !== "" ? 0 : -1}
            />
            <button
              type="button"
              className="task-search-button"
              aria-label={query ? "Clear search" : "Search roles"}
              onClick={() => {
                if (query) setQuery("");
                else setSearchOpen((open) => !open);
              }}
            >
              {query ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
          {canManageRoles && <Button variant="primary" size="sm" onClick={openCreate}><Plus className="h-4 w-4" />New role</Button>}
        </div>
      </div>

      {actionError && <p className="alert-error rounded-md px-3 py-2 text-[12.5px]" role="alert">{actionError}</p>}

      <div className="company-table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th className="min-w-[200px]"><ColumnHeading icon={ShieldCheck}>Role</ColumnHeading></th>
              <th className="w-28"><ColumnHeading icon={Users}>Members</ColumnHeading></th>
              <th className="min-w-[280px]"><ColumnHeading icon={Check}>Permissions</ColumnHeading></th>
              {canManageRoles && <th className="w-28"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 ? (
              <tr>
                <td colSpan={canManageRoles ? 4 : 3} className="!h-auto !border-0 !bg-transparent py-2">
                  <EmptyState
                    icon={ShieldCheck}
                    title={query ? "No matching roles" : "No roles yet"}
                    message={query ? "Try a different name." : "Create a role to assign a set of permissions to members."}
                    action={canManageRoles && !query ? <Button size="sm" variant="primary" onClick={openCreate}><Plus className="h-3.5 w-3.5" />New role</Button> : undefined}
                  />
                </td>
              </tr>
            ) : (
              roles.map((role) => {
                const labels = role.capabilities.map((capability) => capabilityLabels[capability] ?? capability);
                const preview = labels.slice(0, 3);
                const extra = labels.length - preview.length;
                return (
                  <tr key={role._id} className="group/row">
                    <td className="col-task max-w-[320px]">
                      <div className="task-title-cell">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] text-[var(--ink-faint)]"><ShieldCheck className="h-3.5 w-3.5" /></span>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[var(--ink)]">{role.name}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          data-interactive="true"
                          data-tooltip={canManageRoles ? "Edit role" : "View role"}
                          className="task-title-open"
                          onClick={(event) => { event.stopPropagation(); openEdit(role); }}
                          aria-label={`${canManageRoles ? "Edit" : "View"} role ${role.name}`}
                        >
                          <PanelRight className="h-3.5 w-3.5" />
                          <span>OPEN</span>
                        </button>
                      </div>
                    </td>
                    <td className="text-[12.5px] text-[var(--ink-secondary)] tabular-nums">{role.memberCount} member{role.memberCount === 1 ? "" : "s"}</td>
                    <td className="max-w-[320px]">
                      <div className="flex min-w-0 flex-col">
                        <span className="text-[12.5px] text-[var(--ink-secondary)] tabular-nums">
                          {role.capabilities.length} permission{role.capabilities.length === 1 ? "" : "s"}
                        </span>
                        <span className="truncate text-[11.5px] text-[var(--ink-faint)]">
                          {preview.join(", ")}
                          {extra > 0 && `, +${extra} more`}
                        </span>
                      </div>
                    </td>
                    {canManageRoles && (
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" className="task-icon-btn" onClick={() => openEdit(role)} aria-label={`Edit role ${role.name}`} title="Edit role">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="task-icon-btn"
                            aria-label={`Duplicate role ${role.name}`}
                            title="Duplicate role"
                            onClick={() => {
                              setActionError(null);
                              void onDuplicateRole(role._id).catch((err) => setActionError(err instanceof Error ? err.message : "Could not duplicate role."));
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="task-icon-btn"
                            aria-label={`Delete role ${role.name}`}
                            title="Delete role"
                            onClick={() => {
                              if (!window.confirm(role.memberCount > 0 ? `Delete ${role.name}? It is assigned to ${role.memberCount} member${role.memberCount === 1 ? "" : "s"}.` : `Delete ${role.name}?`)) return;
                              setActionError(null);
                              void onDeleteRole(role._id).catch((err) => setActionError(err instanceof Error ? err.message : "Could not delete role."));
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <RoleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        role={editingRole}
        existingNames={data.roles.map((role) => role.name)}
        onSave={(draft) => onSaveRole(editingRole?._id, draft)}
        canEdit={canManageRoles}
      />
    </div>
  );
}

/* ============================================================== */
/*  Invite dialog                                                  */
/* ============================================================== */

function InviteDialog({
  open,
  onOpenChange,
  data,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Overview;
  onInvite: (args: { email: string; role: string; branchId: Id<"branches"> | ""; departmentId: Id<"departments"> | "" }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Employee");
  const [branchId, setBranchId] = useState<Id<"branches"> | "">("");
  const [departmentId, setDepartmentId] = useState<Id<"departments"> | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole(data.roles.find((item) => item.name === "Employee")?.name ?? data.roles[0]?.name ?? "");
      setBranchId("");
      setDepartmentId("");
      setError(null);
    }
  }, [open, data.roles]);

  // Reset department when branch changes (departments are scoped to branches)
  useEffect(() => {
    if (!branchId) {
      setDepartmentId("");
      return;
    }
    setDepartmentId((current) => {
      if (!current) return "";
      const stillValid = data.departments.some((d) => d._id === current && d.branchId === branchId);
      return stillValid ? current : "";
    });
  }, [branchId, data.departments]);

  const filteredDepartments = useMemo(() => {
    if (!branchId) return data.departments;
    return data.departments.filter((department) => department.branchId === branchId);
  }, [data.departments, branchId]);

  async function submit() {
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!role) {
      setError("Select a role.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onInvite({ email: email.trim(), role, branchId, departmentId });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send invitation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(560px,94dvh)] w-[min(480px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex items-start justify-between border-b border-[var(--hairline)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Invite member</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">Set their starting role and team placement.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Email</span>
                  <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" type="email" autoFocus />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Role</span>
                    <SelectField value={role} onChange={setRole}>
                      {role === "" && <option value="" disabled>Select a role</option>}
                      {data.roles.map((item) => (
                        <option key={item._id} value={item.name}>
                          {item.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Branch</span>
                    <SelectField value={branchId} onChange={setBranchId}>
                      <option value="">None</option>
                      {data.branches.map((branch) => (
                        <option key={branch._id} value={branch._id}>
                          {branch.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-[var(--ink-muted)]">Department</span>
                    <SelectField value={departmentId} onChange={setDepartmentId} disabled={!branchId}>
                      <option value="">None</option>
                      {filteredDepartments.map((department) => (
                        <option key={department._id} value={department._id}>
                          {department.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                </div>
              </div>
              {error && (
                <p className="alert-error mt-4 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--surface)] px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Sending..." : "Send invite"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Member access dialog                                           */
/* ============================================================== */

type AccessDraft = {
  role: string;
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
  managedBranchIds: Id<"branches">[];
  managedDepartmentIds: Id<"departments">[];
  managedUserMembershipIds: Id<"companyMemberships">[];
};

function draftFromUser(user: UserRow): AccessDraft {
  return {
    role: user.membership.role,
    branchIds: user.branchIds,
    departmentIds: user.departmentIds,
    managedBranchIds: user.scope?.branchIds ?? [],
    managedDepartmentIds: user.scope?.departmentIds ?? [],
    managedUserMembershipIds: user.scope?.userMembershipIds ?? [],
  };
}

function PermissionProperty({ icon, label, children, muted = false, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; muted?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-[74px] flex-col items-start gap-1", className)}>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold leading-4 text-[var(--ink-muted)]">
        <span className="grid h-4 w-4 place-items-center text-[var(--ink-faint)] [&_svg]:shrink-0">{icon}</span>
        {label}
      </span>
      <div className={cn("sop-detail-prop-value flex min-h-[22px] w-full min-w-0 items-center text-[13px] leading-5 text-[var(--ink)]", muted && "text-[var(--ink-faint)]")}>{children}</div>
    </div>
  );
}

function PermissionMultiSelectPopover<T extends string>({
  ariaLabel,
  empty,
  header,
  options,
  selected,
  onChange,
  disabled = false,
  children,
}: {
  ariaLabel: string;
  empty: string;
  header: React.ReactNode;
  options: { id: T; label: string; helper?: string }[];
  selected: T[];
  onChange: (ids: T[]) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const selectedSet = new Set(selected);

  function measure() {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.max(bounds.width, 260);
    const left = Math.min(Math.max(12, bounds.left), Math.max(12, window.innerWidth - width - 12));
    const below = bounds.bottom + 6;
    const above = Math.max(12, bounds.top - 326);
    const top = below + 326 > window.innerHeight && bounds.top > 326 ? above : Math.min(below, Math.max(12, window.innerHeight - 120));
    setRect({ top, left, width });
  }

  useEffect(() => {
    if (!open) return;
    measure();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  return (
    <span className="inline-flex w-full min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className="prop-inline-text w-full justify-start disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        data-interactive="true"
        onClick={() => { if (!open) measure(); setOpen(!open); }}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {children}
      </button>
      {open && rect && (
        <>
          <button type="button" aria-label="Close menu" className="task-cell-popover-backdrop" onClick={(event) => { event.stopPropagation(); setOpen(false); }} />
          <div className="task-cell-popover task-cell-popover-scroll" style={{ top: rect.top, left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="task-cell-popover-header">{header}</div>
            <div className="task-cell-popover-body">
              {options.length === 0 ? (
                <div className="px-2.5 py-3 text-[13px] text-[var(--ink-muted)]">{empty}</div>
              ) : (
                options.map((option) => {
                  const toggle = () => onChange(selectedSet.has(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id]);
                  return (
                    <div key={option.id} className="task-cell-popover-item">
                      <Checkbox checked={selectedSet.has(option.id)} aria-label={option.label} onCheckedChange={toggle} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={toggle}>
                        <span className="block truncate">{option.label}</span>
                        {option.helper && <span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function MemberAccessDialog({
  open,
  onOpenChange,
  data,
  user,
  onChangeRole,
  onChangeAssignments,
  onChangeScope,
  canManageRoles,
  canManageUsers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Overview;
  user?: UserRow;
  onChangeRole: (user: UserRow, role: string) => Promise<void>;
  onChangeAssignments: (user: UserRow, branchIds: Id<"branches">[], departmentIds: Id<"departments">[]) => Promise<void>;
  onChangeScope: (user: UserRow, scope: Scope) => Promise<void>;
  canManageRoles: boolean;
  canManageUsers: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<AccessDraft>(() =>
    user
      ? draftFromUser(user)
      : { role: "Employee", branchIds: [], departmentIds: [], managedBranchIds: [], managedDepartmentIds: [], managedUserMembershipIds: [] },
  );
  const [error, setError] = useState<string | null>(null);
  const saveVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (open && user) {
      setDraft(draftFromUser(user));
      setError(null);
      setClosing(false);
    }
  }, [open, user]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  if (!user) return null;

  const branches = data.branches.map((branch) => ({ id: branch._id, label: branch.name }));
  const selectedBranchIds = new Set(draft.branchIds);
  const departments = data.departments
    .filter((department) => selectedBranchIds.has(department.branchId))
    .map((department) => ({
      id: department._id,
      label: department.name,
      helper: data.branches.find((branch) => branch._id === department.branchId)?.name,
    }));
  const people = data.users
    .filter((row) => row.membership._id !== user.membership._id)
    .map((row) => ({ id: row.membership._id, label: row.user.name || row.user.email, helper: row.membership.role }));
  const roleNames = new Set(data.roles.map((role) => role.name));
  roleNames.add(draft.role);
  const roleOptions = Array.from(roleNames).sort((a, b) => a.localeCompare(b)).map((name) => {
    const role = data.roles.find((item) => item.name === name);
    return { value: name, label: name, helper: role ? `${role.capabilities.length} permission${role.capabilities.length === 1 ? "" : "s"}` : "Role no longer exists" };
  });
  const managedBranchIds = new Set(draft.managedBranchIds);
  const managedDepartments = data.departments
    .filter((department) => managedBranchIds.has(department.branchId))
    .map((department) => ({
      id: department._id,
      label: department.name,
      helper: data.branches.find((branch) => branch._id === department.branchId)?.name,
    }));
  const branchNames = draft.branchIds
    .map((branchId) => data.branches.find((branch) => branch._id === branchId)?.name)
    .filter((name): name is string => Boolean(name));
  const departmentNames = draft.departmentIds
    .map((departmentId) => data.departments.find((department) => department._id === departmentId)?.name)
    .filter((name): name is string => Boolean(name));
  const branchText = branchNames.length === 0 ? "No branch" : branchNames.length === 1 ? branchNames[0] : `${branchNames.length} branches`;
  const departmentText = draft.branchIds.length === 0 ? "Select branch first" : departmentNames.length === 0 ? "No department" : departmentNames.length === 1 ? departmentNames[0] : `${departmentNames.length} departments`;

  function closeAccess() {
    if (closing) return;
    setClosing(true);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onOpenChange(false);
      setClosing(false);
    }, DETAIL_DRAWER_CLOSE_MS);
  }

  function queueSave(enabled: boolean, run: (currentUser: UserRow) => Promise<void>, message: string) {
    if (!enabled || !user) return;
    const version = ++saveVersionRef.current;
    setError(null);
    const target = user;
    const save = saveQueueRef.current.catch(() => undefined).then(() => run(target));
    saveQueueRef.current = save;
    void save.catch((err) => {
      if (version === saveVersionRef.current) setError(err instanceof Error ? err.message : message);
    });
  }

  function updateRole(role: string) {
    if (!user || role === draft.role) return;
    setDraft({ ...draft, role });
    queueSave(canManageRoles, (target) => onChangeRole(target, role), "Could not update role.");
  }

  function updateBranches(branchIds: Id<"branches">[]) {
    const branchSet = new Set(branchIds);
    const departmentIds = draft.departmentIds.filter((departmentId) => {
      const department = data.departments.find((item) => item._id === departmentId);
      return Boolean(department && branchSet.has(department.branchId));
    });
    setDraft({ ...draft, branchIds, departmentIds });
    queueSave(canManageUsers, (target) => onChangeAssignments(target, branchIds, departmentIds), "Could not update team placement.");
  }

  function updateDepartments(departmentIds: Id<"departments">[]) {
    setDraft({ ...draft, departmentIds });
    queueSave(canManageUsers, (target) => onChangeAssignments(target, draft.branchIds, departmentIds), "Could not update team placement.");
  }

  function saveManagedScope(managed: Partial<Pick<AccessDraft, "managedBranchIds" | "managedDepartmentIds" | "managedUserMembershipIds">>) {
    const next = { ...draft, ...managed };
    setDraft(next);
    queueSave(canManageRoles, (target) => onChangeScope(target, { branchIds: next.managedBranchIds, departmentIds: next.managedDepartmentIds, userMembershipIds: next.managedUserMembershipIds }), "Could not update managed scope.");
  }

  function updateManagedBranches(managedBranchIds: Id<"branches">[]) {
    const branchSet = new Set(managedBranchIds);
    saveManagedScope({
      managedBranchIds,
      managedDepartmentIds: draft.managedDepartmentIds.filter((departmentId) => {
        const department = data.departments.find((item) => item._id === departmentId);
        return Boolean(department && branchSet.has(department.branchId));
      }),
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (nextOpen) onOpenChange(true); else closeAccess(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-transparent" />
        <Dialog.Content
          asChild
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <motion.aside
            className="task-drawer !fixed"
            initial={reduceMotion ? { opacity: 0 } : { x: 32, opacity: 0 }}
            animate={closing ? (reduceMotion ? { opacity: 0 } : { x: 32, opacity: 0 }) : (reduceMotion ? { opacity: 1 } : { x: 0, opacity: 1 })}
            transition={reduceMotion ? { duration: 0.1 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="task-drawer-inner">
              <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 py-7 md:px-9 md:py-8">
                <div className="peek-bar -mt-7 -mx-6 px-2 md:-mt-8 md:-mx-9 md:px-3">
                  <button type="button" className="task-icon-btn" aria-label="Close access settings" onClick={closeAccess}>
                    <ChevronsRight className="h-5 w-5" />
                  </button>
                </div>

                <div className="pt-6">
                  <Dialog.Title className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">Access</Dialog.Title>
                  <Dialog.Description className="sr-only">Manage role, team placement, and managed scope for {user.user.name || user.user.email}</Dialog.Description>
                </div>

                <section className="task-section !mt-8">
                  <div className="prop-list">
                    <div className="prop-row">
                      <span className="prop-label"><UserCog className="h-3.5 w-3.5" />Role</span>
                      <div className="prop-value">
                        <PeopleCellMenu value={draft.role} options={roleOptions} onChange={updateRole} ariaLabel={`Change role for ${user.user.name || user.user.email}`} disabled={!canManageRoles} renderValue={(option) => <Badge tone={roleBadgeTone(option?.value ?? draft.role)}>{option?.label ?? draft.role}</Badge>} />
                      </div>
                    </div>
                    <div className="prop-row">
                      <span className="prop-label"><Building2 className="h-3.5 w-3.5" />Branch</span>
                      <div className="prop-value truncate">
                        <PermissionMultiSelectPopover ariaLabel="Change branches" empty="No branches" header={<span className="min-w-0 flex-1 truncate">Branches</span>} options={branches} selected={draft.branchIds} disabled={!canManageUsers} onChange={updateBranches}>
                          <span className="truncate">{branchText}</span>
                        </PermissionMultiSelectPopover>
                      </div>
                    </div>
                    <div className="prop-row">
                      <span className="prop-label"><Layers className="h-3.5 w-3.5" />Department</span>
                      <div className={cn("prop-value truncate", draft.departmentIds.length === 0 && "prop-value--muted")}>
                        <PermissionMultiSelectPopover ariaLabel="Change departments" empty="No departments in selected branches" header={<span className="min-w-0 flex-1 truncate">Departments</span>} options={departments} selected={draft.departmentIds} disabled={!canManageUsers || draft.branchIds.length === 0} onChange={updateDepartments}>
                          <span className="truncate">{departmentText}</span>
                        </PermissionMultiSelectPopover>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="task-section">
                  <h2 className="task-section-title">Managed scope</h2>
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                    <PermissionProperty icon={<Users className="h-3.5 w-3.5" />} label="People" className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change people under this user" empty="No other people" header={<span className="min-w-0 flex-1 truncate">People under this user</span>} options={people} selected={draft.managedUserMembershipIds} disabled={!canManageRoles} onChange={(managedUserMembershipIds) => saveManagedScope({ managedUserMembershipIds })}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedUserMembershipIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                    <PermissionProperty icon={<Building2 className="h-3.5 w-3.5" />} label="Branches" className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change branches under this user" empty="No branches" header={<span className="min-w-0 flex-1 truncate">Branches under this user</span>} options={branches} selected={draft.managedBranchIds} disabled={!canManageRoles} onChange={updateManagedBranches}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedBranchIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                    <PermissionProperty icon={<Layers className="h-3.5 w-3.5" />} label="Departments" muted={draft.managedDepartmentIds.length === 0} className="min-w-[120px]">
                      <PermissionMultiSelectPopover ariaLabel="Change departments under this user" empty="No departments in selected branches" header={<span className="min-w-0 flex-1 truncate">Departments under this user</span>} options={managedDepartments} selected={draft.managedDepartmentIds} disabled={!canManageRoles || draft.managedBranchIds.length === 0} onChange={(managedDepartmentIds) => saveManagedScope({ managedDepartmentIds })}>
                        <span className="block w-full rounded-md py-1 text-[20px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{draft.managedDepartmentIds.length}</span>
                      </PermissionMultiSelectPopover>
                    </PermissionProperty>
                  </div>
                </section>

                <section className="task-section">
                  <h2 className="task-section-title">Role permissions</h2>
                  <p className="text-[13px] text-[var(--ink-muted)]">
                    Permissions come from the <span className="font-medium text-[var(--ink)]">{draft.role}</span> role. Edit them on the Roles tab.
                  </p>
                </section>

                {error && (
                  <p className="alert-error mt-5 rounded-md px-3 py-2 text-[12.5px]" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </motion.aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============================================================== */
/*  Sidebar nav                                                    */
/* ============================================================== */

function CompanySidebar({ tab, setTab, tabs }: { tab: TabValue; setTab: (value: TabValue) => void; tabs: typeof TABS }) {
  return (
    <aside className="company-nav" aria-label="Company management sections">
      <nav className="company-nav-list" role="tablist" aria-label="Company settings">
        {tabs.map((item) => {
          const Icon = item.icon;
          const isActive = tab === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              onClick={() => setTab(item.value)}
              className="company-nav-item"
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/* ============================================================== */
/*  Skeleton                                                       */
/* ============================================================== */

function CompanySkeleton() {
  return (
    <div className="company-page animate-pulse">
      <div className="company-shell">
        <div className="company-sidebar-wrap">
          <div className="company-nav space-y-4">
            <div className="company-nav-list space-y-0.5 p-1">
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
              <div className="h-[30px] rounded-md bg-[var(--surface-hover)]" />
            </div>
          </div>
        </div>
        <div className="company-main">
          <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
          <div className="mt-6 h-40 rounded-xl bg-[var(--surface-muted)]" />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
            <div className="h-24 rounded-xl bg-[var(--surface-muted)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  Page                                                           */
/* ============================================================== */

export default function Company() {
  const { activeCompanyId, active } = useCompany();
  const data = useQuery(api.companyManagement.overview, activeCompanyId ? { companyId: activeCompanyId } : "skip") as Overview | undefined;
  const updateCompanyName = useMutation(api.companyManagement.updateCompanyName).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (current) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        company: current.company ? { ...current.company, name: args.name } : current.company,
      } as any);
    }
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => row.company._id === args.companyId ? { ...row, company: { ...row.company, name: args.name } } : row),
      });
    }
  });
  const updateCompanyTimeZone = useMutation(api.companyManagement.updateCompanyTimeZone).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (current) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        company: current.company ? { ...current.company, timeZone: args.timeZone, hasTimeZone: true } : current.company,
      } as any);
    }
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => row.company._id === args.companyId ? { ...row, company: { ...row.company, timeZone: args.timeZone } } : row),
      });
    }
  });
  const updatePreferredAdmin = useMutation(api.companyManagement.updatePreferredAdmin).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (current?.company) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        company: { ...current.company, preferredAdminMembershipId: args.membershipId },
      } as any);
    }
  });
  // Only members who can confirm tasks can be the preferred admin.
  const confirmers = useQuery(
    api.tasks.eligibleConfirmers,
    activeCompanyId && active?.capabilities.includes("company:manage_settings") ? { companyId: activeCompanyId } : "skip",
  );
  const preferredAdminOptions = useMemo(
    () => confirmers?.users.map((row) => ({ _id: row.membership._id, name: row.user.name || row.user.email })),
    [confirmers],
  );
  const workCalendar = useQuery(
    api.workCalendar.get,
    activeCompanyId && canAccessCompanyManagement(active?.capabilities) ? { companyId: activeCompanyId } : "skip"
  ) as WorkCalendarData | undefined;
  const setWorkingDays = useMutation(api.workCalendar.setWorkingDays).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.workCalendar.get, { companyId: args.companyId }) as WorkCalendarData | undefined;
    if (current) {
      localStore.setQuery(api.workCalendar.get, { companyId: args.companyId }, { ...current, workingDays: args.workingDays } as any);
    }
  });
  const addHoliday = useMutation(api.workCalendar.addHoliday).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.workCalendar.get, { companyId: args.companyId }) as WorkCalendarData | undefined;
    if (current) {
      // Repeating ranges keep their entered order; one-time ranges normalize.
      const swap = args.recursYearly !== true && args.startDate > args.endDate;
      const startDate = swap ? args.endDate : args.startDate;
      const endDate = swap ? args.startDate : args.endDate;
      localStore.setQuery(api.workCalendar.get, { companyId: args.companyId }, {
        ...current,
        holidays: [...current.holidays, { _id: `pending-${args.name}-${startDate}` as Id<"companyHolidays">, name: args.name.trim(), startDate, endDate, recursYearly: args.recursYearly === true }],
      } as any);
    }
  });
  const updateHoliday = useMutation(api.workCalendar.updateHoliday).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.workCalendar.get, { companyId: args.companyId }) as WorkCalendarData | undefined;
    if (current) {
      // Same normalization the backend applies to one-time ranges.
      const swap = args.recursYearly !== true && args.startDate > args.endDate;
      const startDate = swap ? args.endDate : args.startDate;
      const endDate = swap ? args.startDate : args.endDate;
      localStore.setQuery(api.workCalendar.get, { companyId: args.companyId }, {
        ...current,
        holidays: current.holidays.map((holiday) => holiday._id === args.holidayId ? { ...holiday, name: args.name.trim(), startDate, endDate, recursYearly: args.recursYearly === true } : holiday),
      } as any);
    }
  });
  const removeHoliday = useMutation(api.workCalendar.removeHoliday).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.workCalendar.get, { companyId: args.companyId }) as WorkCalendarData | undefined;
    if (current) {
      localStore.setQuery(api.workCalendar.get, { companyId: args.companyId }, {
        ...current,
        holidays: current.holidays.filter((holiday) => holiday._id !== args.holidayId),
      } as any);
    }
  });
  const createBranch = useMutation(api.companyManagement.createBranch);
  const createDepartment = useMutation(api.companyManagement.createDepartment);
  const deleteBranch = useMutation(api.companyManagement.deleteBranch);
  const deleteDepartment = useMutation(api.companyManagement.deleteDepartment);
  const reorderBranches = useMutation(api.companyManagement.reorderBranches);
  const moveDepartment = useMutation(api.companyManagement.moveDepartment);
  const invite = useAction(api.companyManagement.inviteUser);
  const cancelInvitation = useMutation(api.companyManagement.cancelInvitation).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      invitations: current.invitations.filter((invitation) => invitation._id !== args.invitationId),
    } as any);
  });
  const ensureRoles = useMutation(api.roles.ensureDefaults);
  const assignRole = useMutation(api.roles.assign).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    const assigned = new Set(args.membershipIds);
    const memberCount = new Map<string, number>();
    for (const row of current.users) {
      const name = assigned.has(row.membership._id) ? args.role : row.membership.role;
      memberCount.set(name, (memberCount.get(name) ?? 0) + 1);
    }
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => assigned.has(row.membership._id) ? { ...row, membership: { ...row.membership, role: args.role } } : row),
      roles: current.roles.map((role) => ({ ...role, memberCount: memberCount.get(role.name) ?? 0 })),
    } as any);
  });
  const createRole = useMutation(api.roles.create);
  const updateRole = useMutation(api.roles.update);
  const duplicateRole = useMutation(api.roles.duplicate);
  const removeRole = useMutation(api.roles.remove);
  const setManagerScope = useMutation(api.companyManagement.setManagerScope).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.managerMembershipId ? { ...row, scope: { branchIds: args.branchIds, departmentIds: args.departmentIds, userMembershipIds: args.userMembershipIds } } : row),
    } as any);
  });
  const setAssignments = useMutation(api.companyManagement.setAssignments).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? { ...row, branchIds: args.branchIds, departmentIds: args.departmentIds } : row),
    } as any);
  });
  const setUserActive = useMutation(api.companyManagement.setUserActive).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => row.membership._id === args.membershipId ? { ...row, membership: { ...row.membership, active: args.active } } : row),
    } as any);
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => row.membership._id === args.membershipId ? { ...row, membership: { ...row.membership, active: args.active }, capabilities: args.active ? row.capabilities : [] } : row),
      });
    }
  });
  const removeUsers = useMutation(api.companyManagement.removeUsers).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    if (!current) return;
    const removing = new Set(args.membershipIds);
    localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
      ...current,
      users: current.users.map((row) => removing.has(row.membership._id) ? { ...row, membership: { ...row.membership, active: false }, branchIds: [], departmentIds: [], scope: { branchIds: [], departmentIds: [], userMembershipIds: [] } } : row),
    } as any);
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access?.status === "ready") {
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((row: any) => removing.has(row.membership._id) ? { ...row, membership: { ...row.membership, active: false }, capabilities: [] } : row),
      });
    }
  });
  const updateMemberName = useMutation(api.companyManagement.updateMemberName).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.companyManagement.overview, { companyId: args.companyId }) as Overview | undefined;
    const cleanSecondName = args.secondName?.trim() ?? "";
    const firstName = args.firstName.trim();
    const fullName = [firstName, cleanSecondName].filter(Boolean).join(" ");
    if (current) {
      localStore.setQuery(api.companyManagement.overview, { companyId: args.companyId }, {
        ...current,
        users: current.users.map((row) => (row.user._id === args.userId ? {
          ...row,
          user: {
            ...row.user,
            name: fullName || row.user.email,
            firstName,
            secondName: cleanSecondName,
          },
        } : row)),
      } as any);
    }
    const access = localStore.getQuery(api.companies.accessStatus, {}) as any;
    if (access && access.status === "ready") {
      const targetUser = current?.users.find((row) => row.user._id === args.userId);
      const targetMembershipId = targetUser?.membership._id;
      localStore.setQuery(api.companies.accessStatus, {}, {
        ...access,
        companies: access.companies.map((c: any) => {
          if (c.company._id === args.companyId && (!targetMembershipId || c.membership._id === targetMembershipId)) {
            return {
              ...c,
              membership: { ...c.membership, firstName, secondName: cleanSecondName },
              displayName: fullName || c.displayName,
            };
          }
          return c;
        }),
      });
    }
  });
  const [tab, setTab] = useState<TabValue>("general");
  const [companyName, setCompanyName] = useState("");
  const [companyTimeZone, setCompanyTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [savingName, setSavingName] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [accessMembershipId, setAccessMembershipId] = useState<Id<"companyMemberships"> | undefined>();
  const [error, setError] = useState<string | null>(null);
  const autoTimeZoneAttempts = useRef<Set<string>>(new Set());

  // Each draft follows only its own stored field (and the company), so saving
  // another setting such as the preferred admin keeps an unsaved draft.
  const overviewLoaded = data !== undefined;
  const loadedCompanyId = data?.company?._id;
  const storedCompanyName = data?.company?.name ?? active?.company.name ?? "";
  const storedTimeZone = data?.company?.timeZone ?? active?.company.timeZone ?? DEFAULT_TIME_ZONE;
  useEffect(() => {
    if (overviewLoaded) setCompanyName(storedCompanyName);
  }, [overviewLoaded, loadedCompanyId, storedCompanyName]);
  useEffect(() => {
    if (overviewLoaded) setCompanyTimeZone(storedTimeZone);
  }, [overviewLoaded, loadedCompanyId, storedTimeZone]);

  const rolesMissing = Boolean(data && data.roles.length === 0);
  const canSeedRoles = Boolean(active?.capabilities.includes("company:manage_roles"));
  useEffect(() => {
    if (!activeCompanyId || !rolesMissing || !canSeedRoles) return;
    void ensureRoles({ companyId: activeCompanyId }).catch(() => undefined);
  }, [activeCompanyId, rolesMissing, canSeedRoles, ensureRoles]);

  const accessUser = useMemo(() => data?.users.find((user) => user.membership._id === accessMembershipId), [data?.users, accessMembershipId]);
  const visibleTabs = useMemo(() => TABS.filter((item) => canViewCompanyTab(item.value, active?.capabilities)), [active?.capabilities]);

  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((item) => item.value === tab)) setTab(visibleTabs[0].value);
  }, [tab, visibleTabs]);

  useEffect(() => {
    if (!activeCompanyId || !data?.company || data.company.hasTimeZone || !active?.capabilities.includes("company:manage_settings")) return;
    const detected = browserTimeZone();
    const attemptKey = `${activeCompanyId}:${detected}`;
    if (autoTimeZoneAttempts.current.has(attemptKey)) return;
    autoTimeZoneAttempts.current.add(attemptKey);
    setCompanyTimeZone(detected);
    void updateCompanyTimeZone({ companyId: activeCompanyId, timeZone: detected }).catch((err) => {
      console.error("Could not auto-detect company time zone.", err);
      setError(err instanceof Error ? err.message : "Could not auto-detect company time zone.");
    });
  }, [active?.capabilities, activeCompanyId, data?.company, updateCompanyTimeZone]);

  if (!data) return <CompanySkeleton />;
  if (!canAccessCompanyManagement(active?.capabilities) || visibleTabs.length === 0) return <EmptyState icon={Building2} title="No company management access" message="Ask an admin to grant access to a company management section." />;

  const currentCompany = data.company ?? active?.company;
  const nameDirty = companyName.trim() !== (currentCompany?.name ?? "") && companyName.trim() !== "";
  const canManageSettings = active?.capabilities.includes("company:manage_settings") ?? false;
  const canManageCalendar = active?.capabilities.includes("company:manage_calendar") ?? false;
  const canManageBranches = active?.capabilities.includes("company:manage_branches") ?? false;
  const canManageDepartments = active?.capabilities.includes("company:manage_departments") ?? false;
  const canManageUsers = active?.capabilities.includes("company:manage_users") ?? false;
  const canManageRoles = active?.capabilities.includes("company:manage_roles") ?? false;
  const canInvite = active?.capabilities.includes("company:invite_users") ?? false;
  const activeTab = visibleTabs.some((item) => item.value === tab) ? tab : visibleTabs[0].value;

  async function run(action: () => Promise<unknown>, message = "Something went wrong.") {
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : message);
      return false;
    }
  }

  async function saveCompanyName() {
    if (!activeCompanyId || !nameDirty || savingName) return;
    setSavingName(true);
    try {
      await updateCompanyName({ companyId: activeCompanyId, name: companyName.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the company name.");
    } finally {
      setSavingName(false);
    }
  }

  async function saveCompanyTimeZone(timeZone: string) {
    if (!activeCompanyId || timeZone === currentCompany?.timeZone || savingTimeZone) return;
    setSavingTimeZone(true);
    try {
      await updateCompanyTimeZone({ companyId: activeCompanyId, timeZone });
    } catch (err) {
      setCompanyTimeZone(currentCompany?.timeZone ?? DEFAULT_TIME_ZONE);
      setError(err instanceof Error ? err.message : "Could not update the time zone.");
    } finally {
      setSavingTimeZone(false);
    }
  }

  async function inviteMember(args: { email: string; role: string; branchId: Id<"branches"> | ""; departmentId: Id<"departments"> | "" }) {
    if (!activeCompanyId) return;
    await invite({
      companyId: activeCompanyId,
      email: args.email,
      role: args.role,
      branchIds: args.branchId ? [args.branchId] : [],
      departmentIds: args.departmentId ? [args.departmentId] : [],
      managedBranchIds: [],
      managedDepartmentIds: [],
      managedUserMembershipIds: [],
    });
  }

  async function changeUserRole(user: UserRow, role: string) {
    if (!activeCompanyId) return;
    await assignRole({ companyId: activeCompanyId, membershipIds: [user.membership._id], role });
  }

  async function changeUsersRole(membershipIds: Id<"companyMemberships">[], role: string) {
    if (!activeCompanyId || membershipIds.length === 0) return;
    await assignRole({ companyId: activeCompanyId, membershipIds, role });
  }

  async function saveRole(roleId: Id<"roles"> | undefined, draft: { name: string; capabilities: string[] }) {
    if (!activeCompanyId) return;
    if (roleId) await updateRole({ companyId: activeCompanyId, roleId, name: draft.name, capabilities: draft.capabilities });
    else await createRole({ companyId: activeCompanyId, name: draft.name, capabilities: draft.capabilities });
  }

  async function duplicateExistingRole(roleId: Id<"roles">) {
    if (!activeCompanyId) return;
    await duplicateRole({ companyId: activeCompanyId, roleId });
  }

  async function deleteExistingRole(roleId: Id<"roles">) {
    if (!activeCompanyId) return;
    await removeRole({ companyId: activeCompanyId, roleId });
  }

  async function changeUserScope(user: UserRow, scope: Scope) {
    if (!activeCompanyId) return;
    await setManagerScope({ companyId: activeCompanyId, managerMembershipId: user.membership._id, branchIds: scope.branchIds, departmentIds: scope.departmentIds, userMembershipIds: scope.userMembershipIds });
  }

  async function changeUserBranch(user: UserRow, branchId: Id<"branches"> | "") {
    if (!activeCompanyId || !data) return;
    const departmentIds = user.departmentIds.filter((departmentId) => {
      const department = data.departments.find((item) => item._id === departmentId);
      return Boolean(branchId && department?.branchId === branchId);
    });
    await setAssignments({ companyId: activeCompanyId, membershipId: user.membership._id, branchIds: branchId ? [branchId] : [], departmentIds });
  }

  async function changeUserDepartment(user: UserRow, departmentId: Id<"departments"> | "") {
    if (!activeCompanyId) return;
    const branchId = user.branchIds[0];
    if (!branchId) return;
    await setAssignments({ companyId: activeCompanyId, membershipId: user.membership._id, branchIds: [branchId], departmentIds: departmentId ? [departmentId] : [] });
  }

  async function changeUserName(user: UserRow, firstName: string, secondName?: string) {
    if (!activeCompanyId) return;
    await updateMemberName({
      companyId: activeCompanyId,
      userId: user.user._id,
      firstName,
      secondName,
    });
  }

  async function changeUserStatus(user: UserRow, active: boolean) {
    if (!activeCompanyId) return;
    await setUserActive({ companyId: activeCompanyId, membershipId: user.membership._id, active });
  }

  async function removeSelectedUsers(membershipIds: Id<"companyMemberships">[]) {
    if (!activeCompanyId || membershipIds.length === 0) return;
    await removeUsers({ companyId: activeCompanyId, membershipIds });
  }

  return (
    <div className="company-page">
      {error && (
        <div className="alert-error company-alert" role="alert">
          <span>{error}</span>
          <button type="button" className="task-icon-btn h-6 w-6" onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {data.isTruncated && (
        <div className="company-alert flex items-start gap-2 border-amber-300/70 bg-amber-50 text-amber-950" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This view is incomplete because the workspace exceeds its current management limit. Do not make access or staffing decisions from omitted records.</span>
        </div>
      )}

      <div className="company-shell">
        <div className="company-sidebar-wrap">
          <CompanySidebar tab={activeTab} setTab={setTab} tabs={visibleTabs} />
        </div>
        <main className="company-main">
          <CompanyContentHeader tab={activeTab} />

          <div className="company-main-body">
            {activeTab === "general" && (
              <GeneralTab
                data={data}
                companyName={companyName}
                setCompanyName={setCompanyName}
                timeZone={companyTimeZone}
                setTimeZone={setCompanyTimeZone}
                savingTimeZone={savingTimeZone}
                nameDirty={nameDirty}
                savingName={savingName}
                canManageSettings={canManageSettings}
                onSaveName={saveCompanyName}
                onSaveTimeZone={saveCompanyTimeZone}
                preferredAdminOptions={preferredAdminOptions}
                onSavePreferredAdmin={(membershipId) => { if (activeCompanyId) void run(async () => updatePreferredAdmin({ companyId: activeCompanyId, membershipId }), "Could not update the preferred admin."); }}
                calendar={workCalendar}
                canManageCalendar={canManageCalendar}
                onSetWorkingDays={(workingDays) => { if (activeCompanyId) void run(async () => setWorkingDays({ companyId: activeCompanyId, workingDays }), "Could not update working days."); }}
                onAddHoliday={async (name, startDate, endDate, recursYearly) => activeCompanyId ? await run(async () => addHoliday({ companyId: activeCompanyId, name, startDate, endDate, recursYearly }), "Could not add holiday.") : false}
                onUpdateHoliday={async (holidayId, name, startDate, endDate, recursYearly) => activeCompanyId ? await run(async () => updateHoliday({ companyId: activeCompanyId, holidayId, name, startDate, endDate, recursYearly }), "Could not update holiday.") : false}
                onRemoveHoliday={(holidayId) => { if (activeCompanyId) void run(async () => removeHoliday({ companyId: activeCompanyId, holidayId }), "Could not remove holiday."); }}
              />
            )}
            {activeTab === "structure" && (
              <StructureTab
                data={data}
                canManageBranches={canManageBranches}
                canManageDepartments={canManageDepartments}
                onCreateBranch={(name) => activeCompanyId && run(async () => createBranch({ companyId: activeCompanyId, name }), "Could not create branch.")}
                onCreateDepartment={(branchId, name) => activeCompanyId && run(async () => createDepartment({ companyId: activeCompanyId, branchId, name }), "Could not create department.")}
                onDeleteBranch={async (branchId) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await deleteBranch({ companyId: activeCompanyId, branchId }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not delete branch."); throw err; }
                }}
                onDeleteDepartment={async (departmentId) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await deleteDepartment({ companyId: activeCompanyId, departmentId }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not delete department."); throw err; }
                }}
                onReorderBranches={async (orderedBranchIds) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await reorderBranches({ companyId: activeCompanyId, orderedBranchIds }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not reorder branches."); throw err; }
                }}
                onMoveDepartment={async (departmentId, toBranchId, orderedDepartmentIds) => {
                  if (!activeCompanyId) return;
                  setError(null);
                  try { await moveDepartment({ companyId: activeCompanyId, departmentId, toBranchId, orderedDepartmentIds }); }
                  catch (err) { setError(err instanceof Error ? err.message : "Could not move department."); throw err; }
                }}
              />
            )}
            {activeTab === "people" && (
              <PeopleTab
                data={data}
                onInvite={() => setInviteOpen(true)}
                onUpdateName={async (user, firstName, secondName) => { await run(() => changeUserName(user, firstName, secondName), "Could not update user name."); }}
                onRoleChange={async (user, role) => { await run(() => changeUserRole(user, role), "Could not update role."); }}
                onBulkRoleChange={async (membershipIds, role) => { await run(() => changeUsersRole(membershipIds, role), "Could not assign role."); }}
                onManageAccess={(user) => setAccessMembershipId(user.membership._id)}
                onBranchChange={async (user, branchId) => { await run(() => changeUserBranch(user, branchId), "Could not update branch."); }}
                onDepartmentChange={async (user, departmentId) => { await run(() => changeUserDepartment(user, departmentId), "Could not update department."); }}
                onStatusChange={async (user, active) => { await run(() => changeUserStatus(user, active), "Could not update status."); }}
                onRemoveUsers={removeSelectedUsers}
                onCancelInvitation={async (invitation) => { if (!activeCompanyId) return; await run(() => cancelInvitation({ companyId: activeCompanyId, invitationId: invitation._id }), "Could not cancel invitation."); }}
                canManageUsers={canManageUsers}
                canManageRoles={canManageRoles}
                canInvite={canInvite}
              />
            )}
            {activeTab === "roles" && (
              <RolesTab
                data={data}
                canManageRoles={canManageRoles}
                onSaveRole={(roleId, draft) => saveRole(roleId, draft)}
                onDuplicateRole={duplicateExistingRole}
                onDeleteRole={deleteExistingRole}
              />
            )}
          </div>
        </main>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} data={data} onInvite={inviteMember} />
      <MemberAccessDialog
        open={Boolean(accessMembershipId)}
        onOpenChange={(open) => !open && setAccessMembershipId(undefined)}
        data={data}
        user={accessUser}
        onChangeRole={(user, role) => changeUserRole(user, role)}
        onChangeAssignments={async (user, branchIds, departmentIds) => { await setAssignments({ companyId: activeCompanyId!, membershipId: user.membership._id, branchIds, departmentIds }); }}
        onChangeScope={changeUserScope}
        canManageRoles={canManageRoles}
        canManageUsers={canManageUsers}
      />
    </div>
  );
}

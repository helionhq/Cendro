"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  CircleAlert,
  CirclePause,
  CirclePlay,
  Clock,
  Download,
  Flag,
  Hash,
  ImagePlus,
  Inbox,
  ListOrdered,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { DragDropProvider } from "@dnd-kit/react";
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useCompany } from "./company-context";
import { requestDetailDrawerClose } from "./detail-drawer-motion";
import { PageHeader } from "./page-header";
import { TaskCellPopover } from "./task-cell-popover";
import { TaskImportExportMenu } from "./task-import-dialog";
import { TaskRail, useTaskRailAutoScroll } from "./task-rail-scroll";
import { ListDragOverlay, ListDragRailRow, ListSortableRow, useListDrag, type ListDrag } from "./list-dnd";
import { ListSortHeader } from "./list-sort-header";
import { ListPreferenceController, type ListPreference, type ListPreferenceControllerOptions } from "@/lib/list-preference-controller";
import { mergeFilteredListOrder, restoreListCustomOrder, sameListOrder } from "@/lib/list-order";
import { insertListItem } from "@/lib/list-drag";
import { useIsCoarsePointer } from "@/lib/use-is-coarse-pointer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RequiredIndicator } from "@/components/ui/required-indicator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  restoreTaskListCustomOrder,
  sortTaskListRows,
  type TaskListOrderingRow,
} from "@/lib/task-list-order";
import {
  defaultTaskListSortDirection,
  defaultTaskListSortField,
  initialTaskListSortDirection,
  type TaskListSort,
  type TaskListSortDirection,
  type TaskListSortField,
  type TaskListTaskType,
} from "@/lib/task-list-sort";
import { ASSIGNEE_SEARCH_MAX_LENGTH } from "@/lib/assignee-search";
import { startInteraction } from "@/lib/perf";
import { getDetailPreview, seedDetailPreview } from "@/lib/detail-preview";
import { prependToListFirstPage, removeFromListPages, updateInDetailQueries, updateInListPages } from "@/lib/convex-optimistic";
import { cn, formatDate, initials } from "@/lib/utils";

// The workbook stack (xlsx readers/writers) is heavy — load it on demand.
const loadWorkbook = () => import("@/lib/task-import/workbook");

type Kind = "jd" | "one";
type Priority = "low" | "medium" | "high" | "critical";
type Frequency = "daily" | "every_other_day" | "weekly" | "semimonthly" | "monthly" | "quarterly" | "semiannually" | "annually";
type ManualStatus = "due" | "in_progress" | "completed";
type StatusFilter = ManualStatus | "overdue";
type TaskView = "all" | "my" | "custom";
type PriorityFilter = "all" | Priority;
type FrequencyFilter = Frequency | "all";

type TaskFormValues = {
  title: string;
  description: string;
  notes: string;
  assigneeMembershipIds: string[];
  recurrence: Frequency;
  priority: Priority;
  dueDate: string;
  quantity: string;
  time: string;
  evidenceRequired: boolean;
  files: File[];
};

type EvidenceFileUpload = { storageId: Id<"_storage">; fileName: string; claimId: Id<"taskUploadClaims"> };
type EvidenceSubmission = { text?: string; files: EvidenceFileUpload[] };

type TaskRowAssignee = {
  membership: { _id: string; role: string };
  user: {
    name: string | null;
    firstName?: string | null;
    secondName?: string | null;
    fullName?: string | null;
    email: string;
    imageUrl?: string | null;
  };
};

type AssignableUsersResult = {
  users: TaskRowAssignee[];
  isTruncated: boolean;
};

type TaskRow = TaskListOrderingRow & {
  reference: string;
  title: string;
  description?: string | null;
  notes?: string | null;
  time?: string | null;
  quantity?: number | null;
  pausedAt?: number;
  canPause?: boolean;
  canResume?: boolean;
  recurrence?: Frequency;
  priority?: Priority;
  dueDate?: number | null;
  createdAt: number;
  assigneeMembershipIds: string[];
  assignees: TaskRowAssignee[];
  state?: {
    status?: string;
    rawStatus?: ManualStatus | "overdue" | "paused";
  } | string;
  canUpdate?: boolean;
  canDelete?: boolean;
  customOrderKey?: string;
};

const frequencies: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "every_other_day", label: "Alternate days" },
  { value: "weekly", label: "Weekly" },
  { value: "semimonthly", label: "Semi-monthly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semiannually", label: "Bi-yearly" },
  { value: "annually", label: "Yearly" },
];
const priorities: Priority[] = ["low", "medium", "high", "critical"];
const TASK_PAGE_SIZE = 200;
const TASK_LIST_ORDER_LIMIT = 2_000;
const MAX_EVIDENCE_FILES = 5;
const MAX_EVIDENCE_TEXT_LENGTH = 5_000;
const manualStatuses: { value: ManualStatus; label: string }[] = [
  { value: "due", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
];

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "due", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "overdue", label: "Overdue" },
];
const allStatusFilters = statusOptions.map((option) => option.value);

const taskListPreferenceMessages: ListPreferenceControllerOptions = {
  conflict: "Task order changed in another session. Please repeat the move.",
  saveFailed: "Could not save task order.",
};

const toneClasses: Record<string, string> = {
  blue: "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]",
  green: "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]",
  red: "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]",
  yellow: "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
  neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]",
};

function emptyForm(kind: Kind): TaskFormValues {
  return { title: "", description: "", notes: "", assigneeMembershipIds: [], recurrence: "daily", priority: "medium", dueDate: kind === "one" ? toDateField(Date.now() + 86_400_000) : "", quantity: "", time: "", evidenceRequired: false, files: [] };
}

function formFromTask(kind: Kind, task: any): TaskFormValues {
  return {
    title: task.title ?? "",
    description: task.description ?? "",
    notes: task.notes ?? "",
    assigneeMembershipIds: task.assigneeMembershipIds ?? [],
    recurrence: task.recurrence ?? "daily",
    priority: task.priority ?? "medium",
    dueDate: kind === "one" && task.dueDate ? toDateField(task.dueDate, dateHasExplicitTime(task.dueDate)) : "",
    quantity: task.quantity != null ? String(task.quantity) : "",
    time: task.time ?? "",
    evidenceRequired: task.evidenceRequired === true,
    files: [],
  };
}

function dateHasExplicitTime(ms?: number | null) {
  if (!ms) return false;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return false;
  return !(date.getHours() === 23 && date.getMinutes() === 59 && date.getSeconds() === 59);
}
function formatDateOnly(date: Date, month: "short" | "long" = "long") {
  return new Intl.DateTimeFormat("en-US", { month, day: "numeric", year: "numeric" }).format(date);
}
function formatTimeOnly(date: Date) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}
function dateFieldHasTime(value: string) {
  return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(value) || /\b\d{1,2}:\d{2}\b/.test(value);
}
function parseTimeParts(value: string) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (minutes < 0 || minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours < 0 || hours > 23) return null;
  return { hours, minutes };
}
function applyTimeText(date: Date, timeText?: string) {
  const parts = timeText ? parseTimeParts(timeText) : null;
  if (!parts) return false;
  date.setHours(parts.hours, parts.minutes, 0, 0);
  return true;
}
function toDateField(ms: number, includeTime = false) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return includeTime ? `${formatDateOnly(date)} ${formatTimeOnly(date)}` : formatDateOnly(date);
}
function dateFromField(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === "today" || lowered === "now") return new Date();
  if (lowered === "tomorrow") return new Date(Date.now() + 86_400_000);
  if (lowered === "yesterday") return new Date(Date.now() - 86_400_000);

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[\s,]+(.+))?$/.exec(trimmed);
  if (slashMatch) {
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const date = new Date(year, Number(slashMatch[2]) - 1, Number(slashMatch[1]));
    if (slashMatch[4]) applyTimeText(date, slashMatch[4]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fromDateInput(value: string) {
  const date = dateFromField(value);
  if (!date) return undefined;
  if (!dateFieldHasTime(value)) date.setHours(23, 59, 59, 0);
  return date.getTime();
}
function quantityFromInput(value: string) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
function frequencyLabel(value?: Frequency) { return frequencies.find((frequency) => frequency.value === value)?.label ?? "—"; }
function priorityLabel(value?: Priority) { return value ? value[0].toUpperCase() + value.slice(1) : "—"; }
function statusText(task: any) { return typeof task.state === "string" ? task.state : task.state?.status ?? "Pending"; }
function rawStatus(task: any): ManualStatus | "overdue" | "paused" { return task.state?.rawStatus ?? (statusText(task) === "Completed" ? "completed" : statusText(task) === "In Progress" ? "in_progress" : statusText(task) === "Overdue" ? "overdue" : statusText(task) === "Pending" ? "due" : "due"); }
function statusTone(status: string) { if (status === "Overdue") return "red"; if (status === "Completed") return "green"; if (status === "In Progress") return "blue"; return "neutral"; }
function statusDotClass(status: ManualStatus | "overdue" | "paused") { return status === "completed" ? "bg-[var(--badge-green-fg)]" : status === "in_progress" ? "bg-[var(--badge-blue-fg)]" : status === "overdue" ? "bg-[var(--badge-red-fg)]" : "bg-[var(--badge-neutral-fg)]"; }
function taskTypeFor(kind: Kind) { return kind === "jd" ? "jd" : "one_time"; }
function hasAnyCapability(active: { capabilities: string[] } | null | undefined, capabilities: string[]) { return capabilities.some((capability) => active?.capabilities.includes(capability)); }
function canCreateTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) { return active?.capabilities.includes(kind === "jd" ? "tasks:jd:create" : "tasks:one_time:create") ?? false; }
function canImportTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) { return active?.capabilities.includes(kind === "jd" ? "tasks:jd:import" : "tasks:one_time:import") ?? false; }
function canExportTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) { return active?.capabilities.includes(kind === "jd" ? "tasks:jd:export" : "tasks:one_time:export") ?? false; }
function canEditTasks(active: { capabilities: string[] } | null | undefined, kind: Kind) {
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  return hasAnyCapability(active, [`${prefix}:update:any`, `${prefix}:update:managed`, `${prefix}:update:self`]);
}
function canEditTaskRow(active: { capabilities: string[]; membership: { _id: string; role: string } } | null | undefined, kind: Kind, task: any) {
  if (task && typeof task.canUpdate === "boolean") return task.canUpdate;
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (active?.capabilities.includes(`${prefix}:update:any`)) return true;
  if (active?.capabilities.includes(`${prefix}:update:managed`)) return true;
  return Boolean(active?.capabilities.includes(`${prefix}:update:self`) && taskHasAssignee(task, active?.membership?._id));
}
function canDeleteTaskRow(active: { capabilities: string[]; membership: { _id: string; role: string } } | null | undefined, kind: Kind, task: any) {
  if (task && typeof task.canDelete === "boolean") return task.canDelete;
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (active?.capabilities.includes(`${prefix}:delete:any`)) return true;
  if (active?.capabilities.includes(`${prefix}:delete:managed`)) return true;
  return Boolean(active?.capabilities.includes(`${prefix}:delete:self`) && taskHasAssignee(task, active?.membership?._id));
}
function statusMatches(task: TaskRow, filters: StatusFilter[]) {
  return filters.some((filter) => rawStatus(task) === filter);
}
function taskHasAssignee(task: any, membershipId?: string) { return Boolean(membershipId && Array.isArray(task.assigneeMembershipIds) && task.assigneeMembershipIds.includes(membershipId)); }
function assigneeDisplayName(assignee: any) { return assignee?.user?.name || assignee?.user?.email || "Unknown user"; }
function manualStatusLabel(status?: ManualStatus | null) { return manualStatuses.find((option) => option.value === status)?.label ?? "status"; }
function activityActorName(item: any) { return item.actor?.user.name || item.actor?.user.email || "Someone"; }
function activityLogText(item: any) {
  const name = activityActorName(item);
  if (item.event === "created") return `${name} created this task`;
  if (item.event === "paused") return `${name} made this task inactive`;
  if (item.event === "resumed") return `${name} made this task active`;
  if (item.event === "status_changed") {
    if (item.toStatus === "completed") return `${name} marked this task complete`;
    if (item.toStatus === "in_progress") return `${name} moved this task to in progress`;
    if (item.toStatus === "due") return `${name} marked this task pending`;
    if (item.fromStatus && item.toStatus) return `${name} changed status from ${manualStatusLabel(item.fromStatus)} to ${manualStatusLabel(item.toStatus)}`;
  }
  return `${name} updated this task`;
}
function relativeTime(ms?: number) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < 0) return "just now";
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return formatDate(ms);
}
function humanSize(bytes?: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i <= 1 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
const priorityChipTones: Record<Priority, string> = {
  critical: "bg-[var(--priority-critical-bg)] text-[var(--priority-critical-fg)]",
  high: "bg-[var(--priority-high-bg)] text-[var(--priority-high-fg)]",
  medium: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
  low: "bg-[var(--priority-low-bg)] text-[var(--priority-low-fg)]",
};
function priorityChipClasses(priority: Priority) {
  return priorityChipTones[priority];
}
function dueLabel(task: any) {
  const ms = task.dueDate;
  if (!ms) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return dateHasExplicitTime(ms) ? `${formatDateOnly(date)} ${formatTimeOnly(date)}` : formatDateOnly(date);
}
function dueTone(task: any, now: number | null) {
  const ms = task.dueDate;
  if (!ms) return "muted";
  if (rawStatus(task) === "completed") return "muted";
  if (rawStatus(task) === "overdue") return "danger";
  const day = 86_400_000;
  if (now !== null && ms - now <= 2 * day) return "warn";
  return "ink";
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z" />
    </svg>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,86l59-4.76,22.76-55.08a16.36,16.36,0,0,1,30.27,0l22.75,55.08,59,4.76a16.46,16.46,0,0,1,9.37,28.86Z" />
    </svg>
  );
}

function StatusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M225.86,102.82c-3.77-3.94-7.67-8-9.14-11.57-1.36-3.27-1.44-8.69-1.52-13.94-.15-9.76-.31-20.82-8-28.51s-18.75-7.85-28.51-8c-5.25-.08-10.67-.16-13.94-1.52-3.56-1.47-7.63-5.37-11.57-9.14C146.28,23.51,138.44,16,128,16s-18.27,7.51-25.18,14.14c-3.94,3.77-8,7.67-11.57,9.14C88,40.64,82.56,40.72,77.31,40.8c-9.76.15-20.82.31-28.51,8S41,67.55,40.8,77.31c-.08,5.25-.16,10.67-1.52,13.94-1.47,3.56-5.37,7.63-9.14,11.57C23.51,109.72,16,117.56,16,128s7.51,18.27,14.14,25.18c3.77,3.94,7.67,8,9.14,11.57,1.36,3.27,1.44,8.69,1.52,13.94.15,9.76.31,20.82,8,28.51s18.75,7.85,28.51,8c5.25.08,10.67.16,13.94,1.52,3.56,1.47,7.63,5.37,11.57,9.14C109.72,232.49,117.56,240,128,240s18.27-7.51,25.18-14.14c3.94-3.77,8-7.67,11.57-9.14,3.27-1.36,8.69-1.44,13.94-1.52,9.76-.15,20.82-.31,28.51-8s7.85-18.75,8-28.51c.08-5.25.16-10.67,1.52-13.94,1.47-3.56,5.37-7.63,9.14-11.57C232.49,146.28,240,138.44,240,128S232.49,109.73,225.86,102.82Zm-11.55,39.29c-4.79,5-9.75,10.17-12.38,16.52-2.52,6.1-2.63,13.07-2.73,19.82-.1,7-.21,14.33-3.32,17.43s-10.39,3.22-17.43,3.32c-6.75.1-13.72.21-19.82,2.73-6.35,2.63-11.52,7.59-16.52,12.38S132,224,128,224s-9.15-4.92-14.11-9.69-10.17-9.75-16.52-12.38c-6.1-2.52-13.07-2.63-19.82-2.73-7-.1-14.33-.21-17.43-3.32s-3.22-10.39-3.32-17.43c-.1-6.75-.21-13.72-2.73-19.82-2.63-6.35-7.59-11.52-12.38-16.52S32,132,32,128s4.92-9.15,9.69-14.11,9.75-10.17,12.38-16.52c2.52-6.1,2.63-13.07,2.73-19.82.1-7,.21-14.33,3.32-17.43S70.51,56.9,77.55,56.8c6.75-.1,13.72-.21,19.82-2.73,6.35-2.63,11.52-7.59,16.52-12.38S124,32,128,32s9.15,4.92,14.11,9.69,10.17,9.75,16.52,12.38c6.1,2.52,13.07,2.63,19.82,2.73,7,.1,14.33.21,17.43,3.32s3.22,10.39,3.32,17.43c.1,6.75.21,13.72,2.73,19.82,2.63,6.35,7.59,11.52,12.38,16.52S224,124,224,128,219.08,137.15,214.31,142.11ZM173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34Z" />
    </svg>
  );
}

function TaskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M238.73,43.67A8,8,0,0,0,232,40H152a8,8,0,0,0-7.28,4.69L135.94,64H28a8,8,0,0,0-5.92,13.38L57.19,116,22.08,154.62A8,8,0,0,0,28,168h73.09a8,8,0,0,0,7.28-4.69L117.15,144h62.43l-34.86,76.69a8,8,0,1,0,14.56,6.62l80-176A8,8,0,0,0,238.73,43.67ZM95.94,152H46.08l27.84-30.62a8,8,0,0,0,0-10.76L46.08,80h82.59Zm90.91-24H124.42l32.73-72h62.43Z" />
    </svg>
  );
}

function FrequencyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z" />
    </svg>
  );
}

function QuantityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M230.91,172A8,8,0,0,1,228,182.91l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,36,169.09l92,53.65,92-53.65A8,8,0,0,1,230.91,172ZM220,121.09l-92,53.65L36,121.09A8,8,0,0,0,28,134.91l96,56a8,8,0,0,0,8.06,0l96-56A8,8,0,1,0,220,121.09ZM24,80a8,8,0,0,1,4-6.91l96-56a8,8,0,0,1,8.06,0l96,56a8,8,0,0,1,0,13.82l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,24,80Zm23.88,0L128,126.74,208.12,80,128,33.26Z" />
    </svg>
  );
}

function Avatar({ name, email, imageUrl, size = "sm" }: { name?: string | null; email?: string | null; imageUrl?: string | null; size?: "sm" | "md" | "lg" }) {
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : size === "lg" ? "h-9 w-9 text-xs" : "h-6 w-6 text-[10px]";
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,var(--surface-hover),var(--surface-pressed))] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]", dim)} title={name || email || undefined}>
      {initials(name, email)}
      {imageUrl && <span aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${imageUrl})` }} />}
    </span>
  );
}

function AvatarStack({ assignees, max = 3, showName = false }: { assignees: { user: { name: string | null; email: string; imageUrl?: string | null } }[]; max?: number; showName?: boolean }) {
  if (!assignees.length) return <span className="text-[12.5px] text-[var(--ink-faint)]">Unassigned</span>;
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="avatar-stack shrink-0">
        {shown.map((assignee, index) => <Avatar key={index} name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />)}
        {extra > 0 && <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[10px] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--canvas)]">+{extra}</span>}
      </span>
      {showName && <span className="min-w-0 truncate">{assigneeDisplayName(assignees[0])}</span>}
    </span>
  );
}

function taskStateLabel(status: ManualStatus | "overdue") {
  return status === "due" ? "Pending" : status === "in_progress" ? "In Progress" : status === "completed" ? "Completed" : "Overdue";
}

// Patch manual status only; the shared deadline projection owns overdue state,
// including optimistic updates. Device wall time must not hide or lock a task.
function optimisticTaskState(task: any, status: ManualStatus) {
  const state = typeof task.state === "object" && task.state ? task.state : {};
  return { ...state, status: taskStateLabel(status), rawStatus: status, isOverdue: false };
}

function StatusBadge({ kind, task, size = "sm", canUpdateOverride, cellTrigger = false }: { kind: Kind; task: any; size?: "sm" | "md"; canUpdateOverride?: boolean; cellTrigger?: boolean }) {
  const { activeCompanyId, active } = useCompany();
  // Patch the loaded list/detail queries so every view of this task — the row,
  // the open detail pane, and status filters — reflects the change immediately.
  const updateJdStatus = useMutation(api.tasks.updateJdStatus).withOptimisticUpdate((localStore, args) => {
    // Evidence completions wait for the server so a rejected upload is never
    // shown as completed first.
    if (args.evidence) return;
    const patch = (row: any) => ({ ...row, state: optimisticTaskState(row, args.status), ...(args.status === "completed" ? { completedAt: Date.now() } : {}) });
    updateInListPages(localStore, api.tasks.listJdRows, args.taskId, patch);
    updateInDetailQueries(localStore, api.tasks.getJd, args.taskId, patch);
  });
  const updateOneStatus = useMutation(api.tasks.updateOneTimeStatus).withOptimisticUpdate((localStore, args) => {
    if (args.evidence) return;
    const patch = (row: any) => ({ ...row, state: optimisticTaskState(row, args.status), ...(args.status === "completed" ? { completedAt: Date.now() } : {}) });
    updateInListPages(localStore, api.tasks.listOneTimeRows, args.taskId, patch);
    updateInDetailQueries(localStore, api.tasks.getOneTime, args.taskId, patch);
  });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const status = statusText(task);
  const raw = rawStatus(task);
  const deadlineClock = useContext(TaskDeadlineContext);
  const awaitingClock = kind === "one" && task.dueDate != null && !deadlineClock?.synchronized;
  const locked = status === "Overdue" || raw === "overdue";
  const isAssignee = taskHasAssignee(task, active?.membership?._id);
  // Pending rows carry a synthetic id — a status mutation against it would reject.
  const canUpdate = task.pausedAt === undefined && !isPendingTask(task) && (isAssignee || (canUpdateOverride ?? canEditTasks(active, kind)));
  const pad = size === "md" ? "h-7 px-2.5" : "h-[22px] px-2";

  async function change(nextStatus: ManualStatus) {
    if (!activeCompanyId || locked || pending || awaitingClock) return;
    // Evidence-required tasks enter completed only through the dialog, so the
    // row never shows a completed state the server did not accept.
    if (nextStatus === "completed" && task.evidenceRequired === true && raw !== "completed") {
      setFailed(false);
      setEvidenceOpen(true);
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      if (kind === "jd") await updateJdStatus({ companyId: activeCompanyId, taskId: task._id, status: nextStatus });
      else await updateOneStatus({ companyId: activeCompanyId, taskId: task._id, status: nextStatus });
    } catch {
      // The optimistic store reverts on failure; flag it so the retry affordance is clear.
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  async function completeWithEvidence(evidence: EvidenceSubmission) {
    if (!activeCompanyId) throw new Error("No active company.");
    setPending(true);
    setFailed(false);
    try {
      if (kind === "jd") await updateJdStatus({ companyId: activeCompanyId, taskId: task._id, status: "completed", evidence });
      else await updateOneStatus({ companyId: activeCompanyId, taskId: task._id, status: "completed", evidence });
    } catch (error) {
      setFailed(true);
      throw error;
    } finally {
      setPending(false);
    }
  }

  if (locked) return <span className={cn("task-pill", toneClasses[statusTone("Overdue")], pad)} aria-label="Overdue (locked)"><span className="task-pill-dot bg-[var(--badge-red-fg)]" />Overdue</span>;
  if (!canUpdate) return <span className={cn("task-pill", toneClasses[statusTone(status)], pad)}><span className={cn("task-pill-dot", statusDotClass(raw))} />{status}</span>;

  const pill = (
    <span className={cn("task-pill", toneClasses[statusTone(status)], pad, failed && "ring-1 ring-[var(--danger)]")} title={awaitingClock ? "Synchronizing task deadline…" : failed ? "Could not update status — try again." : undefined}>
      <span className={cn("task-pill-dot", statusDotClass(raw))} />
      {manualStatuses.find((option) => option.value === raw)?.label ?? status}
      {failed && <CircleAlert className="h-3 w-3 text-[var(--danger)]" />}
    </span>
  );

  const completionDialog = evidenceOpen ? (
    <EvidenceCompletionDialog kind={kind} task={task} onOpenChange={setEvidenceOpen} onComplete={completeWithEvidence} />
  ) : null;

  if (cellTrigger || isAssignee) {
    return (
      <>
        <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending || awaitingClock} pending={pending} ariaLabel="Change status" header={pill}>
          {manualStatuses.map((option) => (
            <button key={option.value} type="button" disabled={pending || awaitingClock} onClick={() => { setOpen(false); void change(option.value); }} className="task-cell-popover-item">
              <span className={cn("task-pill h-[22px] px-2", toneClasses[statusTone(option.label)])}>
                <span className={cn("task-pill-dot", statusDotClass(option.value))} />
                {option.label}
              </span>
              <span className="flex-1" />
              {raw === option.value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
            </button>
          ))}
        </TaskCellPopover>
        {completionDialog}
      </>
    );
  }

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button type="button" disabled={pending || awaitingClock} onClick={(event) => event.stopPropagation()} data-interactive="true" className={cn("task-pill", toneClasses[statusTone(status)], pad)} aria-label="Change status">
            <span className={cn("task-pill-dot", statusDotClass(raw))} />
            {manualStatuses.find((option) => option.value === raw)?.label ?? status}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="task-menu" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            {manualStatuses.map((option) => (
              <DropdownMenu.Item key={option.value} disabled={pending || awaitingClock} onSelect={() => change(option.value)} className="task-menu-item">
                <span className={cn("task-pill-dot", statusDotClass(option.value))} />
                <span className="flex-1">{option.label}</span>
                {raw === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {completionDialog}
    </>
  );
}

function TaskFilterSubmenu<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; avatar?: React.ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="task-menu-item">
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-52">
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              {option.avatar}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {value === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function TaskFilterMenu({
  kind,
  statusFilter,
  custom,
  showOverdue,
  onShowOverdueChange,
  frequency,
  priorityFilter,
  assigneeFilter,
  assignees,
  showAssigneeFilter,
  paused,
  onPausedChange,
  activeCount,
  onStatusChange,
  onFrequencyChange,
  onPriorityChange,
  onAssigneeChange,
}: {
  kind: Kind;
  statusFilter: StatusFilter[];
  custom: boolean;
  showOverdue: boolean;
  onShowOverdueChange: (value: boolean) => void;
  frequency: FrequencyFilter;
  priorityFilter: PriorityFilter;
  assigneeFilter: string;
  assignees: any[];
  showAssigneeFilter: boolean;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  activeCount: number;
  onStatusChange: (value: StatusFilter[]) => void;
  onFrequencyChange: (value: FrequencyFilter) => void;
  onPriorityChange: (value: PriorityFilter) => void;
  onAssigneeChange: (value: string) => void;
}) {
  const allStatusesSelected = statusFilter.length === allStatusFilters.length;
  const priorityOptions: { value: PriorityFilter; label: string }[] = [{ value: "all", label: "All priorities" }, ...priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))];
  const frequencyOptions: { value: FrequencyFilter; label: string }[] = [{ value: "all", label: "All frequencies" }, ...frequencies];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-toolbar-icon" data-active={activeCount > 0} aria-label="Filter tasks">
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="Task filters">
          {custom ? (
            <DropdownMenu.CheckboxItem className="task-menu-item" checked={showOverdue} onCheckedChange={onShowOverdueChange}>
              <span className="flex-1">Show overdue tasks</span>
              {showOverdue && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.CheckboxItem>
          ) : (
            <>
              {kind === "jd" && <DropdownMenu.CheckboxItem className="task-menu-item" checked={paused} onCheckedChange={onPausedChange}>Inactive tasks{paused && <Check className="ml-auto h-3.5 w-3.5" />}</DropdownMenu.CheckboxItem>}
              {!paused && (kind === "jd" ? (
                <TaskFilterSubmenu<"all" | StatusFilter>
                  label="Status"
                  value={allStatusesSelected ? "all" : statusFilter[0]}
                  options={[{ value: "all", label: "All statuses" }, ...statusOptions]}
                  onChange={(value) => onStatusChange(value === "all" ? allStatusFilters : [value])}
                />
              ) : (
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="task-menu-item">
                    <span className="flex-1">Status</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-52">
                      <DropdownMenu.CheckboxItem className="task-menu-item" checked={allStatusesSelected} onCheckedChange={(checked) => onStatusChange(checked ? allStatusFilters : [])} onSelect={(event) => event.preventDefault()}>
                        <span className="flex-1">All statuses</span>
                        {allStatusesSelected && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
                      </DropdownMenu.CheckboxItem>
                      {statusOptions.map((option) => (
                        <DropdownMenu.CheckboxItem key={option.value} className="task-menu-item" checked={statusFilter.includes(option.value)} onCheckedChange={(checked) => onStatusChange(checked ? [...statusFilter, option.value] : statusFilter.filter((value) => value !== option.value))} onSelect={(event) => event.preventDefault()}>
                          <span className="flex-1">{option.label}</span>
                          {statusFilter.includes(option.value) && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              ))}
              {kind === "jd" ? (
                <TaskFilterSubmenu label="Frequency" value={frequency} options={frequencyOptions} onChange={onFrequencyChange} />
              ) : (
                <TaskFilterSubmenu label="Priority" value={priorityFilter} options={priorityOptions} onChange={onPriorityChange} />
              )}
              {showAssigneeFilter && (
                <TaskFilterSubmenu
                  label="Assigned To"
                  value={assigneeFilter}
                  options={[{ value: "all", label: "All assignees" }, ...assignees.map((assignee) => ({ value: assignee.membership._id as string, label: assigneeDisplayName(assignee), avatar: <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} /> }))]}
                  onChange={onAssigneeChange}
                />
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function taskSortDirectionForField(
  taskType: TaskListTaskType,
  sort: TaskListSort,
  field: TaskListSortField,
): TaskListSortDirection | null {
  if (sort.mode === "field" && sort.field === field) return sort.direction;
  if (sort.mode === "default" && defaultTaskListSortField(taskType) === field) {
    return defaultTaskListSortDirection(taskType);
  }
  return null;
}

function taskSortDirections(taskType: TaskListTaskType, sort: TaskListSort, field: TaskListSortField) {
  const direction = taskSortDirectionForField(taskType, sort, field);
  const nextDirection: TaskListSortDirection = direction === null
    ? initialTaskListSortDirection(field)
    : direction === "asc" ? "desc" : "asc";
  return { direction, nextDirection };
}

function TaskColumnHeader({ custom, label, icon, className, ...sortProps }: React.ComponentProps<typeof ListSortHeader> & { custom: boolean }) {
  if (custom) return <th scope="col" className={className}><span className="inline-flex items-center gap-1.5">{icon}{label}</span></th>;
  return <ListSortHeader label={label} icon={icon} className={className} {...sortProps} />;
}

function SortableTaskRow({
  task,
  index,
  scope,
  dragDisabled,
  checked,
  selected,
  rowCanEdit,
  drag,
  onOpenDetails,
  children,
}: {
  task: TaskRow;
  index: number;
  scope: string;
  dragDisabled: boolean;
  checked: boolean;
  selected: boolean;
  rowCanEdit: boolean;
  drag: ListDrag;
  onOpenDetails: () => void;
  children: ReactNode;
}) {
  // On touch there's no hover to reveal the OPEN chip, so any non-interactive
  // part of an editable row also opens the drawer; cell editors keep their taps.
  const coarse = useIsCoarsePointer();
  const tapOpens = !rowCanEdit || coarse;
  return (
    <ListSortableRow
      id={task._id}
      index={index}
      scope={scope}
      disabled={dragDisabled}
      drag={drag}
      data-row="task"
      data-clickable={tapOpens ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-checked={checked ? "true" : undefined}
      tabIndex={tapOpens ? 0 : undefined}
      onClick={(event) => {
        if (!tapOpens) return;
        if ((event.target as HTMLElement).closest("[data-interactive='true']")) return;
        onOpenDetails();
      }}
      onKeyDown={(event) => {
        if (!tapOpens || (event.target as HTMLElement).closest("[data-interactive='true']")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {children}
    </ListSortableRow>
  );
}

// Row rendering is memoized so list-level updates (search keystrokes, checkbox
// toggles, pending-cell changes on other rows) don't re-render every row.
const TaskTableRow = memo(function TaskTableRow({
  task,
  index,
  kind,
  scope,
  dragDisabled,
  checked,
  selected,
  rowCanEdit,
  drag,
  pendingCell,
  assignable,
  showAssigneeColumn,
  showFrequencyColumn,
  showPriorityColumn,
  onOpenDetails,
  onSaveInline,
}: {
  task: TaskRow;
  index: number;
  kind: Kind;
  scope: string;
  dragDisabled: boolean;
  checked: boolean;
  selected: boolean;
  rowCanEdit: boolean;
  drag: ListDrag;
  pendingCell: string | null;
  assignable: any[] | undefined;
  showAssigneeColumn: boolean;
  showFrequencyColumn: boolean;
  showPriorityColumn: boolean;
  onOpenDetails: (task: TaskRow) => void;
  onSaveInline: (task: any, patch: Partial<TaskFormValues>, label: string) => Promise<boolean>;
}) {
  const clock = useContext(TaskDeadlineContext)?.clock;
  const dueDateTone = dueTone(task, clock ? clock.serverTime + clock.elapsed : null);
  const pending = (field: string) => pendingCell === `${task._id}:${field}`;
  const isPending = isPendingTask(task);
  const openDetails = () => {
    if (!isPending) onOpenDetails(task);
  };
  return (
    <SortableTaskRow
      task={task}
      index={index}
      scope={scope}
      dragDisabled={dragDisabled || isPending}
      checked={checked}
      selected={selected}
      rowCanEdit={rowCanEdit && !isPending}
      drag={drag}
      onOpenDetails={openDetails}
    >
      <td className="w-[92px] whitespace-nowrap font-mono text-[12px] text-[var(--ink-muted)]">{isPending ? "Saving…" : task.reference}</td>
      <td className="col-task max-w-[250px]">
        <div className="task-title-cell">
          {rowCanEdit && !isPending ? (
            <InlineTextCell value={task.title ?? ""} ariaLabel="Edit task title" required pending={pending("title")} onSave={(title) => onSaveInline(task, { title }, "title")} />
          ) : (
            <div className="flex min-w-0 items-center gap-2.5"><span className="min-w-0 flex-1 truncate">{task.title}</span></div>
          )}
          {!isPending && (
            <button
              type="button"
              data-interactive="true"
              data-tooltip="Open in side peek"
              className="task-title-open"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); openDetails(); }}
              aria-label={`Open details for ${task.title}`}
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span>OPEN</span>
            </button>
          )}
        </div>
      </td>
      {kind === "jd" ? (
        showFrequencyColumn && (
          <td className="whitespace-nowrap text-[var(--ink-secondary)]">
            {rowCanEdit ? (
              <InlineSelectCell value={task.recurrence as Frequency} options={frequencies} ariaLabel="Change frequency" pending={pending("frequency")} onSave={(recurrence) => onSaveInline(task, { recurrence }, "frequency")} />
            ) : frequencyLabel(task.recurrence)}
          </td>
        )
      ) : (
        showPriorityColumn && (
          <td>
            {rowCanEdit ? (
              <InlineSelectCell
                value={task.priority as Priority}
                options={priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))}
                ariaLabel="Change priority"
                pending={pending("priority")}
                onSave={(priority) => onSaveInline(task, { priority }, "priority")}
                renderValue={(option) => <span className={cn("priority-chip", priorityChipClasses((option?.value ?? task.priority) as Priority))}>{option?.label ?? priorityLabel(task.priority)}</span>}
              />
            ) : (
              <span className={cn("priority-chip", priorityChipClasses(task.priority as Priority))}>{priorityLabel(task.priority)}</span>
            )}
          </td>
        )
      )}
      {showAssigneeColumn && (
        <td>
          {rowCanEdit && assignable ? (
            <InlineAssigneeCell assignable={assignable} assignees={task.assignees} selected={task.assigneeMembershipIds ?? []} pending={pending("assignee")} onSave={(assigneeMembershipIds) => onSaveInline(task, { assigneeMembershipIds }, "assignee")} />
          ) : <AvatarStack assignees={task.assignees} showName />}
        </td>
      )}
      <td><StatusBadge kind={kind} task={task} canUpdateOverride={rowCanEdit} cellTrigger={rowCanEdit} /></td>
      {kind === "one" && (
        <td className="whitespace-nowrap text-[var(--ink-secondary)]">{formatDate(task.createdAt)}</td>
      )}
      {kind === "one" && (
        <td className="whitespace-nowrap">
          {rowCanEdit ? (
            <DatePicker value={task.dueDate ? toDateField(task.dueDate, dateHasExplicitTime(task.dueDate)) : ""} displayValue={dueLabel(task)} compact onChange={(dueDate) => { void onSaveInline(task, { dueDate }, "due"); }} />
          ) : (
            <span className={cn(dueDateTone === "danger" && "font-medium text-[var(--danger)]", dueDateTone === "warn" && "font-medium text-[var(--badge-yellow-fg)]", dueDateTone === "muted" && "text-[var(--ink-faint)]")}>{dueLabel(task)}</span>
          )}
        </td>
      )}
      {kind === "jd" && (
        <>
          <td>
            {rowCanEdit ? <InlineTextCell value={task.time ?? ""} ariaLabel="Edit time" pending={pending("time")} onSave={(time) => onSaveInline(task, { time }, "time")} /> : <span className="whitespace-nowrap">{task.time || "—"}</span>}
          </td>
          <td>
            {rowCanEdit ? <InlineTextCell value={task.quantity != null ? String(task.quantity) : ""} ariaLabel="Edit quantity" inputMode="decimal" pending={pending("quantity")} onSave={(quantity) => onSaveInline(task, { quantity }, "quantity")} /> : (task.quantity != null ? task.quantity : "—")}
          </td>
        </>
      )}
    </SortableTaskRow>
  );
});

function SelectPicker<T extends string>({ ariaLabel, value, options, onChange, placeholder = "Select", required = false }: { ariaLabel: string; required?: boolean; value: T; options: { value: T; label: string; helper?: string }[]; onChange: (value: T) => void; placeholder?: string }) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`${ariaLabel}${required ? " (required)" : ""}: ${selectedOption?.label ?? placeholder}`} className="task-inline-control" data-interactive="true" onClick={(event) => event.stopPropagation()}>
          <span className={cn("truncate", !selectedOption && "text-[var(--ink-faint)]")}>{selectedOption?.label ?? placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-[var(--radix-dropdown-menu-trigger-width)]" aria-label={ariaLabel}>
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="task-menu-item">
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-[var(--ink)]">{option.label}</span>
                {option.helper && <span className="block text-[11.5px] text-[var(--ink-muted)]">{option.helper}</span>}
              </span>
              {value === option.value && <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AssigneePicker({ assignable, selected, onChange, companyId, kind, required = false, assignableIsTruncated = false }: { assignable: any[]; selected: string[]; onChange: (ids: string[]) => void; companyId?: Id<"companies">; kind: Kind; required?: boolean; assignableIsTruncated?: boolean }) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedServerAssignee, setSelectedServerAssignee] = useState<TaskRowAssignee | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const search = searchValue.trim();
  useEffect(() => {
    if (!open) {
      setDebouncedSearch("");
      return;
    }
    const timeout = window.setTimeout(() => setDebouncedSearch(search), 200);
    return () => window.clearTimeout(timeout);
  }, [open, search]);
  const useServerSearch = Boolean(open && companyId && search === debouncedSearch && search.length >= 3 && search.length <= ASSIGNEE_SEARCH_MAX_LENGTH);
  const searchedAssignableResult = useQuery(
    api.tasks.assignableUsers,
    useServerSearch && companyId ? { companyId, kind: taskTypeFor(kind), search } : "skip",
  ) as AssignableUsersResult | undefined;
  const searchedAssignable = searchedAssignableResult?.users;
  const candidates = useServerSearch ? searchedAssignable ?? [] : assignable;
  const selectedAssignee = candidates.find((assignee) => assignee.membership._id === selected[0])
    ?? assignable.find((assignee) => assignee.membership._id === selected[0])
    ?? (selectedServerAssignee?.membership._id === selected[0] ? selectedServerAssignee : undefined);
  const filtered = useServerSearch
    ? candidates
    : assignable.filter((assignee) => `${assignee.user.name || ""} ${assignee.user.email || ""} ${assignee.membership.role}`.toLowerCase().includes(search.toLowerCase()));
  const resultsAreTruncated = useServerSearch ? searchedAssignableResult?.isTruncated : assignableIsTruncated;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent | PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchValue("");
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setSearchValue("");
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!assignable.length && !companyId) return <div className="py-2 text-[13px] text-[var(--ink-faint)]">No assignable people.</div>;
  return (
    <div ref={containerRef} className="relative">
      <button type="button" aria-label={`Assigned To${required ? " (required)" : ""}: ${selectedAssignee ? (selectedAssignee.user.name || selectedAssignee.user.email) : required ? "Select assignee" : "Unassigned"}`} onClick={(event) => { event.stopPropagation(); setOpen((current) => !current); }} className="task-inline-control" data-interactive="true">
        {selectedAssignee ? <Avatar name={selectedAssignee.user.name} email={selectedAssignee.user.email} imageUrl={selectedAssignee.user.imageUrl} /> : <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><User className="h-3.5 w-3.5" /></span>}
        <span className={cn("min-w-0 flex-1 truncate", !selectedAssignee && "text-[var(--ink-faint)]")}>{selectedAssignee ? (selectedAssignee.user.name || selectedAssignee.user.email) : required ? "Select assignee" : "Unassigned"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[71] rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-popover)]" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <div className="relative px-1 pb-1.5 pt-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-faint)]" />
            <Input aria-label="Search assignees" className="h-8 rounded-md pl-8 text-[13px]" maxLength={ASSIGNEE_SEARCH_MAX_LENGTH} value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search people" autoFocus />
          </div>
          {resultsAreTruncated && <p className="px-2.5 pb-1 text-[11.5px] text-[var(--ink-muted)]" role="status">{useServerSearch ? "Search results are limited. Try a more specific search." : "This picker initially shows 500 people. Search with at least 3 characters to search up to 1,000 people."}</p>}
          <div className="max-h-56 overflow-auto p-0.5">
            {!required && (
              <button type="button" onClick={() => { setSelectedServerAssignee(null); onChange([]); setOpen(false); setSearchValue(""); }} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-muted)]">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><User className="h-3.5 w-3.5" /></span>
                <span className="flex-1 text-[var(--ink-secondary)]">Unassigned</span>
                {!selected[0] && <Check className="h-4 w-4 text-[var(--primary)]" />}
              </button>
            )}
            {filtered.map((assignee) => {
              const id = assignee.membership._id as string;
              const name = assignee.user.name || assignee.user.email;
              return (
                <button key={id} type="button" onClick={() => { setSelectedServerAssignee(assignee); onChange([id]); setOpen(false); setSearchValue(""); }} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-muted)]">
                  <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{name}</span><span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{assignee.membership.role}</span></span>
                  {selected[0] === id && <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />}
                </button>
              );
            })}
            {useServerSearch && !searchedAssignable ? <div className="px-2.5 py-3 text-[13px] text-[var(--ink-muted)]">Searching people…</div> : filtered.length === 0 && <div className="px-2.5 py-3 text-[13px] text-[var(--ink-muted)]">No people found.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function sameCalendarDay(a: Date | null, b: Date) {
  return Boolean(a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
}

function DatePicker({ value, onChange, displayValue, compact = false }: { value: string; onChange: (value: string) => void; displayValue?: string; compact?: boolean }) {
  const selectedDate = dateFromField(value);
  const initialIncludesTime = Boolean(selectedDate && dateFieldHasTime(value));
  const [open, setOpen] = useState(false);
  const [includeTime, setIncludeTime] = useState(initialIncludesTime);
  const [dateDraft, setDateDraft] = useState(() => selectedDate ? formatDateOnly(selectedDate, "short") : "");
  const [timeDraft, setTimeDraft] = useState(() => initialIncludesTime && selectedDate ? formatTimeOnly(selectedDate) : "");
  const [monthDate, setMonthDate] = useState(() => selectedDate ?? new Date());
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(1 - monthStart.getDay());
  const monthLabel = monthDate.toLocaleString(undefined, { month: "short", year: "numeric" });
  const todayDate = new Date();

  useEffect(() => {
    const nextDate = dateFromField(value);
    const nextIncludesTime = Boolean(nextDate && dateFieldHasTime(value));
    setIncludeTime(nextIncludesTime);
    setDateDraft(nextDate ? formatDateOnly(nextDate, "short") : "");
    setTimeDraft(nextIncludesTime && nextDate ? formatTimeOnly(nextDate) : "");
    if (nextDate) setMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
  }, [value]);

  function emitDate(date: Date, withTime: boolean, timeSource: Date | null = selectedDate) {
    const next = new Date(date);
    if (withTime) {
      const source = timeSource && dateFieldHasTime(value) ? timeSource : new Date();
      next.setHours(source.getHours(), source.getMinutes(), 0, 0);
    } else {
      next.setHours(23, 59, 59, 0);
    }
    onChange(toDateField(next.getTime(), withTime));
  }

  function commitDateDraft(): boolean | null {
    const parsed = dateFromField(dateDraft);
    if (!parsed) {
      setDateDraft(selectedDate ? formatDateOnly(selectedDate, "short") : "");
      return null;
    }
    const draftIncludesTime = dateFieldHasTime(dateDraft);
    const committedIncludesTime = draftIncludesTime || includeTime;
    setMonthDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    if (draftIncludesTime) {
      setIncludeTime(true);
      onChange(toDateField(parsed.getTime(), true));
    } else {
      emitDate(parsed, includeTime);
    }
    return committedIncludesTime;
  }

  function commitTimeDraft(): boolean {
    const parts = parseTimeParts(timeDraft);
    if (!parts) {
      setTimeDraft(selectedDate && includeTime ? formatTimeOnly(selectedDate) : "");
      return false;
    }
    const next = selectedDate ? new Date(selectedDate) : new Date();
    next.setHours(parts.hours, parts.minutes, 0, 0);
    setIncludeTime(true);
    onChange(toDateField(next.getTime(), true));
    return true;
  }

  function pick(date: Date) {
    setMonthDate(new Date(date.getFullYear(), date.getMonth(), 1));
    emitDate(date, includeTime);
    if (!includeTime) {
      setOpen(false);
    }
  }

  function jumpToCurrent() {
    const now = new Date();
    setMonthDate(new Date(now.getFullYear(), now.getMonth(), 1));
    emitDate(now, includeTime, includeTime ? now : null);
    if (!includeTime) {
      setOpen(false);
    }
  }

  function toggleIncludeTime(nextIncludesTime: boolean) {
    setIncludeTime(nextIncludesTime);
    const date = selectedDate ?? new Date();
    emitDate(date, nextIncludesTime, nextIncludesTime ? (selectedDate && dateFieldHasTime(value) ? selectedDate : new Date()) : null);
  }


  const header = (
    <>
      {!compact && <CalendarDays className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />}
      <span className={cn("min-w-0 flex-1 truncate", !value && "text-[var(--ink-faint)]")}>{displayValue ?? (value || (compact ? "—" : "Add date"))}</span>
      {!compact && <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />}
    </>
  );
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    return date;
  });
  const calendar = (
    <div className="p-3">
      <div className="mb-3 flex items-center gap-1.5">
        <input
          aria-label="Due Date"
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-ring)]"
          value={dateDraft}
          onChange={(event) => setDateDraft(event.target.value)}
          onBlur={commitDateDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const committedIncludesTime = commitDateDraft();
              if (committedIncludesTime === false) setOpen(false);
            }
            if (event.key === "Escape") setDateDraft(selectedDate ? formatDateOnly(selectedDate, "short") : "");
          }}
          placeholder="Jun 24, 2026"
        />
        {includeTime && (
          <>
            <input
              aria-label="Due time"
              className="h-8 w-[86px] rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-ring)]"
              value={timeDraft}
              onChange={(event) => setTimeDraft(event.target.value)}
              onBlur={commitTimeDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const saved = commitTimeDraft();
                  if (saved) setOpen(false);
                }
                if (event.key === "Escape") setTimeDraft(selectedDate && includeTime ? formatTimeOnly(selectedDate) : "");
              }}
              placeholder="5:00 PM"
            />
          </>
        )}
      </div>
      <div className="mb-2 flex items-center gap-1.5">
        <div className="flex-1 text-[13px] font-semibold text-[var(--ink)]">{monthLabel}</div>
        <button type="button" className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]" onClick={jumpToCurrent}>{includeTime ? "Now" : "Today"}</button>
        <button type="button" className="task-icon-btn h-7 w-7" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" className="task-icon-btn h-7 w-7" onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-[var(--ink-faint)]">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <div key={day} className="py-1">{day}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {calendarDays.map((date) => {
          const selected = sameCalendarDay(selectedDate, date);
          const inCurrentMonth = date.getMonth() === monthDate.getMonth();
          const isToday = sameCalendarDay(todayDate, date);
          return (
            <button key={date.toISOString()} type="button" onClick={() => pick(date)} className={cn("h-8 rounded-md text-[13px] transition-colors hover:bg-[var(--surface-muted)]", inCurrentMonth ? "text-[var(--ink-secondary)]" : "text-[var(--ink-faint)]", isToday && "font-semibold text-[var(--primary)]", selected && "bg-[var(--primary)] !text-[var(--on-primary)] hover:!bg-[var(--primary-hover)]")}>
              {date.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-3 border-t border-[var(--hairline)] py-2">
        <button type="button" role="switch" aria-checked={includeTime} className="flex w-full items-center justify-between rounded-md px-0 py-1.5 text-left text-[13px] text-[var(--ink-secondary)] hover:text-[var(--ink)]" onClick={() => toggleIncludeTime(!includeTime)}>
          <span>Include time</span>
          <span className={cn("relative h-5 w-9 rounded-full transition-colors", includeTime ? "bg-[var(--primary)]" : "bg-[var(--surface-pressed)]")}>
            <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", includeTime ? "translate-x-[18px]" : "translate-x-0.5")} />
          </span>
        </button>
      </div>
      <div className="border-t border-[var(--hairline)] pt-1">
        <button type="button" className="w-full rounded-md py-1.5 text-left text-[13px] text-[var(--ink-secondary)] hover:text-[var(--ink)]" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
      </div>
    </div>
  );

  if (compact) return <TaskCellPopover open={open} onOpenChange={setOpen} ariaLabel="Change Due Date" header={header} panelClassName="task-cell-popover-date" preferredWidth={250}>{calendar}</TaskCellPopover>;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-inline-control" data-interactive="true" onClick={(event) => event.stopPropagation()}>{header}</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu w-[250px] p-0" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          {calendar}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function InlineTextCell({ value, placeholder = "—", ariaLabel, onSave, required = false, inputMode = "text", align = "left", pending = false }: { value: string; placeholder?: string; ariaLabel: string; onSave: (value: string) => Promise<boolean>; required?: boolean; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; align?: "left" | "right"; pending?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const savingRef = useRef(false);
  const didFocusRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  useEffect(() => { if (!editing) didFocusRef.current = false; }, [editing]);
  useLayoutEffect(() => {
    if (!editing || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(41, textarea.scrollHeight + 2)}px`;
  }, [draft, editing]);

  async function commit() {
    if (savingRef.current) return;
    const next = draft.trim();
    if (required && !next) { setDraft(value); setEditing(false); return; }
    if (next === value.trim()) { setEditing(false); return; }
    savingRef.current = true;
    const saved = await onSave(next);
    savingRef.current = false;
    if (saved) setEditing(false);
    else setDraft(value);
  }

  if (editing) {
    return (
      <span className="task-cell-editor" data-interactive="true">
        <span aria-hidden="true" className={cn("task-cell-control task-cell-editor-sizer", align === "right" && "justify-end text-right")}>
          <span className={cn("min-w-0 truncate", !value && "text-[var(--ink-faint)]")}>{value || placeholder}</span>
        </span>
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          autoFocus
          data-interactive="true"
          inputMode={inputMode}
          disabled={pending}
          value={draft}
          rows={1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => {
            if (didFocusRef.current) return;
            const position = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(position, position);
            didFocusRef.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") { setDraft(value); setEditing(false); }
          }}
          className={cn("task-cell-input", align === "right" && "text-right")}
        />
      </span>
    );
  }

  return (
    <button type="button" data-interactive="true" disabled={pending} className={cn("task-cell-control", align === "right" && "justify-end text-right", pending && "opacity-60")} onClick={(event) => { event.stopPropagation(); setEditing(true); }}>
      <span className={cn("min-w-0 truncate", !value && "text-[var(--ink-faint)]")}>{value || placeholder}</span>
    </button>
  );
}

function InlineSelectCell<T extends string>({ value, options, ariaLabel, onSave, pending = false, renderValue }: { value: T; options: { value: T; label: string }[]; ariaLabel: string; onSave: (value: T) => Promise<boolean>; pending?: boolean; renderValue?: (option: { value: T; label: string } | undefined) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const header = <span className="min-w-0 flex-1 truncate">{renderValue ? renderValue(selected) : selected?.label ?? "—"}</span>;
  return (
    <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending} pending={pending} ariaLabel={ariaLabel} header={header}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => { setOpen(false); if (option.value !== value) void onSave(option.value); }} className="task-cell-popover-item">
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.value === value && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
        </button>
      ))}
    </TaskCellPopover>
  );
}

function InlineAssigneeCell({ assignable, assignees, selected, onSave, pending = false }: { assignable: any[]; assignees: any[]; selected: string[]; onSave: (ids: string[]) => Promise<boolean>; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  const selectedId = selected[0];
  const header = <span className="min-w-0 flex-1 truncate"><AvatarStack assignees={assignees} showName /></span>;
  return (
    <TaskCellPopover open={open} onOpenChange={setOpen} disabled={pending || assignable.length === 0} pending={pending} ariaLabel="Change assigned to" header={header} panelClassName="task-cell-popover-scroll">
      {assignable.map((assignee) => {
        const id = assignee.membership._id as string;
        const name = assignee.user.name || assignee.user.email;
        return (
          <button key={id} type="button" onClick={() => { setOpen(false); if (id !== selectedId) void onSave([id]); }} className="task-cell-popover-item">
            <Avatar name={assignee.user.name} email={assignee.user.email} imageUrl={assignee.user.imageUrl} />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--ink)]">{name}</span><span className="block truncate text-[11.5px] text-[var(--ink-muted)]">{assignee.membership.role}</span></span>
            {selectedId === id && <Check className="h-3.5 w-3.5 text-[var(--ink-faint)]" />}
          </button>
        );
      })}
    </TaskCellPopover>
  );
}

function fileIdentity(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function EvidenceFilePicker({ files, onChange, disabled = false }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const [previews, setPreviews] = useState<Record<string, string>>({});

  // Object URLs live only as long as the current selection.
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const next: Record<string, string> = {};
    for (const file of files) if (file.type.startsWith("image/")) next[fileIdentity(file)] = URL.createObjectURL(file);
    setPreviews(next);
    return () => { for (const url of Object.values(next)) URL.revokeObjectURL(url); };
  }, [files]);

  function addFiles(incoming: File[]) {
    const merged = [...files];
    for (const file of incoming) {
      if (merged.length >= MAX_EVIDENCE_FILES) break;
      if (!merged.some((existing) => fileIdentity(existing) === fileIdentity(file))) merged.push(file);
    }
    onChange(merged);
  }

  const full = files.length >= MAX_EVIDENCE_FILES;
  const blocked = disabled || full;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className={cn("task-inline-control cursor-pointer", blocked && "cursor-not-allowed opacity-60")}>
          <ImagePlus className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate text-[var(--ink-faint)]">Add images</span>
          <input className="sr-only" type="file" accept="image/*" multiple disabled={blocked} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        </label>
        <label className={cn("task-inline-control cursor-pointer", blocked && "cursor-not-allowed opacity-60")}>
          <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
          <span className="truncate text-[var(--ink-faint)]">Add files</span>
          <input className="sr-only" type="file" multiple disabled={blocked} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        </label>
        <span className="text-[12px] text-[var(--ink-faint)]">{files.length} of {MAX_EVIDENCE_FILES} files</span>
      </div>
      {files.length > 0 && (
        <div className="grid gap-1.5">
          {files.map((file, index) => {
            const preview = previews[fileIdentity(file)];
            return (
              <div key={fileIdentity(file)} className="flex min-h-9 items-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px]">
                {preview ? <span role="img" aria-label={file.name} className="h-9 w-9 shrink-0 rounded bg-cover bg-center" style={{ backgroundImage: `url(${preview})` }} /> : <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />}
                <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{file.name}</span>
                <span className="shrink-0 text-[12px] text-[var(--ink-faint)]">{humanSize(file.size)}</span>
                <button type="button" disabled={disabled} onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))} className="task-icon-btn h-6 w-6 rounded" aria-label={`Remove ${file.name}`}><X className="h-3.5 w-3.5" /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EvidenceCompletionDialog({ kind, task, onOpenChange, onComplete }: { kind: Kind; task: any; onOpenChange: (open: boolean) => void; onComplete: (evidence: EvidenceSubmission) => Promise<void> }) {
  const { activeCompanyId } = useCompany();
  const generateUploadUrl = useMutation(api.tasks.generateEvidenceUploadUrl);
  const bindUploadClaim = useMutation(api.tasks.bindEvidenceUploadClaim);
  const discardUpload = useMutation(api.tasks.discardEvidenceUpload);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textId = useId();
  const empty = !text.trim() && files.length === 0;

  async function submit() {
    if (!activeCompanyId || submitting || empty) return;
    setSubmitting(true);
    setError(null);
    // Track every claim as soon as it exists so a later failure can release it.
    const claims: Id<"taskUploadClaims">[] = [];
    const uploads: EvidenceFileUpload[] = [];
    try {
      for (const file of files) {
        const upload = await generateUploadUrl({ companyId: activeCompanyId, taskType: taskTypeFor(kind), taskId: task._id as string });
        claims.push(upload.claimId);
        let response: Response;
        try {
          response = await fetch(upload.url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        } catch {
          throw new Error(`Could not upload ${file.name}.`);
        }
        if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
        const json = await response.json() as { storageId?: Id<"_storage"> };
        if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
        // Bind immediately: the claim becomes the only token cleanup may use
        // to delete this blob, and submission requires the binding.
        await bindUploadClaim({ companyId: activeCompanyId, taskType: taskTypeFor(kind), taskId: task._id as string, claimId: upload.claimId, storageId: json.storageId });
        uploads.push({ storageId: json.storageId, fileName: file.name, claimId: upload.claimId });
      }
      await onComplete({ text: text.trim() || undefined, files: uploads });
      onOpenChange(false);
    } catch (err) {
      // Nothing was saved: release every uploaded claim and its bound blob.
      await Promise.all(claims.map((claimId) => discardUpload({ companyId: activeCompanyId, claimId }).catch(() => {})));
      setError(err instanceof Error ? err.message : "Could not complete the task.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" data-interactive="true" />
        <Dialog.Content
          data-interactive="true"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,92dvh)] w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-6 py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Add completion evidence</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close" disabled={submitting}><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">This task requires evidence before it can be marked complete. Add text, images, or files.</Dialog.Description>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <label htmlFor={textId} className="mb-1 block text-[13px] text-[var(--ink-muted)]">Evidence</label>
            <Textarea id={textId} aria-label="Evidence" value={text} maxLength={MAX_EVIDENCE_TEXT_LENGTH} disabled={submitting} autoFocus placeholder="Describe what was done, attach a photo, or add a file." onChange={(event) => setText(event.target.value)} />
            <div className="mt-2 text-[12px] text-[var(--ink-faint)]">{text.length} / {MAX_EVIDENCE_TEXT_LENGTH}</div>
            <div className="mt-4"><EvidenceFilePicker files={files} onChange={setFiles} disabled={submitting} /></div>
            {error && <p className="alert-error mt-4 rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--hairline)] px-6 py-4">
            <Button type="button" variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" size="lg" variant="primary" disabled={submitting || empty} onClick={() => void submit()}>{submitting ? "Completing..." : "Complete task"}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AttachmentPicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  function addFiles(nextFiles: File[]) {
    const merged = [...files];
    for (const file of nextFiles) {
      if (!merged.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) merged.push(file);
    }
    onChange(merged);
  }

  return (
    <div className="grid gap-1.5">
      <label className="task-inline-control cursor-pointer">
        <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
        <span className="truncate text-[var(--ink-faint)]">Add attachments</span>
        <input className="sr-only" type="file" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
      </label>
      {files.length > 0 && (
        <div className="grid gap-1.5">
          {files.map((file, index) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex h-9 items-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px]">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{file.name}</span>
              <button type="button" onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))} className="task-icon-btn h-6 w-6 rounded" aria-label={`Remove ${file.name}`}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Applies a sparse field-mutation payload to a loaded task row. Only fields
// actually present (not undefined) are written; state/status stay server-owned.
// Assignee ids are re-expanded to enriched rows from the local assignable list.
function applyTaskFieldPatch(row: any, fields: Record<string, unknown>, assignable: any[] | undefined) {
  const next = { ...row };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) next[key] = value;
  }
  if (fields.assigneeMembershipIds !== undefined) {
    const ids = (fields.assigneeMembershipIds ?? []) as string[];
    const existing = (row.assignees ?? []) as any[];
    next.assignees = ids
      .map((id) => assignable?.find((candidate) => candidate.membership?._id === id) ?? existing.find((candidate) => candidate.membership?._id === id))
      .filter(Boolean);
  }
  return next;
}

function optimisticTaskFieldPatch(listQuery: any, detailQuery: any, assignable: any[] | undefined) {
  return (localStore: any, args: any) => {
    const { taskId, ...fields } = args;
    const patch = (row: any) => applyTaskFieldPatch(row, fields, assignable);
    updateInListPages(localStore, listQuery, taskId, patch);
    updateInDetailQueries(localStore, detailQuery, taskId, patch);
  };
}

// Synthetic list row shown while a create mutation is in flight. The id is a
// local sentinel — never a real server id — and reference stays empty because
// the final reference number is assigned on the server.
function isPendingTask(task: { _id: string }) {
  return String(task._id).startsWith("pending:");
}

function pendingTaskRow(args: { title: string; description?: string; notes?: string; time?: string; quantity?: number | null; recurrence?: string; priority?: string; dueDate?: number | null; evidenceRequired?: boolean; assigneeMembershipIds?: string[] }, assignable: any[]) {
  const now = Date.now();
  const assigneeMembershipIds = (args.assigneeMembershipIds ?? []) as string[];
  return {
    _id: `pending:${crypto.randomUUID()}`,
    reference: "",
    title: args.title,
    description: args.description,
    notes: args.notes,
    time: args.time,
    quantity: args.quantity ?? null,
    recurrence: args.recurrence,
    priority: args.priority,
    dueDate: args.dueDate ?? null,
    evidenceRequired: args.evidenceRequired === true,
    createdAt: now,
    assigneeMembershipIds,
    assignees: assigneeMembershipIds.map((id) => assignable.find((candidate) => candidate.membership?._id === id)).filter(Boolean),
    canUpdate: false,
    canDelete: false,
    state: { status: "Pending", rawStatus: "due", isOverdue: false, dueAt: args.dueDate ?? null },
  };
}

function TaskDialog({ kind, mode, open, onOpenChange, task, assignable, assignableIsTruncated = false, onUploadError }: { kind: Kind; mode: "create" | "edit"; open: boolean; onOpenChange: (open: boolean) => void; task?: any; assignable: any[]; assignableIsTruncated?: boolean; onUploadError?: (message: string) => void }) {
  const { activeCompanyId, active } = useCompany();
  const createJd = useMutation(api.tasks.createJd).withOptimisticUpdate((localStore, args) => {
    prependToListFirstPage(localStore, api.tasks.listJdRows, pendingTaskRow(args, assignable));
  });
  const createOne = useMutation(api.tasks.createOneTime).withOptimisticUpdate((localStore, args) => {
    prependToListFirstPage(localStore, api.tasks.listOneTimeRows, pendingTaskRow(args, assignable));
  });
  const updateJd = useMutation(api.tasks.updateJd);
  const updateOne = useMutation(api.tasks.updateOneTime);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const bindUploadClaim = useMutation(api.tasks.bindUploadClaim);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteOrphanedUpload = useMutation(api.tasks.deleteOrphanedUpload);
  const [values, setValues] = useState<TaskFormValues>(() => task ? formFromTask(kind, task) : emptyForm(kind));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const titleId = useId();
  const taskAssignees = task?.assignees;
  const dialogAssignable = useMemo(() => {
    if (!taskAssignees || taskAssignees.length === 0) return assignable;
    const list = [...assignable];
    for (const a of taskAssignees) {
      if (!list.some((existing) => existing.membership._id === a.membership._id)) {
        list.push(a);
      }
    }
    return list;
  }, [assignable, taskAssignees]);

  function reset(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setError(null);
      setSaving(false);
      setValues(task ? formFromTask(kind, task) : emptyForm(kind));
    }
  }
  function patch(update: Partial<TaskFormValues>) { setValues((current) => ({ ...current, ...update })); setError(null); }

  async function uploadFiles(taskId: string, files: File[]) {
    if (!activeCompanyId || files.length === 0 || !active?.capabilities.includes("tasks:attachment:add")) return;
    await Promise.all([...files].map(async (file) => {
      const upload = await generateUploadUrl({ companyId: activeCompanyId });
      const response = await fetch(upload.url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
      const json = await response.json() as { storageId?: Id<"_storage"> };
      if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
      try {
        await bindUploadClaim({ companyId: activeCompanyId, claimId: upload.claimId, storageId: json.storageId });
        await addAttachment({ companyId: activeCompanyId, taskType: taskTypeFor(kind), taskId, storageId: json.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size, claimId: upload.claimId });
      } catch (err) {
        // The blob is already stored; reclaim the blob bound to the claim.
        // An unbound claim names no blob, so cleanup leaves storage alone.
        void deleteOrphanedUpload({ companyId: activeCompanyId, claimId: upload.claimId }).catch(() => {});
        throw err;
      }
      setValues((current) => ({ ...current, files: current.files.filter((candidate) => candidate !== file) }));
    }));
  }

  async function submit() {
    if (!activeCompanyId || saving) return;
    if (!values.title.trim()) { setError("Task title is required."); return; }
    if (mode === "create" && values.assigneeMembershipIds.length === 0) { setError("Assignee is required."); return; }
    if (kind === "jd" && !values.recurrence) { setError("Frequency is required."); return; }
    setSaving(true);
    setError(null);
    try {
      let taskId = task?._id as string | undefined;
      const common = { companyId: activeCompanyId, title: values.title.trim(), description: values.description, notes: values.notes, time: values.time, quantity: quantityFromInput(values.quantity), evidenceRequired: values.evidenceRequired, assigneeMembershipIds: values.assigneeMembershipIds as Id<"companyMemberships">[] };
      if (kind === "jd") {
        if (mode === "create") taskId = await createJd({ ...common, recurrence: values.recurrence });
        else await updateJd({ ...common, taskId: task._id, recurrence: values.recurrence });
      } else {
        const payload = { ...common, dueDate: fromDateInput(values.dueDate), priority: values.priority };
        if (mode === "create") taskId = await createOne(payload);
        else await updateOne({ ...payload, taskId: task._id });
      }
      // The saved task is already visible (optimistic row); attachment uploads
      // continue in the background and surface failures through the list error.
      const files = values.files;
      reset(false);
      setValues(emptyForm(kind));
      if (taskId && files.length) {
        void uploadFiles(taskId, files).catch((err) => onUploadError?.(err instanceof Error ? err.message : "Could not upload attachments."));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={reset}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,92dvh)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-6 py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{mode === "create" ? `New ${kind === "jd" ? "JD " : ""}task` : `Edit ${kind === "jd" ? "JD " : ""}task`}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="task-icon-btn" aria-label="Close"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Create or edit a {kind === "jd" ? "JD" : "one-time"} task.</Dialog.Description>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {mode === "create" && <label htmlFor={titleId} className="mb-1 block text-[13px] text-[var(--ink-muted)]">Title<RequiredIndicator /></label>}
              <input id={titleId} aria-label="Task title" aria-required={mode === "create" || undefined} className="w-full border-none bg-transparent text-lg font-semibold tracking-[-0.01em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" value={values.title} onChange={(event) => patch({ title: event.target.value })} placeholder="Title" autoFocus />

              <div className="mt-4 divide-y divide-[var(--hairline)] border-y border-[var(--hairline)]">
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Assigned To{mode === "create" && <RequiredIndicator />}</span>
                  <div className="min-w-0"><AssigneePicker assignable={dialogAssignable} assignableIsTruncated={assignableIsTruncated} selected={values.assigneeMembershipIds} onChange={(ids) => patch({ assigneeMembershipIds: ids })} companyId={activeCompanyId ?? undefined} kind={kind} required={mode === "create"} /></div>
                </div>
                {kind === "jd" ? (
                  <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                    <span className="text-[13px] text-[var(--ink-muted)]">Frequency{mode === "create" && <RequiredIndicator />}</span>
                    <div className="min-w-0"><SelectPicker ariaLabel="Frequency" required={mode === "create"} value={values.recurrence} options={frequencies} onChange={(recurrence) => patch({ recurrence })} /></div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                      <span className="text-[13px] text-[var(--ink-muted)]">Priority{mode === "create" && <RequiredIndicator />}</span>
                      <div className="min-w-0"><SelectPicker ariaLabel="Priority" required={mode === "create"} value={values.priority} options={priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))} onChange={(priority) => patch({ priority })} /></div>
                    </div>
                    <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                      <span className="text-[13px] text-[var(--ink-muted)]">Due Date</span>
                      <div className="min-w-0"><DatePicker value={values.dueDate} onChange={(dueDate) => patch({ dueDate })} /></div>
                    </div>
                  </>
                )}
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Quantity</span>
                  <div className="min-w-0"><input aria-label="Quantity" className="h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" inputMode="decimal" value={values.quantity} onChange={(event) => patch({ quantity: event.target.value })} placeholder="None" /></div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Time</span>
                  <div className="min-w-0"><input aria-label="Time estimate" className="h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" value={values.time} onChange={(event) => patch({ time: event.target.value })} placeholder="None" /></div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                  <span className="text-[13px] text-[var(--ink-muted)]">Evidence</span>
                  <div className="min-w-0">
                    <Switch checked={values.evidenceRequired} onCheckedChange={(evidenceRequired) => patch({ evidenceRequired })} aria-label="Require evidence to complete">
                      Require evidence to complete
                    </Switch>
                  </div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-start gap-3 py-2">
                  <span className="pt-2 text-[13px] text-[var(--ink-muted)]">Description</span>
                  <div className="min-w-0"><textarea aria-label="Description" className="block w-full resize-none border-none bg-transparent px-2 py-2 text-[13px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" rows={3} value={values.description} onChange={(event) => patch({ description: event.target.value })} placeholder="Add context, instructions, or acceptance criteria." /></div>
                </div>
                <div className="grid grid-cols-[120px_1fr] items-start gap-3 py-2">
                  <span className="pt-2 text-[13px] text-[var(--ink-muted)]">Notes</span>
                  <div className="min-w-0"><textarea aria-label="Notes" className="block w-full resize-none border-none bg-transparent px-2 py-2 text-[13px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]" rows={3} value={values.notes} onChange={(event) => patch({ notes: event.target.value })} placeholder="Add notes, reminders, or observations." /></div>
                </div>
                {active?.capabilities.includes("tasks:attachment:add") && (
                  <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2">
                    <span className="text-[13px] text-[var(--ink-muted)]">Attachments</span>
                    <div className="min-w-0"><AttachmentPicker files={values.files} onChange={(files) => patch({ files })} /></div>
                  </div>
                )}
              </div>

              {error && <p className="alert-error mt-4 rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--hairline)] px-6 py-4">
              <Button type="button" variant="secondary" onClick={() => reset(false)}>Cancel</Button>
              <Button type="submit" size="lg" variant="primary" disabled={saving || !values.title.trim() || (mode === "create" && values.assigneeMembershipIds.length === 0)}>{saving ? "Saving..." : mode === "create" ? "Create task" : "Save changes"}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const taskDeadlineSyncError = "Could not refresh task deadlines. Retrying automatically.";
// Bound accepted round trips to one second and compensate at their midpoint.
// Never let network queues, suspended tabs or sleep create an unbounded offset.
const TASK_CLOCK_MAX_ROUND_TRIP_MS = 1000;

type TaskDeadlineClock = { serverTime: number; receivedAt: number; elapsed: number };
const TaskDeadlineContext = createContext<{
  clock: TaskDeadlineClock | null;
  synchronized: boolean;
  deadlineError: string | null;
  advanceClock: () => void;
} | null>(null);

export function TaskDeadlineProvider({ children }: { children: ReactNode }) {
  const { activeCompanyId, active } = useCompany();
  return <TaskDeadlineProviderContent key={`${activeCompanyId}:${active?.membership._id}`} companyId={activeCompanyId}>{children}</TaskDeadlineProviderContent>;
}

function TaskDeadlineProviderContent({ companyId, children }: { companyId: Id<"companies"> | null; children: ReactNode }) {
  const getServerTime = useMutation(api.tasks.getServerTime);
  const [clock, setClock] = useState<TaskDeadlineClock | null>(null);
  const [synchronized, setSynchronized] = useState(false);
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  const advanceClock = useCallback(() => {
    setClock((current) => current && { ...current, elapsed: performance.now() - current.receivedAt });
  }, []);
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    let request = 0;
    let inFlight = false;
    let retryTimer: number | undefined;
    let retryDelay = 1000;
    const isPageVisible = () => document.visibilityState !== "hidden";
    const syncClock = async () => {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (cancelled || !isPageVisible() || inFlight) return;
      inFlight = true;
      setSynchronized(false);
      const current = ++request;
      const startedAt = performance.now();
      const wallStartedAt = Date.now();
      try {
        const serverTime = await getServerTime({ companyId });
        if (!cancelled && current === request) {
          const receivedAt = performance.now();
          const roundTrip = receivedAt - startedAt;
          // Some browsers stop the monotonic clock during OS sleep. Wall time
          // can reject a suspect sample, but never advances task deadlines.
          const wallRoundTrip = Date.now() - wallStartedAt;
          if (Math.max(roundTrip, wallRoundTrip) > TASK_CLOCK_MAX_ROUND_TRIP_MS || Math.abs(wallRoundTrip - roundTrip) > TASK_CLOCK_MAX_ROUND_TRIP_MS) {
            throw new Error("Stale task clock sample.");
          }
          const sampledTime = serverTime + roundTrip / 2;
          // A delayed reply must not undo a deadline already observed.
          setClock((previous) => ({
            serverTime: previous ? Math.max(sampledTime, previous.serverTime + receivedAt - previous.receivedAt) : sampledTime,
            receivedAt,
            elapsed: 0,
          }));
          retryDelay = 1000;
          setSynchronized(true);
          setDeadlineError(null);
        }
      } catch {
        if (!cancelled && current === request) {
          advanceClock();
          setDeadlineError(taskDeadlineSyncError);
          if (isPageVisible()) {
            retryTimer = window.setTimeout(() => { void syncClock(); }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        }
      } finally {
        inFlight = false;
        // A visibility transition invalidates the pending sample. Wait for it
        // to settle before resyncing; Convex mutations cannot be aborted.
        if (!cancelled && current !== request && isPageVisible()) void syncClock();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        advanceClock();
        void syncClock();
      } else {
        request++;
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };
    void syncClock();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId, getServerTime, advanceClock]);
  const value = useMemo(() => ({ clock, synchronized, deadlineError, advanceClock }), [clock, synchronized, deadlineError, advanceClock]);
  return <TaskDeadlineContext.Provider value={value}>{children}</TaskDeadlineContext.Provider>;
}

function useTaskDeadlineRows(tasks: TaskRow[] | undefined, kind: Kind) {
  const deadlineClock = useContext(TaskDeadlineContext);
  if (kind === "one" && !deadlineClock) throw new Error("One-Time tasks require TaskDeadlineProvider.");
  const clock = deadlineClock?.clock;
  const advanceClock = deadlineClock?.advanceClock;
  // Only monotonic elapsed time advances the server clock; device wall-clock
  // skew or adjustments must not hide upcoming tasks or lock their controls.
  const taskTime = clock ? clock.serverTime + clock.elapsed : null;
  const allTasks = useMemo<TaskRow[]>(() => {
    if (kind !== "one" || taskTime === null) return tasks ?? [];
    return (tasks ?? []).map((task) => {
      if (rawStatus(task) === "completed" || rawStatus(task) === "overdue" || task.dueDate == null || task.dueDate >= taskTime) return task;
      return { ...task, state: { ...(typeof task.state === "object" ? task.state : {}), status: "Overdue", rawStatus: "overdue" as const, isOverdue: true } };
    });
  }, [kind, tasks, taskTime]);
  useEffect(() => {
    if (kind !== "one" || !clock || !advanceClock) return;
    // Each projection wakes the shared clock at its next deadline, including
    // an open detail whose task isn't in the list's loaded pages.
    let nextDeadline = Infinity;
    for (const task of allTasks) {
      if (task.dueDate != null && rawStatus(task) !== "completed" && rawStatus(task) !== "overdue") {
        nextDeadline = Math.min(nextDeadline, task.dueDate);
      }
    }
    // Browser timers overflow beyond the signed 32-bit millisecond limit.
    const serverNow = clock.serverTime + performance.now() - clock.receivedAt;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(nextDeadline + 1 - serverNow)));
    const timer = Number.isFinite(nextDeadline) ? window.setTimeout(advanceClock, delay) : undefined;
    return () => window.clearTimeout(timer);
  }, [allTasks, clock, kind, advanceClock]);
  return { allTasks, deadlineError: deadlineClock?.deadlineError ?? null };
}

export function TaskList({ kind, selectedId }: { kind: Kind; selectedId?: string }) {
  const { activeCompanyId, active } = useCompany();
  return <TaskListContent key={`${activeCompanyId}:${active?.membership._id}:${kind}`} kind={kind} selectedId={selectedId} />;
}

function TaskListContent({ kind, selectedId }: { kind: Kind; selectedId?: string }) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const viewToggleRef = useRef<HTMLDivElement>(null);
  const [taskView, setTaskView] = useState<TaskView>("all");
  const [frequency, setFrequency] = useState<FrequencyFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter[]>(() => kind === "one" ? manualStatuses.map((option) => option.value) : allStatusFilters);
  const [customShowOverdue, setCustomShowOverdue] = useState(false);
  const [pausedFilter, setPausedFilter] = useState(false);
  const [changingPaused, setChangingPaused] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<any | null>(null);
  const [importBanner, setImportBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [exportingSelection, setExportingSelection] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingCell, setPendingCell] = useState<string | null>(null);
  const [renderedCount, setRenderedCount] = useState(TASK_PAGE_SIZE);
  const taskPrefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const canUseAllTasks = Boolean(active?.capabilities.some((c) => c === `${taskPrefix}:view:any` || c === `${taskPrefix}:view:managed`));
  const assignableResult = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskTypeFor(kind) } : "skip") as AssignableUsersResult | undefined;
  const assignable = assignableResult?.users;
  const filterableAssignees = useQuery(api.tasks.filterableAssignees, activeCompanyId && canUseAllTasks ? { companyId: activeCompanyId } : "skip") as any[] | undefined;
  const taskType: TaskListTaskType = taskTypeFor(kind);
  const queryArgs = useMemo(
    () => (activeCompanyId ? { companyId: activeCompanyId, ...(kind === "jd" ? { paused: taskView !== "custom" && pausedFilter } : {}) } : "skip" as const),
    [activeCompanyId, kind, taskView, pausedFilter],
  );

  const {
    status: taskPageStatus,
    results: taskPageResults,
    loadMore: loadMoreTaskPage,
  } = usePaginatedQuery(
    kind === "jd" ? api.tasks.listJdRows : api.tasks.listOneTimeRows,
    queryArgs,
    { initialNumItems: TASK_PAGE_SIZE }
  );
  const tasks = taskPageStatus === "LoadingFirstPage" ? undefined : taskPageResults as TaskRow[];
  const { allTasks, deadlineError } = useTaskDeadlineRows(tasks, kind);
  const preferenceResult = useQuery(
    api.tasks.getListPreference,
    activeCompanyId ? { companyId: activeCompanyId, taskType } : "skip",
  );
  const customViewResult = useQuery(api.tasks.getCustomView, activeCompanyId ? { companyId: activeCompanyId, taskType } : "skip");
  const subscribedCustomView = useMemo<ListPreference<TaskListSort> | undefined>(() => customViewResult && ({
    sort: { mode: "custom" }, customOrder: customViewResult.orderedIds, orderFormat: "vector", revision: customViewResult.revision,
  }), [customViewResult]);
  const subscribedPreference = useMemo<ListPreference<TaskListSort> | undefined>(() => {
    if (!preferenceResult) return undefined;
    return {
      sort: preferenceResult.sort as TaskListSort,
      customOrder: preferenceResult.customOrder?.map(String) ?? null,
      revision: preferenceResult.revision,
      orderFormat: preferenceResult.orderFormat,
    };
  }, [preferenceResult]);
  const updateJdFields = useMutation(api.tasks.updateJdFields).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listJdRows, api.tasks.getJd, assignable));
  const updateOneTimeFields = useMutation(api.tasks.updateOneTimeFields).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listOneTimeRows, api.tasks.getOneTime, assignable));
  const deleteJd = useMutation(api.tasks.deleteJd).withOptimisticUpdate((localStore, args) => {
    removeFromListPages(localStore, api.tasks.listJdRows, new Set([args.taskId]));
  });
  const setJdPausedBulk = useMutation(api.tasks.setJdPausedBulk);
  const deleteJdBulk = useMutation(api.tasks.deleteJdBulk).withOptimisticUpdate((localStore, args) => {
    removeFromListPages(localStore, api.tasks.listJdRows, new Set(args.taskIds));
  });
  const deleteOneTime = useMutation(api.tasks.deleteOneTime).withOptimisticUpdate((localStore, args) => {
    removeFromListPages(localStore, api.tasks.listOneTimeRows, new Set([args.taskId]));
  });
  const deleteOneTimeBulk = useMutation(api.tasks.deleteOneTimeBulk).withOptimisticUpdate((localStore, args) => {
    removeFromListPages(localStore, api.tasks.listOneTimeRows, new Set(args.taskIds));
  });
  const setListSort = useMutation(api.tasks.setListSort);
  const saveListOrder = useMutation(api.tasks.saveListOrder);
  const saveCustomView = useMutation(api.tasks.saveCustomView);
  const [customViewController] = useState(() => new ListPreferenceController<TaskListSort>(async (command) => {
    if (!activeCompanyId || !command.orderedIds) throw new Error("No custom order to save.");
    const saved = await saveCustomView({ companyId: activeCompanyId, taskType, orderedIds: command.orderedIds, expectedRevision: command.expectedRevision });
    return { sort: { mode: "custom" }, customOrder: saved.orderedIds, orderFormat: "vector", revision: saved.revision };
  }, taskListPreferenceMessages));
  const customViewState = useSyncExternalStore(customViewController.subscribe, customViewController.getSnapshot, customViewController.getSnapshot);
  const [preferenceController] = useState(() => new ListPreferenceController<TaskListSort>(async (command) => {
    if (!activeCompanyId) throw new Error("No active company.");
    const args = { companyId: activeCompanyId, taskType, expectedRevision: command.expectedRevision };
    const saved = command.orderedIds !== undefined
      ? await saveListOrder({ ...args, orderedIds: command.orderedIds })
      : await setListSort({ ...args, sort: command.sort });
    return {
      sort: saved.sort as TaskListSort,
      customOrder: saved.customOrder?.map(String) ?? null,
      orderFormat: saved.orderFormat,
      revision: saved.revision,
    };
  }, taskListPreferenceMessages));
  const preferenceState = useSyncExternalStore(preferenceController.subscribe, preferenceController.getSnapshot, preferenceController.getSnapshot);
  const preferencePending = preferenceState.pending;
  useLayoutEffect(() => {
    if (subscribedPreference) preferenceController.receive(subscribedPreference);
  }, [preferenceController, subscribedPreference]);
  useLayoutEffect(() => {
    if (subscribedCustomView) customViewController.receive(subscribedCustomView);
  }, [customViewController, subscribedCustomView]);
  useEffect(() => () => { preferenceController.cancel(); customViewController.cancel(); }, [preferenceController, customViewController]);
  useEffect(() => {
    if (preferenceState.error || customViewState.error) setInlineError(preferenceState.error ?? customViewState.error);
  }, [preferenceState.error, customViewState.error]);
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";
  const pageTitle = kind === "jd" ? "Job Description" : "Tasks";
  const description = kind === "jd" ? "Track and manage recurring responsibilities and scheduled duties." : "Track and manage assignments, action items, and upcoming deadlines.";
  const canCreate = canCreateTasks(active, kind);
  const canImport = canImportTasks(active, kind);
  const canExport = canExportTasks(active, kind);
  const frequencyFilterActive = kind === "jd" && frequency !== "all";
  const priorityFilterActive = kind === "one" && priorityFilter !== "all";
  const effectiveTaskView: TaskView = taskView === "custom" ? "custom" : canUseAllTasks ? taskView : "my";
  const isCustomView = effectiveTaskView === "custom";
  const currentMembershipId = active?.membership._id as string | undefined;
  const preferenceScope = `${activeCompanyId ?? "none"}:${active?.membership._id ?? "none"}:${taskType}`;
  const activePreference = preferenceState.preference ?? subscribedPreference;
  const activeSort = useMemo<TaskListSort>(
    () => activePreference?.sort ?? { mode: "default" },
    [activePreference?.sort],
  );
  const taskOrderKeys = useMemo(() => {
    const keys = new Map<string, string>();
    if (activePreference?.orderFormat === "vector") return keys;
    for (const task of allTasks) {
      if (task.customOrderKey) keys.set(task._id, task.customOrderKey);
    }
    return keys;
  }, [allTasks, activePreference?.orderFormat]);
  const dataReady = Boolean(activeCompanyId && subscribedPreference && (!isCustomView || subscribedCustomView) && taskPageStatus === "Exhausted");
  const customOrderingEnabled = dataReady && (isCustomView ? allTasks.filter((task) => taskHasAssignee(task, currentMembershipId)).length : allTasks.length) <= TASK_LIST_ORDER_LIMIT;
  const showAssigneeColumn = canUseAllTasks && effectiveTaskView === "all";
  const showFrequencyColumn = kind === "jd" && (isCustomView || !frequencyFilterActive);
  const showPriorityColumn = kind === "one" && (isCustomView || !priorityFilterActive);
  const orderedTasks = useMemo(() => {
    if (isCustomView) {
      const ownTasks = allTasks.filter((task) => taskHasAssignee(task, currentMembershipId));
      return restoreListCustomOrder(ownTasks, (customViewState.preference ?? subscribedCustomView)?.customOrder, sortTaskListRows(ownTasks, taskType, { mode: "default" }));
    }
    if (activeSort.mode === "custom") {
      return restoreTaskListCustomOrder(allTasks, taskType, activePreference?.customOrder, taskOrderKeys);
    }
    return sortTaskListRows(allTasks, taskType, activeSort);
  }, [activePreference?.customOrder, activeSort, allTasks, currentMembershipId, customViewState.preference, isCustomView, subscribedCustomView, taskOrderKeys, taskType]);
  const filteredTasks = useMemo(() => (
    orderedTasks.filter((task) => {
      if (kind === "jd" && (task.pausedAt !== undefined) !== (!isCustomView && pausedFilter)) return false;
      if (isCustomView) return kind !== "one" || customShowOverdue || !statusMatches(task, ["overdue"]);
      const needle = search.trim().toLowerCase();
      if (needle && !task.title.toLowerCase().includes(needle) && !task.reference.toLowerCase().includes(needle)) return false;
      if (effectiveTaskView === "my" && !taskHasAssignee(task, currentMembershipId)) return false;
      if (kind === "jd" && frequency !== "all" && task.recurrence !== frequency) return false;
      if (!(kind === "jd" && pausedFilter) && !statusMatches(task, statusFilter)) return false;
      if (kind === "one" && priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (assigneeFilter !== "all" && !taskHasAssignee(task, assigneeFilter)) return false;
      return true;
    })
  ), [assigneeFilter, currentMembershipId, customShowOverdue, effectiveTaskView, frequency, isCustomView, kind, orderedTasks, pausedFilter, priorityFilter, search, statusFilter]);
  const displayedTasks = filteredTasks;
  const renderedTasks = useMemo(() => displayedTasks.slice(0, renderedCount), [displayedTasks, renderedCount]);
  const visibleIds = useMemo(() => renderedTasks.filter((task) => !isPendingTask(task)).map((task) => task._id), [renderedTasks]);
  const selectedVisibleCount = visibleIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectionCount = selectedIds.size;
  const canDeleteSelection = selectionCount > 0 && !deleting && Array.from(selectedIds).every((id) => canDeleteTaskRow(active, kind, allTasks.find((task) => task._id === id)));
  const selection = allTasks.filter((task) => selectedIds.has(task._id));
  const lifecycleAction = kind === "jd" && selectionCount > 0 && selection.length === selectionCount
    ? selection.every((task) => task.pausedAt === undefined && task.canPause) ? "pause"
      : selection.every((task) => task.pausedAt !== undefined && task.canResume) ? "resume" : null
    : null;
  const selectedTaskId = selectionCount === 1 ? Array.from(selectedIds)[0] : null;
  const selectedTask = selectedTaskId ? allTasks.find((task) => task._id === selectedTaskId) ?? null : null;
  const canEditSelectedTask = Boolean(selectedTask && canEditTaskRow(active, kind, selectedTask));
  // The rendered window grows independently of page exhaustion so streamed-in
  // pages become visible as they arrive.
  const hasMoreRenderedTasks = renderedTasks.length < displayedTasks.length;
  const dragDisabled = !customOrderingEnabled || (isCustomView ? customViewState.sorting : preferenceState.sorting);
  const taskDragWrapperRef = useRef<HTMLDivElement>(null);
  const taskDragBodyRef = useRef<HTMLTableSectionElement>(null);
  const dragSessionKey = useMemo(
    () => JSON.stringify([
      preferenceScope, preferenceState.dragVersion, customViewState.dragVersion, search, effectiveTaskView, frequency,
      priorityFilter, statusFilter, assigneeFilter,
      filteredTasks.map((task) => task._id), orderedTasks.map((task) => task._id),
    ]),
    [preferenceScope, preferenceState.dragVersion, customViewState.dragVersion, search, effectiveTaskView, frequency, priorityFilter, statusFilter, assigneeFilter, filteredTasks, orderedTasks],
  );
  const drag = useListDrag({
    ids: visibleIds,
    sessionKey: dragSessionKey,
    disabled: dragDisabled,
    wrapperRef: taskDragWrapperRef,
    bodyRef: taskDragBodyRef,
    onDrop(sourceId, insertion) {
      const visible = filteredTasks.filter((task) => !isPendingTask(task)).map((task) => task._id);
      const nextVisible = insertListItem(visible, sourceId, insertion);
      if (sameListOrder(visible, nextVisible)) return;
      if (isCustomView) {
        const baseline = orderedTasks.filter((task) => !isPendingTask(task)).map((task) => task._id);
        customViewController.saveOrder(mergeFilteredListOrder(baseline, visible, nextVisible));
      } else {
        const baseline = restoreTaskListCustomOrder(allTasks.filter((task) => !isPendingTask(task)), taskType, activePreference?.customOrder, taskOrderKeys).map((task) => task._id);
        preferenceController.saveOrder(mergeFilteredListOrder(baseline, visible, nextVisible));
      }
    },
  });

  useEffect(() => {
    if (!activeCompanyId) return;
    setTaskView(canUseAllTasks ? "all" : "my");
    setAssigneeFilter("all");
  }, [activeCompanyId, canUseAllTasks]);

  useEffect(() => {
    if (effectiveTaskView === "my" && assigneeFilter !== "all") setAssigneeFilter("all");
  }, [effectiveTaskView, assigneeFilter]);

  const { syncToggleScrollState } = useTaskRailAutoScroll({
    railRef: viewToggleRef,
    activeCompanyId,
    canUseAllTasks,
    effectiveTaskView,
  });

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (taskPageStatus === "CanLoadMore") loadMoreTaskPage(TASK_PAGE_SIZE);
  }, [loadMoreTaskPage, taskPageStatus]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMoreRenderedTasks || drag.active) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderedCount((current) => Math.min(current + TASK_PAGE_SIZE, displayedTasks.length));
        }
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [displayedTasks.length, hasMoreRenderedTasks, drag.active]);

  useEffect(() => {
    if (tasks && selectedIds.size > 0) {
      const valid = new Set<string>();
      const known = new Set(allTasks.map((task) => task._id));
      for (const id of selectedIds) if (known.has(id)) valid.add(id);
      if (valid.size !== selectedIds.size) setSelectedIds(valid);
    }
  }, [allTasks, selectedIds, tasks]);

  useEffect(() => {
    if (!createOpen) return;
    if (selectionCount === 0) return;
    setSelectedIds(new Set());
    setDeleteError(null);
  }, [createOpen, selectionCount]);

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDeleteError(null);
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      if (allVisibleSelected) {
        const next = new Set(current);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(current);
      for (const id of visibleIds) next.add(id);
      return next;
    });
    setDeleteError(null);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setDeleteError(null);
  }

  function handleEditSelection() {
    if (!selectedTask || !canEditSelectedTask) return;
    setEditingTask(selectedTask);
    setEditOpen(true);
  }

  function handleEditOpenChange(open: boolean) {
    setEditOpen(open);
    if (!open) {
      setEditingTask(null);
    }
  }

  async function handlePausedSelection() {
    if (!activeCompanyId || !lifecycleAction || changingPaused) return;
    setChangingPaused(true);
    setDeleteError(null);
    const ids = new Set(selectedIds);
    try {
      await setJdPausedBulk({ companyId: activeCompanyId, taskIds: Array.from(ids) as Id<"jdTasks">[], paused: lifecycleAction === "pause" });
      setSelectedIds((current) => new Set(Array.from(current).filter((id) => !ids.has(id))));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not change the selected tasks.");
    } finally {
      setChangingPaused(false);
    }
  }

  async function handleDeleteSelection() {
    if (!activeCompanyId || deleting || selectionCount === 0) return;
    setDeleting(true);
    setDeleteError(null);
    const ids = Array.from(selectedIds);
    try {
      if (kind === "jd") {
        if (ids.length === 1) await deleteJd({ companyId: activeCompanyId, taskId: ids[0] as Id<"jdTasks"> });
        else await deleteJdBulk({ companyId: activeCompanyId, taskIds: ids as Id<"jdTasks">[] });
      } else {
        if (ids.length === 1) await deleteOneTime({ companyId: activeCompanyId, taskId: ids[0] as Id<"oneTimeTasks"> });
        else await deleteOneTimeBulk({ companyId: activeCompanyId, taskIds: ids as Id<"oneTimeTasks">[] });
      }
      setSelectedIds(new Set());
    } catch (err) {
      // The optimistic rollback restores the rows; merge the deleted IDs back
      // so the failed delete can be retried without discarding rows the user
      // selected while the request was in flight.
      setSelectedIds((current) => new Set([...current, ...ids]));
      setDeleteError(err instanceof Error ? err.message : "Could not delete the selected tasks.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleExportSelection() {
    if (!activeCompanyId || !active || selectedIds.size === 0 || !tasks || exportingSelection) return;
    setExportingSelection(true);
    try {
      const selectedTasks = tasks.filter((t: any) => selectedIds.has(t._id));
      const exportTasks = selectedTasks.map((t: any) => ({
        reference: t.reference,
        title: t.title,
        description: t.description ?? null,
        notes: t.notes ?? null,
        recurrence: kind === "jd" ? t.recurrence : undefined,
        dueDate: kind === "one" ? (t.dueDate ?? null) : undefined,
        priority: kind === "one" ? t.priority : undefined,
        time: t.time ?? null,
        quantity: t.quantity ?? null,
        assigneeEmails: t.assignees?.map((a: any) => a.user.email).join("; ") ?? "",
        isActive: kind === "jd" ? t.pausedAt === undefined : undefined,
        evidenceRequired: t.evidenceRequired === true,
      }));
      const { exportTaskWorkbook, downloadBlob } = await loadWorkbook();
      const workbook = await exportTaskWorkbook(
        kind === "jd" ? "jd" : "one_time",
        activeCompanyId,
        active.company.name,
        exportTasks as any
      );
      downloadBlob(
        await workbook.toBlob(),
        `${kind === "jd" ? "jd-tasks" : "one-time-tasks"}-selected.xlsx`
      );
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not export selected tasks.");
    } finally {
      setExportingSelection(false);
    }
  }

  const openTaskDetails = useCallback((task: TaskRow) => {
    // Seed the drawer preview so it paints before the detail query resolves.
    seedDetailPreview(`task:${activeCompanyId}:${kind}:${active?.membership._id}`, task._id, task);
    router.push(`${base}/${task._id}`);
  }, [activeCompanyId, active?.membership._id, base, kind, router]);

  const saveInline = useCallback(async (task: any, patch: Partial<TaskFormValues>, label: string) => {
    if (!activeCompanyId) return false;
    const key = `${task._id}:${label}`;
    setPendingCell(key);
    setInlineError(null);
    const timer = startInteraction(`task.${label}`);
    timer.paint();
    try {
      // Send only the edited field so one cell save does not rewrite the row.
      const fields: Record<string, unknown> = {};
      if (patch.title !== undefined) fields.title = patch.title.trim();
      if (patch.description !== undefined) fields.description = patch.description;
      if (patch.notes !== undefined) fields.notes = patch.notes;
      if (patch.time !== undefined) fields.time = patch.time;
      if (patch.quantity !== undefined) fields.quantity = quantityFromInput(patch.quantity) ?? null;
      if (patch.assigneeMembershipIds !== undefined) fields.assigneeMembershipIds = patch.assigneeMembershipIds;
      if (kind === "jd") {
        if (patch.recurrence !== undefined) fields.recurrence = patch.recurrence;
        await updateJdFields({ companyId: activeCompanyId, taskId: task._id as Id<"jdTasks">, ...fields } as any);
      } else {
        if (patch.dueDate !== undefined) fields.dueDate = patch.dueDate.trim() ? (fromDateInput(patch.dueDate) ?? null) : null;
        if (patch.priority !== undefined) fields.priority = patch.priority;
        await updateOneTimeFields({ companyId: activeCompanyId, taskId: task._id as Id<"oneTimeTasks">, ...fields } as any);
      }
      timer.ack();
      return true;
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : "Could not update the task.");
      return false;
    } finally {
      setPendingCell((current) => current === key ? null : current);
    }
  }, [activeCompanyId, kind, updateJdFields, updateOneTimeFields]);

  function selectCustomView() {
    setSelectedIds(new Set());
    setTaskView("custom");
  }

  function selectTaskSortField(field: TaskListSortField) {
    const direction = taskSortDirectionForField(taskType, activeSort, field);
    const nextSort: TaskListSort = {
      mode: "field",
      field,
      direction: direction === null
        ? initialTaskListSortDirection(field)
        : direction === "asc" ? "desc" : "asc",
    };
    if (dataReady && !isCustomView) preferenceController.saveSort(nextSort);
  }

  const jdColumns = 5 + (showFrequencyColumn ? 1 : 0) + (showAssigneeColumn ? 1 : 0); // reference + title + optional frequency + optional assignee + status + time + quantity
  const oneColumns = 5 + (showPriorityColumn ? 1 : 0) + (showAssigneeColumn ? 1 : 0); // reference + title + optional priority + optional assignee + status + date assigned + due
  const filterCount = isCustomView ? Number(kind === "one" && !customShowOverdue) : [kind === "jd" && pausedFilter, !pausedFilter && statusFilter.length !== allStatusFilters.length, kind === "jd" ? frequency !== "all" : priorityFilter !== "all", assigneeFilter !== "all"].filter(Boolean).length;
  const hasOnlyDefaultStatusFilter = kind === "one" && filterCount === 1 && search.trim() === "" && statusFilter.length === manualStatuses.length && manualStatuses.every((option) => statusFilter.includes(option.value));
  const hasActiveFilters = isCustomView ? filterCount > 0 && orderedTasks.length > 0 : (filterCount > 0 || search.trim() !== "") && (allTasks.length > 0 || !hasOnlyDefaultStatusFilter);
  const hasHiddenOverdueTasks = !isCustomView && hasOnlyDefaultStatusFilter && orderedTasks.some((task) => rawStatus(task) === "overdue" && (effectiveTaskView !== "my" || taskHasAssignee(task, currentMembershipId)));

  return (
    <div>
      <PageHeader
        title={pageTitle}
        description={description}
      />

      <TaskDialog kind={kind} mode="create" open={createOpen} onOpenChange={setCreateOpen} assignable={assignable ?? []} assignableIsTruncated={assignableResult?.isTruncated ?? false} onUploadError={setInlineError} />
      {editingTask && (
        <TaskDialog
          key={editingTask._id}
          kind={kind}
          mode="edit"
          open={editOpen}
          onOpenChange={handleEditOpenChange}
          task={editingTask}
          assignable={assignable ?? []}
          assignableIsTruncated={assignableResult?.isTruncated ?? false}
          onUploadError={setInlineError}
        />
      )}

      <div className="mb-3 flex flex-col items-stretch gap-2 md:flex-row md:flex-nowrap md:items-center">
        <TaskRail
          railRef={viewToggleRef}
          onScroll={syncToggleScrollState}
        >
          {kind === "jd" ? (
            <>
              <button type="button" className="task-view-button" data-active={!isCustomView && (!canUseAllTasks || effectiveTaskView === "all")} onClick={() => { setFrequency("all"); setTaskView(canUseAllTasks ? "all" : "my"); setAssigneeFilter("all"); }}>
                <StarIcon className="h-4 w-4" />All Tasks
              </button>
              {canUseAllTasks && (
                <button type="button" className="task-view-button" data-active={!isCustomView && effectiveTaskView === "my"} onClick={() => { setFrequency("all"); setTaskView("my"); setAssigneeFilter("all"); }}>
                  <User className="h-4 w-4" />My Tasks
                </button>
              )}
              <button type="button" className="task-view-button" data-active={isCustomView} onClick={selectCustomView}>
                <ListOrdered className="h-4 w-4" aria-hidden="true" />Custom
              </button>
            </>
          ) : (
            <>
              <button type="button" className="task-view-button" data-active={!isCustomView && (!canUseAllTasks || effectiveTaskView === "all")} onClick={() => { setPriorityFilter("all"); setTaskView(canUseAllTasks ? "all" : "my"); setAssigneeFilter("all"); }}>
                <StarIcon className="h-4 w-4" />All Tasks
              </button>
              {canUseAllTasks && (
                <button type="button" className="task-view-button" data-active={!isCustomView && effectiveTaskView === "my"} onClick={() => { setPriorityFilter("all"); setTaskView("my"); setAssigneeFilter("all"); }}>
                  <User className="h-4 w-4" />My Tasks
                </button>
              )}
              <button type="button" className="task-view-button" data-active={isCustomView} onClick={selectCustomView}>
                <ListOrdered className="h-4 w-4" aria-hidden="true" />Custom
              </button>
            </>
          )}
        </TaskRail>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 md:flex-nowrap md:ml-auto">
          {!isCustomView && <div className="task-search-control" data-open={searchOpen || search.trim() !== ""}>
            <Input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} className="task-search-input border-none focus:border-none bg-transparent" placeholder="Search title or code" aria-label="Search tasks by title or code" tabIndex={searchOpen || search.trim() !== "" ? 0 : -1} />
            <button type="button" className="task-search-button" aria-label={search ? "Clear search" : "Search tasks"} onClick={() => { if (search) setSearch(""); else setSearchOpen((open) => !open); }}>
              {search ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </div>}
          {(!isCustomView || kind === "one") && <TaskFilterMenu
            kind={kind}
            statusFilter={statusFilter}
            custom={isCustomView}
            showOverdue={customShowOverdue}
            onShowOverdueChange={setCustomShowOverdue}
            frequency={frequency}
            priorityFilter={priorityFilter}
            assigneeFilter={assigneeFilter}
            assignees={filterableAssignees ?? []}
            showAssigneeFilter={showAssigneeColumn}
            paused={kind === "jd" && pausedFilter}
            onPausedChange={setPausedFilter}
            activeCount={filterCount}
            onStatusChange={setStatusFilter}
            onFrequencyChange={setFrequency}
            onPriorityChange={setPriorityFilter}
            onAssigneeChange={setAssigneeFilter}
          />}
          {(canImport || canExport) && (
            <TaskImportExportMenu kind={kind} onNotification={(notif) => setImportBanner(notif)} />
          )}
          {canCreate && <Button variant="primary" size="sm" className="whitespace-nowrap" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />New task</Button>}
        </div>
      </div>

      {importBanner && (
        <div
          className={cn(
            "mb-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]",
            importBanner.type === "success"
              ? "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)] border border-[var(--badge-green-fg)]/20"
              : "alert-error"
          )}
          role="alert"
        >
          <span>{importBanner.message}</span>
          <button
            type="button"
            className="task-icon-btn h-6 w-6"
            onClick={() => setImportBanner(null)}
            aria-label="Dismiss import message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {deadlineError && <p className="alert-error mb-3 rounded-lg px-3 py-2 text-[13px]" role="alert">{deadlineError}</p>}

      {inlineError && (
        <div className="alert-error mb-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]" role="alert">
          <span>{inlineError}</span>
          <button type="button" className="task-icon-btn h-6 w-6" onClick={() => setInlineError(null)} aria-label="Dismiss inline edit error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="relative">
        {selectionCount > 0 && (
          <div className="task-selection-layer">
            <div className="task-selection-pill" role="status" aria-live="polite">
              <span className="task-selection-pill-count">{selectionCount} selected</span>
              <span className="task-selection-pill-divider" aria-hidden="true" />
              <button type="button" className="task-selection-pill-btn" onClick={clearSelection} disabled={deleting || exportingSelection} aria-label="Cancel selection" data-tooltip="Cancel selection">
                <X className="h-4 w-4" />
              </button>
              {selectionCount === 1 && canEditSelectedTask && (
                <>
                  <span className="task-selection-pill-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="task-selection-pill-btn"
                    onClick={handleEditSelection}
                    disabled={deleting || exportingSelection}
                    aria-label="Edit selected task"
                    data-tooltip="Edit selected"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </>
              )}
              {lifecycleAction && (
                <>
                  <span className="task-selection-pill-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="task-selection-pill-btn"
                    onClick={() => void handlePausedSelection()}
                    disabled={changingPaused || deleting || exportingSelection || selectionCount > 100}
                    aria-label={`${lifecycleAction === "pause" ? "Make inactive" : "Make active"}${selectionCount > 100 ? " (select at most 100 tasks at once)" : ""}`}
                    data-tooltip={selectionCount > 100 ? "Select at most 100 tasks at once" : lifecycleAction === "pause" ? "Make inactive" : "Make active"}
                  >
                    {lifecycleAction === "pause" ? <CirclePause className="h-4 w-4" /> : <CirclePlay className="h-4 w-4" />}
                  </button>
                </>
              )}
              {canExport && (
                <>
                  <span className="task-selection-pill-divider" aria-hidden="true" />
                  <button type="button" className="task-selection-pill-btn" onClick={() => void handleExportSelection()} disabled={exportingSelection || deleting} aria-label={selectionCount === 1 ? "Export selected task" : `Export ${selectionCount} selected tasks`} data-tooltip="Export selected">
                    <Download className="h-4 w-4" />
                  </button>
                </>
              )}
              <span className="task-selection-pill-divider" aria-hidden="true" />
              <button type="button" className="task-selection-pill-btn" data-danger="true" onClick={handleDeleteSelection} disabled={!canDeleteSelection || deleting || exportingSelection} aria-label={selectionCount === 1 ? "Delete selected task" : `Delete ${selectionCount} selected tasks`} data-tooltip="Delete selected">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {deleteError && <p className="alert-error task-selection-error" role="alert">{deleteError}</p>}
          </div>
        )}

        <div ref={taskDragWrapperRef} className="list-rail-gutter relative">
        <DragDropProvider
          onBeforeDragStart={drag.onBeforeDragStart}
          onDragMove={drag.onDragMove}
          onDragOver={drag.onDragOver}
          onDragEnd={drag.onDragEnd}
        >
        <div className="task-table-wrap task-list-table-wrap">
        <table className="task-table">
          <thead>
            {kind === "jd" ? (
              <tr>
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "code")} label="CODE" icon={<Hash className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("code")} className="w-[92px] whitespace-nowrap" />
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "title")} label="TITLE" icon={<TaskIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("title")} className="min-w-[200px] max-w-[250px]" />
                {showFrequencyColumn && <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "frequency")} label="FREQUENCY" icon={<FrequencyIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("frequency")} />}
                {showAssigneeColumn && <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "user")} label="ASSIGNED TO" icon={<UsersIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("user")} />}
                <th><span className="inline-flex items-center gap-1.5"><StatusIcon className="h-3.5 w-3.5" />STATUS</span></th>
                <th><span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />TIME</span></th>
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "quantity")} label="QUANTITY" icon={<QuantityIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("quantity")} />
              </tr>
            ) : (
              <tr>
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "code")} label="CODE" icon={<Hash className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("code")} className="w-[92px] whitespace-nowrap" />
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "title")} label="TITLE" icon={<TaskIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("title")} className="min-w-[200px] max-w-[250px]" />
                {showPriorityColumn && <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "priority")} label="PRIORITY" icon={<Tag className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("priority")} />}
                {showAssigneeColumn && <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "user")} label="ASSIGNED TO" icon={<UsersIcon className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("user")} />}
                <th><span className="inline-flex items-center gap-1.5"><StatusIcon className="h-3.5 w-3.5" />STATUS</span></th>
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "dateAssigned")} label="DATE ASSIGNED" icon={<CalendarClock className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("dateAssigned")} />
                <TaskColumnHeader custom={isCustomView} {...taskSortDirections(taskType, activeSort, "dueDate")} label="DUE DATE" icon={<CalendarDays className="h-3.5 w-3.5" />} disabled={!dataReady || preferencePending} onSelect={() => selectTaskSortField("dueDate")} />
              </tr>
            )}
          </thead>
          <tbody ref={taskDragBodyRef}>
            {tasks === undefined || !subscribedPreference || (isCustomView && !subscribedCustomView) ? (
              Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skel-${index}`}>
                  <td colSpan={kind === "jd" ? jdColumns : oneColumns} className="pl-4">
                    <div className="flex items-center gap-3">
                      <div className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-[var(--surface-muted)]" />
                      <div className="h-3 w-2/5 animate-pulse rounded bg-[var(--surface-muted)]" />
                    </div>
                  </td>
                </tr>
              ))
            ) : renderedTasks.length === 0 ? (
              <tr>
                <td colSpan={kind === "jd" ? jdColumns : oneColumns} className="!h-auto py-2">
                  {!dataReady ? (
                    <div className="py-4 text-center text-[13px] text-[var(--ink-muted)]">Loading tasks…</div>
                  ) : (
                  <div className="task-empty">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><Inbox className="h-5 w-5" /></span>
                    <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{!hasActiveFilters && (isCustomView || allTasks.length === 0) ? "No tasks yet" : "No matching tasks"}</div>
                    {(!isCustomView || hasActiveFilters) && <p className="mt-1 max-w-[280px] text-[13px] text-[var(--ink-muted)]">{isCustomView ? "Try showing overdue tasks." : hasHiddenOverdueTasks ? "Overdue tasks are hidden by default. Select Overdue in the status filter or clear filters to show them." : !hasActiveFilters && allTasks.length === 0 ? "Create your first task to get started." : "Try adjusting your search or filters."}</p>}
                    {canCreate && !hasActiveFilters && (isCustomView || allTasks.length === 0) && (
                      <Button className="mt-4" size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                        <Plus className="h-3.5 w-3.5" />New task
                      </Button>
                    )}
                    {hasActiveFilters && (
                      <Button className="mt-4" size="sm" variant="ghost" onClick={() => { if (isCustomView) { setCustomShowOverdue(true); return; } setSearch(""); setSearchOpen(false); setStatusFilter(allStatusFilters); setPausedFilter(false); setFrequency("all"); setPriorityFilter("all"); setAssigneeFilter("all"); }}>{isCustomView ? "Show overdue tasks" : "Clear filters"}</Button>
                    )}
                  </div>
                  )}
                </td>
              </tr>
            ) : (
              <>
                {renderedTasks.map((task, index) => (
                  <TaskTableRow
                    key={task._id}
                    task={task}
                    index={index}
                    kind={kind}
                    scope={preferenceScope}
                    dragDisabled={dragDisabled}
                    checked={selectedIds.has(task._id)}
                    selected={task._id === selectedId}
                    rowCanEdit={canEditTaskRow(active, kind, task)}
                    drag={drag}
                    pendingCell={pendingCell?.startsWith(`${task._id}:`) ? pendingCell : null}
                    assignable={assignable}
                    showAssigneeColumn={showAssigneeColumn}
                    showFrequencyColumn={showFrequencyColumn}
                    showPriorityColumn={showPriorityColumn}
                    onOpenDetails={openTaskDetails}
                    onSaveInline={saveInline}
                  />
                ))}
                {canCreate && (
                  <tr className="task-add-row">
                    <td colSpan={kind === "jd" ? jdColumns : oneColumns}>
                      <button type="button" className="task-add-label inline-flex items-center gap-1.5" onClick={() => setCreateOpen(true)}>
                        <Plus className="h-3.5 w-3.5" />New task
                      </button>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
        </div>
        {renderedTasks.length > 0 && (
          <div className="task-checkbox-rail pointer-events-none absolute left-0 top-0 z-10 w-14 pr-2">
            <div className="task-list-rail-row pointer-events-auto flex h-9 items-center justify-end" data-active={selectionCount > 0 ? "true" : undefined}>
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onCheckedChange={toggleAllVisible}
                aria-label={allVisibleSelected ? "Unselect all rendered tasks" : "Select all rendered tasks"}
                className="task-list-rail-control"
              />
            </div>
            {renderedTasks.map((task) => {
              const isChecked = selectedIds.has(task._id);
              const isPending = isPendingTask(task);
              return (
                <ListDragRailRow
                  key={`rail-${task._id}`}
                  id={task._id}
                  label={`Reorder ${task.reference}: ${task.title}`}
                  disabled={dragDisabled || isPending}
                  disabledReason={isPending ? "Task is still saving" : undefined}
                  checked={isChecked}
                  drag={drag}
                >
                  <Checkbox
                    className="task-list-rail-control"
                    checked={isChecked}
                    disabled={isPending}
                    onCheckedChange={() => toggleOne(task._id)}
                    aria-label={isPending ? `${task.title} is still saving` : isChecked ? `Unselect ${task.title}` : `Select ${task.title}`}
                  />
                </ListDragRailRow>
              );
            })}
          </div>
        )}
        <ListDragOverlay table={drag.overlay} dropAnimation={drag.dropAnimation} />
        </DragDropProvider>
        </div>
        <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center py-2" aria-live="polite">
          {!dataReady && <span className="text-[12px] text-[var(--ink-muted)]">Loading all tasks…</span>}
          {hasMoreRenderedTasks && (
            <Button size="sm" variant="ghost" onClick={() => setRenderedCount((current) => Math.min(current + TASK_PAGE_SIZE, displayedTasks.length))}>Load more tasks</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EditableTaskText({ value, placeholder, ariaLabel, canEdit, required = false, variant, onSave }: { value: string; placeholder: string; ariaLabel: string; canEdit: boolean; required?: boolean; variant: "title" | "description"; onSave: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestValueRef = useRef(value);
  const draftRef = useRef(value);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => {
    latestValueRef.current = value;
    if (value.trim() === lastSentRef.current) lastSentRef.current = null;
    if (!focused && !savingRef.current) setDraft(value);
  }, [focused, value]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const persist = useCallback(async function persistCurrent() {
    if (!canEdit) return;
    const next = draftRef.current.trim();
    if (required && !next) {
      setSaveState("error");
      setError("Title is required.");
      return;
    }
    if (next === latestValueRef.current.trim() || next === lastSentRef.current) return;
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }

    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    const saved = await onSave(next);
    savingRef.current = false;

    if (!saved) {
      lastSentRef.current = null;
      queuedRef.current = false;
      setDraft(latestValueRef.current);
      setSaveState("error");
      setError("Could not save.");
      return;
    }

    lastSentRef.current = next;
    setSaveState("saved");
    window.setTimeout(() => setSaveState((current) => current === "saved" ? "idle" : current), 1200);
    if (queuedRef.current || draftRef.current.trim() !== next) {
      queuedRef.current = false;
      void persistCurrent();
    }
  }, [canEdit, onSave, required]);

  useEffect(() => {
    if (!canEdit || draft.trim() === latestValueRef.current.trim()) return;
    const timer = window.setTimeout(() => { void persist(); }, 800);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft, persist]);

  if (!canEdit) {
    if (variant === "title") return <h1 className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-[var(--ink)]">{value}</h1>;
    return value ? <p className="whitespace-pre-wrap text-[14px] leading-7 text-[var(--ink-secondary)]">{value}</p> : <p className="text-[14px] leading-7 text-[var(--ink-faint)]">{placeholder}</p>;
  }

  return (
    <div className="task-detail-editable-wrap">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        data-editable="true"
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); void persist(); }}
        onChange={(event) => { setDraft(event.target.value); setError(null); if (saveState === "error") setSaveState("idle"); }}
        onKeyDown={(event) => {
          if (variant === "title" && event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setDraft(latestValueRef.current); setError(null); setSaveState("idle"); event.currentTarget.blur(); }
        }}
        className={cn("task-detail-editable", variant === "title" ? "task-detail-editable-title" : "task-detail-editable-description")}
      />
      {(saveState === "saving" || saveState === "saved" || error) && (
        <div className="task-detail-save-state" data-error={error ? "true" : undefined} aria-live="polite">
          {error ?? (saveState === "saving" ? "Saving..." : "Saved")}
        </div>
      )}
    </div>
  );
}

function TaskDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="peek-bar"><div className="h-7 w-28 rounded bg-[var(--surface-muted)]" /></div>
      <div className="h-7 w-2/3 rounded bg-[var(--surface-muted)]" />
      <div className="mt-2 h-3 w-44 rounded bg-[var(--surface-muted)]" />
      <div className="mt-5 h-6 w-24 rounded bg-[var(--surface-muted)]" />
      <div className="mt-7 space-y-1.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex justify-between rounded-md py-2.5">
            <div className="h-3 w-24 rounded bg-[var(--surface-muted)]" />
            <div className="h-3 w-32 rounded bg-[var(--surface-muted)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PropertyRow({ icon, label, children, muted = false }: { icon: React.ReactNode; label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="prop-row">
      <span className="prop-label">
        <span className="grid h-4 w-4 place-items-center">{icon}</span>
        {label}
      </span>
      <div className={cn("prop-value", muted && "prop-value--muted")}>{children}</div>
    </div>
  );
}

function InlinePropertyText({ value, placeholder = "—", ariaLabel, onSave, inputMode = "text", pending = false }: { value: string; placeholder?: string; ariaLabel: string; onSave: (value: string) => Promise<boolean>; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; pending?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const savingRef = useRef(false);

  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);

  async function commit() {
    if (savingRef.current) return;
    const next = draft.trim();
    if (next === value.trim()) { setEditing(false); return; }
    savingRef.current = true;
    const saved = await onSave(next);
    savingRef.current = false;
    if (saved) setEditing(false);
    else setDraft(value);
  }

  if (editing) {
    return (
      <input
        aria-label={ariaLabel}
        autoFocus
        disabled={pending}
        inputMode={inputMode}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className="prop-inline-input"
      />
    );
  }

  return (
    <button type="button" disabled={pending} className={cn("prop-inline-text", pending && "opacity-60")} onClick={() => setEditing(true)}>
      <span className={cn("truncate", !value && "text-[var(--ink-faint)]")}>{value || placeholder}</span>
    </button>
  );
}

function AttachmentList({ attachments, pendingUploads = [], canDelete, onDelete }: { attachments: any[]; pendingUploads?: { key: string; name: string; size: number }[]; canDelete: boolean | ((attachment: any) => boolean); onDelete: (id: Id<"taskAttachments">) => void }) {
  if (attachments.length === 0 && pendingUploads.length === 0) return <div className="text-[13px] text-[var(--ink-faint)]">No attachments.</div>;
  return (
    <div className="grid gap-1.5">
      {pendingUploads.map((item) => (
        <div key={item.key} className="task-attachment-item" aria-label={`Uploading ${item.name}`}>
          <Paperclip className="h-4 w-4 shrink-0 animate-pulse text-[var(--ink-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--ink-faint)]">{item.name}</span>
          <span className="shrink-0 text-[12px] text-[var(--ink-faint)]">Uploading…</span>
        </div>
      ))}
      {attachments.map((attachment) => {
        const showDelete = typeof canDelete === "function" ? canDelete(attachment) : canDelete;
        return (
          <div key={attachment._id} className="task-attachment-item group">
            <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
            <a className="min-w-0 flex-1 truncate hover:text-[var(--ink)]" href={attachment.url ?? "#"} target="_blank" rel="noreferrer" title={`${attachment.fileName} · ${humanSize(attachment.size)}${attachment.createdAt ? ` · ${formatDate(attachment.createdAt)}` : ""}`}>
              {attachment.fileName}
            </a>
            {showDelete && <button type="button" className="task-icon-btn h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onDelete(attachment._id)} aria-label={`Delete ${attachment.fileName}`}><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        );
      })}
    </div>
  );
}

function EvidenceSection({ kind, task, taskId }: { kind: Kind; task: any; taskId: string }) {
  const { activeCompanyId } = useCompany();
  const taskType = taskTypeFor(kind);
  const evidenceQuery = usePaginatedQuery(
    api.tasks.getTaskEvidence,
    activeCompanyId ? { companyId: activeCompanyId, taskType, taskId } : "skip",
    { initialNumItems: 25 },
  );
  const entries = evidenceQuery.results as any[];
  const required = task.evidenceRequired === true;
  const loading = evidenceQuery.status === "LoadingFirstPage";
  const currentCycleStart = kind === "jd" ? task.state?.currentCycleStart ?? null : null;
  // A retired row can share the current cycleStart after a same-day schedule
  // change; it is history, not evidence for the cycle the server now demands.
  const currentSubmitted = kind === "jd"
    ? currentCycleStart != null && entries.some((entry) => entry.cycleStart === currentCycleStart && entry.retiredAt == null)
    : entries.some((entry) => entry.retiredAt == null);

  return (
    <section className="task-section">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="task-section-title !mb-0">Evidence</h2>
          {required && <Badge tone="yellow">Required to complete</Badge>}
        </div>
        {evidenceQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => evidenceQuery.loadMore(25)}>Load more</Button>}
      </div>
      {kind === "jd" && currentCycleStart != null && !loading && (
        <p className="mb-2 text-[12.5px] text-[var(--ink-muted)]">
          {currentSubmitted ? "Evidence for the current cycle has been submitted." : "No evidence has been submitted for the current cycle yet."}
        </p>
      )}
      {entries.length === 0 ? (
        <div className="text-[13px] text-[var(--ink-faint)]">
          {loading ? "Loading evidence…" : required ? "No evidence yet. Completing this task will ask for evidence." : "No evidence has been submitted."}
        </div>
      ) : (
        <div className="grid gap-2.5">
          {entries.map((entry) => (
            <article key={entry._id} className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12.5px] font-medium text-[var(--ink-secondary)]">
                  {entry.cycleStart != null ? `Cycle of ${formatDate(entry.cycleStart)}` : "Completion evidence"}
                </span>
                {entry.cycleStart != null && entry.cycleStart === currentCycleStart && entry.retiredAt == null && <Badge tone="green">Current cycle</Badge>}
                {entry.retiredAt != null && <Badge tone="neutral">Previous schedule</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--ink-faint)]">
                {entry.createdBy && <Avatar name={entry.createdBy.user.name} email={entry.createdBy.user.email} imageUrl={entry.createdBy.user.imageUrl} />}
                <span className="max-w-full truncate">{entry.createdBy?.user.fullName || entry.createdBy?.user.name || entry.createdBy?.user.email || "Unknown member"}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(entry.createdAt)}</span>
              </div>
              {entry.text && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--ink-secondary)]">{entry.text}</p>}
              {entry.files.length > 0 && (
                <div className="mt-2 grid gap-1.5">
                  {entry.files.map((file: any, fileIndex: number) => {
                    const isImage = typeof file.contentType === "string" && file.contentType.startsWith("image/");
                    const body = (
                      <>
                        {isImage && file.url ? (
                          <span role="img" aria-label={file.fileName} className="h-14 w-14 shrink-0 rounded-md bg-cover bg-center" style={{ backgroundImage: `url(${file.url})` }} />
                        ) : (
                          <Paperclip className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-[var(--ink-secondary)]">{file.fileName}</span>
                          <span className="block truncate text-[12px] text-[var(--ink-faint)]">{file.contentType}{file.size ? ` · ${humanSize(file.size)}` : ""}</span>
                        </span>
                        {file.url === null && <span className="shrink-0 text-[12px] text-[var(--danger)]">Unavailable</span>}
                      </>
                    );
                    return file.url ? (
                      <a key={fileIndex} href={file.url} target="_blank" rel="noreferrer" className="task-attachment-item" title={`${file.fileName} · ${humanSize(file.size)}`}>{body}</a>
                    ) : (
                      <div key={fileIndex} className="task-attachment-item">{body}</div>
                    );
                  })}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function PeekBar({ kind, canEdit, onEdit }: { kind: Kind; canEdit: boolean; onEdit: () => void }) {
  const router = useRouter();
  const base = kind === "jd" ? "/jd-tasks" : "/one-time-tasks";

  function closeDetails() {
    if (!requestDetailDrawerClose(base)) router.push(base);
  }

  return (
    <div className="peek-bar -mt-7 -mx-6 px-2 md:-mt-8 md:-mx-9 md:px-3">
      <div className="flex items-center gap-1">
        <button type="button" className="task-icon-btn" aria-label="Close details" onClick={closeDetails}>
          <ChevronsRight className="h-5 w-5" />
        </button>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <button type="button" className="task-icon-btn" aria-label="Edit task" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export function TaskDetail({ kind, id }: { kind: Kind; id: string }) {
  const { activeCompanyId, active } = useCompany();
  return <TaskDetailContent key={`${activeCompanyId}:${active?.membership._id}:${kind}`} kind={kind} id={id} />;
}

function TaskDetailContent({ kind, id }: { kind: Kind; id: string }) {
  const { activeCompanyId, active, email } = useCompany();
  const taskType = taskTypeFor(kind);
  const data = useQuery(kind === "jd" ? api.tasks.getJd : api.tasks.getOneTime, activeCompanyId ? { companyId: activeCompanyId, taskId: id as any } : "skip") as any;
  const assignableResult = useQuery(api.tasks.assignableUsers, activeCompanyId ? { companyId: activeCompanyId, kind: taskType } : "skip") as AssignableUsersResult | undefined;
  const assignable = assignableResult?.users;
  const [activityLimit, setActivityLimit] = useState(50);
  const activity = useQuery(api.tasks.listActivity, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id, limit: activityLimit } : "skip") as { items: any[]; hasMore: boolean } | undefined;
  const attachmentsQuery = usePaginatedQuery(api.tasks.listAttachments, activeCompanyId ? { companyId: activeCompanyId, taskType, taskId: id } : "skip", { initialNumItems: 25 });
  const attachments = attachmentsQuery.results as any[] | undefined;
  const comment = useMutation(api.tasks.addComment);
  const updateComment = useMutation(api.tasks.updateComment);
  const deleteComment = useMutation(api.tasks.deleteComment);
  const generateUploadUrl = useMutation(api.tasks.generateAttachmentUploadUrl);
  const bindUploadClaim = useMutation(api.tasks.bindUploadClaim);
  const addAttachment = useMutation(api.tasks.addAttachment);
  const deleteOrphanedUpload = useMutation(api.tasks.deleteOrphanedUpload);
  const deleteAttachment = useMutation(api.tasks.deleteAttachment).withOptimisticUpdate((localStore, args) => {
    removeFromListPages(localStore, api.tasks.listAttachments, new Set([String(args.attachmentId)]));
  });
  const updateJdText = useMutation(api.tasks.updateJdText).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listJdRows, api.tasks.getJd, assignable));
  const updateOneTimeText = useMutation(api.tasks.updateOneTimeText).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listOneTimeRows, api.tasks.getOneTime, assignable));
  const updateJdFields = useMutation(api.tasks.updateJdFields).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listJdRows, api.tasks.getJd, assignable));
  const updateOneTimeFields = useMutation(api.tasks.updateOneTimeFields).withOptimisticUpdate(optimisticTaskFieldPatch(api.tasks.listOneTimeRows, api.tasks.getOneTime, assignable));
  const [editOpen, setEditOpen] = useState(false);
  const [body, setBody] = useState("");
  const [pendingUploads, setPendingUploads] = useState<{ key: string; name: string; size: number }[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [pendingTaskField, setPendingTaskField] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);
  const [optimisticCommentBodies, setOptimisticCommentBodies] = useState<Record<string, string>>({});
  const [optimisticDeletedCommentIds, setOptimisticDeletedCommentIds] = useState<string[]>([]);
  const [editingCommentId, setEditingCommentId] = useState<Id<"taskComments"> | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editCommentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previousEditingCommentIdRef = useRef<Id<"taskComments"> | null>(null);

  const activityItems = useMemo(() => [...((activity?.items ?? []).slice().reverse()).filter((activityRow) => activityRow.kind !== "comment" || !optimisticDeletedCommentIds.includes(activityRow._id)).map((activityRow) => activityRow.kind === "comment" ? { ...activityRow, body: optimisticCommentBodies[activityRow._id] ?? activityRow.body } : activityRow), ...optimisticComments], [activity?.items, optimisticCommentBodies, optimisticComments, optimisticDeletedCommentIds]);
  const canAddAttachments = active?.capabilities.includes("tasks:attachment:add") ?? false;
  const canDeleteAnyAttachment = active?.capabilities.includes("tasks:attachment:delete:any") ?? false;
  const canDeleteOwnAttachment = active?.capabilities.includes("tasks:attachment:delete:own") ?? false;
  const canComment = active?.capabilities.includes("tasks:comment") ?? false;
  const canEdit = Boolean(data?.canUpdate);

  useEffect(() => {
    setActivityLimit(50);
  }, [id, taskType]);

  useLayoutEffect(() => {
    const textarea = commentTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [body]);

  useLayoutEffect(() => {
    if (!editingCommentId) {
      previousEditingCommentIdRef.current = null;
      return;
    }
    const textarea = editCommentTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    if (previousEditingCommentIdRef.current !== editingCommentId) {
      textarea.focus();
      textarea.setSelectionRange(editingCommentBody.length, editingCommentBody.length);
    }
    previousEditingCommentIdRef.current = editingCommentId;
  }, [editingCommentBody, editingCommentId]);

  // While the detail query resolves, paint from the seeded list-row preview.
  // Editing stays disabled until the authoritative record arrives.
  const preview = data === undefined ? getDetailPreview<TaskRow>(`task:${activeCompanyId}:${kind}:${active?.membership._id}`, id) : undefined;
  const detailRows = useMemo<TaskRow[]>(() => {
    const task = data?.task ?? preview;
    return task ? [task] : [];
  }, [data?.task, preview]);
  const { allTasks, deadlineError } = useTaskDeadlineRows(detailRows, kind);
  if (!data && !preview) return <TaskDetailSkeleton />;
  const task = allTasks[0] as any;

  async function saveTaskText(patch: { title?: string; description?: string; notes?: string }) {
    if (!activeCompanyId) return false;
    setTextError(null);
    try {
      if (kind === "jd") await updateJdText({ companyId: activeCompanyId, taskId: task._id as Id<"jdTasks">, ...patch });
      else await updateOneTimeText({ companyId: activeCompanyId, taskId: task._id as Id<"oneTimeTasks">, ...patch });
      return true;
    } catch (err) {
      setTextError(err instanceof Error ? err.message : "Could not update the task.");
      return false;
    }
  }

  async function saveTaskField(patch: Partial<TaskFormValues>, label: string) {
    if (!activeCompanyId || pendingTaskField) return false;
    setPendingTaskField(label);
    setTextError(null);
    try {
      if (kind === "jd") {
        await updateJdFields({
          companyId: activeCompanyId,
          taskId: task._id as Id<"jdTasks">,
          title: patch.title,
          description: patch.description,
          notes: patch.notes,
          time: patch.time,
          quantity: patch.quantity !== undefined ? quantityFromInput(patch.quantity) ?? null : undefined,
          recurrence: patch.recurrence,
          assigneeMembershipIds: patch.assigneeMembershipIds as Id<"companyMemberships">[] | undefined,
        });
      } else {
        await updateOneTimeFields({
          companyId: activeCompanyId,
          taskId: task._id as Id<"oneTimeTasks">,
          title: patch.title,
          description: patch.description,
          notes: patch.notes,
          dueDate: patch.dueDate !== undefined ? fromDateInput(patch.dueDate) ?? null : undefined,
          time: patch.time,
          quantity: patch.quantity !== undefined ? quantityFromInput(patch.quantity) ?? null : undefined,
          assigneeMembershipIds: patch.assigneeMembershipIds as Id<"companyMemberships">[] | undefined,
          priority: patch.priority,
        });
      }
      return true;
    } catch (err) {
      setTextError(err instanceof Error ? err.message : "Could not update the task.");
      return false;
    } finally {
      setPendingTaskField((current) => current === label ? null : current);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!activeCompanyId || files.length === 0) return;
    setUploadError(null);
    const pending = files.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, name: file.name, size: file.size }));
    setPendingUploads((current) => [...current, ...pending]);
    await Promise.all(files.map(async (file, index) => {
      const key = pending[index].key;
      try {
        const upload = await generateUploadUrl({ companyId: activeCompanyId });
        const response = await fetch(upload.url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
        const json = await response.json() as { storageId?: Id<"_storage"> };
        if (!json.storageId) throw new Error(`Could not upload ${file.name}.`);
        try {
          await bindUploadClaim({ companyId: activeCompanyId, claimId: upload.claimId, storageId: json.storageId });
          await addAttachment({ companyId: activeCompanyId, taskType, taskId: id, storageId: json.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size, claimId: upload.claimId });
        } catch (attachErr) {
          void deleteOrphanedUpload({ companyId: activeCompanyId, claimId: upload.claimId }).catch(() => {});
          throw attachErr;
        }
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setPendingUploads((current) => current.filter((item) => item.key !== key));
      }
    }));
  }

  async function submitComment() {
    const text = body.trim();
    if (!text || !activeCompanyId) return;
    const tempId = crypto.randomUUID();
    setActionError(null);
    setOptimisticComments((current) => [{ kind: "comment", _id: tempId, body: text, createdAt: Date.now(), actor: null, actorMembershipId: active?.membership._id, optimistic: true }, ...current]);
    setBody("");
    try {
      await comment({ companyId: activeCompanyId, taskType, taskId: id, body: text });
    } catch (err) {
      setBody(text);
      setActionError(err instanceof Error ? err.message : "Could not add comment.");
    } finally {
      setOptimisticComments((current) => current.filter((commentRow) => commentRow._id !== tempId));
    }
  }

  function startEditingComment(commentRow: any) {
    setActionError(null);
    setEditingCommentId(commentRow._id);
    setEditingCommentBody(commentRow.body);
  }

  function cancelEditingComment() {
    setEditingCommentId(null);
    setEditingCommentBody("");
  }

  async function saveEditedComment(commentId: Id<"taskComments">) {
    const text = editingCommentBody.trim();
    if (!text || !activeCompanyId) return;
    const previousBody = activityItems.find((activityRow) => activityRow.kind === "comment" && activityRow._id === commentId)?.body ?? "";
    setActionError(null);
    setOptimisticCommentBodies((current) => ({ ...current, [commentId]: text }));
    cancelEditingComment();
    try {
      await updateComment({ companyId: activeCompanyId, commentId, body: text });
      setOptimisticCommentBodies((current) => { const next = { ...current }; delete next[commentId]; return next; });
    } catch (err) {
      setOptimisticCommentBodies((current) => ({ ...current, [commentId]: previousBody }));
      setActionError(err instanceof Error ? err.message : "Could not update comment.");
    }
  }

  async function removeComment(commentId: Id<"taskComments">) {
    if (!activeCompanyId) return;
    setActionError(null);
    setOptimisticDeletedCommentIds((current) => current.includes(commentId) ? current : [...current, commentId]);
    if (editingCommentId === commentId) cancelEditingComment();
    try {
      await deleteComment({ companyId: activeCompanyId, commentId });
    } catch (err) {
      setOptimisticDeletedCommentIds((current) => current.filter((id) => id !== commentId));
      setActionError(err instanceof Error ? err.message : "Could not delete comment.");
    }
  }

  const primaryAssignee = task.assignees?.[0];
  const fieldPending = (field: string) => pendingTaskField === field;

  return (
    <div>
      <PeekBar kind={kind} canEdit={canEdit} onEdit={() => setEditOpen(true)} />
      <TaskDialog kind={kind} mode="edit" open={editOpen} onOpenChange={setEditOpen} task={task} assignable={assignable ?? []} assignableIsTruncated={assignableResult?.isTruncated ?? false} onUploadError={setUploadError} />

      {deadlineError && <p className="alert-error mt-4 rounded-md p-2 text-[13px]" role="alert">{deadlineError}</p>}
      {textError && <p className="alert-error mt-4 rounded-md p-2 text-[13px]" role="alert">{textError}</p>}

      <div className="pt-6">
        <EditableTaskText value={task.title ?? ""} placeholder="Untitled task" ariaLabel="Edit task title" canEdit={canEdit} required variant="title" onSave={(title) => saveTaskText({ title })} />
      </div>

      <div className="task-section !mt-6">
        <div className="prop-list">
          <PropertyRow icon={<UsersIcon className="h-3.5 w-3.5" />} label="Assigned To" muted={!canEdit && !task.assignees?.length}>
            {canEdit && assignable ? (
              <InlineAssigneeCell assignable={assignable} assignees={task.assignees ?? []} selected={task.assigneeMembershipIds ?? []} pending={fieldPending("assignee")} onSave={(assigneeMembershipIds) => saveTaskField({ assigneeMembershipIds }, "assignee")} />
            ) : task.assignees?.length ? (
              <span className="inline-flex items-center gap-2">
                {primaryAssignee && <Avatar name={primaryAssignee.user.name} email={primaryAssignee.user.email} imageUrl={primaryAssignee.user.imageUrl} />}
                <span className="truncate">{primaryAssignee?.user.name || primaryAssignee?.user.email}</span>
                {task.assignees.length > 1 && <span className="text-[var(--ink-faint)]">+{task.assignees.length - 1}</span>}
              </span>
            ) : "Unassigned"}
          </PropertyRow>
          <PropertyRow icon={<StatusIcon className="h-3.5 w-3.5" />} label="Status">
            <StatusBadge kind={kind} task={task} size="md" canUpdateOverride={canEdit} cellTrigger={canEdit} />
          </PropertyRow>
          {kind === "jd" ? (
            <PropertyRow icon={<FrequencyIcon className="h-3.5 w-3.5" />} label="Frequency">
              {canEdit ? (
                <InlineSelectCell value={task.recurrence as Frequency} options={frequencies} ariaLabel="Change frequency" pending={fieldPending("frequency")} onSave={(recurrence) => saveTaskField({ recurrence }, "frequency")} />
              ) : (
                <span className="inline-flex items-center gap-1.5">{frequencyLabel(task.recurrence)}</span>
              )}
            </PropertyRow>
          ) : (
            <PropertyRow icon={<Flag className="h-3.5 w-3.5" />} label="Priority">
              {canEdit ? (
                <InlineSelectCell
                  value={task.priority as Priority}
                  options={priorities.map((priority) => ({ value: priority, label: priorityLabel(priority) }))}
                  ariaLabel="Change priority"
                  pending={fieldPending("priority")}
                  onSave={(priority) => saveTaskField({ priority }, "priority")}
                  renderValue={(option) => <span className={cn("priority-chip", priorityChipClasses((option?.value ?? task.priority) as Priority))}>{option?.label ?? priorityLabel(task.priority)}</span>}
                />
              ) : (
                <span className={cn("priority-chip", priorityChipClasses(task.priority))}>
                  {priorityLabel(task.priority)}
                </span>
              )}
            </PropertyRow>
          )}
          {kind === "one" && (
            <PropertyRow icon={<CalendarClock className="h-3.5 w-3.5" />} label="Due Date" muted={!canEdit && !task.dueDate}>
              {canEdit ? (
                <DatePicker value={task.dueDate ? toDateField(task.dueDate, dateHasExplicitTime(task.dueDate)) : ""} displayValue={dueLabel(task)} compact onChange={(dueDate) => { void saveTaskField({ dueDate }, "due"); }} />
              ) : dueLabel(task)}
            </PropertyRow>
          )}
          <PropertyRow icon={<QuantityIcon className="h-3.5 w-3.5" />} label="Quantity" muted={!canEdit && task.quantity == null}>
            {canEdit ? <InlinePropertyText value={task.quantity != null ? String(task.quantity) : ""} ariaLabel="Edit quantity" inputMode="decimal" pending={fieldPending("quantity")} onSave={(quantity) => saveTaskField({ quantity }, "quantity")} /> : task.quantity ?? "—"}
          </PropertyRow>
          <PropertyRow icon={<Clock className="h-3.5 w-3.5" />} label="Time" muted={!canEdit && !task.time}>
            {canEdit ? <InlinePropertyText value={task.time ?? ""} ariaLabel="Edit time" pending={fieldPending("time")} onSave={(time) => saveTaskField({ time }, "time")} /> : task.time || "—"}
          </PropertyRow>
          <PropertyRow icon={<CalendarDays className="h-3.5 w-3.5" />} label="Created">{formatDate(task.createdAt)}</PropertyRow>
        </div>
      </div>

      <section className="task-section">
        <h2 className="task-section-title">Description</h2>
        <EditableTaskText value={task.description ?? ""} placeholder={canEdit ? "Add description..." : "No description."} ariaLabel="Edit task description" canEdit={canEdit} variant="description" onSave={(description) => saveTaskText({ description })} />
      </section>

      <section className="task-section">
        <h2 className="task-section-title">Notes</h2>
        <EditableTaskText value={task.notes ?? ""} placeholder={canEdit ? "Add notes..." : "No notes."} ariaLabel="Edit task notes" canEdit={canEdit} variant="description" onSave={(notes) => saveTaskText({ notes })} />
      </section>

      <EvidenceSection kind={kind} task={task} taskId={id} />

      <section className="task-section">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="task-section-title !mb-0">Attachments</h2>
          {attachmentsQuery.status === "CanLoadMore" && <Button size="sm" variant="ghost" onClick={() => attachmentsQuery.loadMore(25)}>Load more</Button>}
        </div>
        <AttachmentList
          attachments={attachments ?? []}
          pendingUploads={pendingUploads}
          canDelete={(attachment) =>
            canDeleteAnyAttachment ||
            (canDeleteOwnAttachment && attachment.createdByMembershipId === active?.membership._id)
          }
          onDelete={(attachmentId) =>
            deleteAttachment({ companyId: activeCompanyId as Id<"companies">, attachmentId }).catch((err) => {
              setActionError(err instanceof Error ? err.message : "Could not delete attachment.");
            })
          }
        />
        {uploadError && <p className="alert-error mt-3 rounded-md p-2 text-[13px]">{uploadError}</p>}
        {canAddAttachments && (
          <div className="task-attachment-add-row">
            <label className="task-attachment-add inline-flex cursor-pointer items-center gap-1.5">
              <input className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void uploadFiles(files); event.currentTarget.value = ""; }} />
              <Plus className="h-3.5 w-3.5" />Attach files
            </label>
          </div>
        )}
      </section>

      <section className="task-section">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--ink-muted)]">Activity</h2>
          {activity?.hasMore && activityLimit < 100 && <Button size="sm" variant="ghost" onClick={() => setActivityLimit((current) => Math.min(current + 25, 100))}>Load more</Button>}
        </div>
        {activityItems.length > 0 && (
          <div className="mb-5">
            {activityItems.map((activityRow: any, index) => {
              const isComment = activityRow.kind === "comment";
              const name = activityRow.actor?.user.name || activityRow.actor?.user.email || (activityRow.optimistic ? "You" : "Someone");
              const isLastActivity = index === activityItems.length - 1;
              const isEditing = isComment && editingCommentId === activityRow._id;
              const canManageComment = isComment && canComment && !activityRow.optimistic && active?.membership._id === activityRow.actorMembershipId;
              return (
                <div key={`${activityRow.kind}-${activityRow._id}`} className={cn("comment-row relative flex gap-2.5", !isLastActivity && "pb-4")} data-editing={isEditing ? "true" : undefined}>
                  {canManageComment && (
                    <div className="comment-action-menu">
                      {isEditing ? (
                        <>
                          <button type="button" className="comment-action-btn" aria-label="Cancel editing comment" onClick={cancelEditingComment}><X className="h-3.5 w-3.5" /></button>
                          <button type="button" className="comment-action-btn" aria-label="Save comment" disabled={!editingCommentBody.trim()} onClick={() => void saveEditedComment(activityRow._id)}><Check className="h-3.5 w-3.5" /></button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="comment-action-btn" aria-label="Edit comment" onClick={() => startEditingComment(activityRow)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" className="comment-action-btn" aria-label="Delete comment" onClick={() => void removeComment(activityRow._id)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </div>
                  )}
                  {!isLastActivity && <span className="absolute bottom-[6px] left-3 top-[30px] w-px -translate-x-1/2 bg-[color-mix(in_srgb,var(--hairline-strong)_72%,var(--ink-faint))]" aria-hidden />}
                  <div className="relative z-[1] flex w-6 shrink-0 justify-center">
                    {isComment ? (
                      <Avatar name={activityRow.actor?.user.name ?? null} email={activityRow.actor?.user.email ?? null} imageUrl={activityRow.actor?.user.imageUrl ?? null} />
                    ) : (
                      <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--hairline)] bg-[var(--canvas)] text-[var(--ink-faint)]"><Check className="h-3.5 w-3.5" /></span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    {isComment ? (
                      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2 shadow-[0_1px_0_color-mix(in_srgb,var(--shadow-cast)_calc(4%_*_var(--shadow-strength)),transparent)]">
                        <div className="comment-header flex items-baseline gap-2">
                          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--ink)]">{name}</span>
                          {activityRow.createdAt && <span className="text-[12px] text-[var(--ink-faint)]">{relativeTime(activityRow.createdAt)}</span>}
                        </div>
                        {isEditing ? (
                          <textarea
                            ref={editCommentTextareaRef}
                            rows={1}
                            value={editingCommentBody}
                            onChange={(event) => setEditingCommentBody(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") cancelEditingComment();
                              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void saveEditedComment(activityRow._id); }
                            }}
                            className="mt-0.5 block min-h-6 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] leading-6 text-[var(--ink-secondary)] outline-none"
                            autoFocus
                          />
                        ) : (
                          <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--ink-secondary)]">{activityRow.body}</p>
                        )}
                      </div>
                    ) : (
                      <div className="pt-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[13px] text-[var(--ink-secondary)]">{activityLogText(activityRow)}</span>
                          {activityRow.createdAt && <span className="text-[12px] text-[var(--ink-faint)]">{relativeTime(activityRow.createdAt)}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {canComment && (
          <form className="group flex items-start gap-2 border-b border-[var(--hairline)] pb-3" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--hairline)] bg-[var(--canvas-soft)] text-[11px] text-[var(--ink-muted)]">
              {initials(null, email).slice(0, 1)}
            </span>
            <textarea
              ref={commentTextareaRef}
              rows={1}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitComment(); } }}
              placeholder="Add a comment to the activity..."
              className="min-h-6 max-h-24 flex-1 resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
            />
            <button type="submit" disabled={!body.trim()} className={cn("hidden h-5 w-5 shrink-0 place-items-center rounded-full text-[var(--on-primary)] transition-colors group-focus-within:grid", body.trim() ? "bg-[var(--primary)] hover:bg-[var(--primary-hover)]" : "bg-[var(--ink-faint)] disabled:opacity-30")} aria-label="Add comment">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </form>
        )}
        {actionError && <p className="alert-error mt-3 rounded-md p-2 text-[13px]">{actionError}</p>}
      </section>
    </div>
  );
}

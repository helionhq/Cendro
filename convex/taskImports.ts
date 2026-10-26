import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { canChangeTaskConfirmer, getManagedMembershipIds, hasAllManagedMemberships, isManagedMembership, membershipCapabilities, requireCapability } from "./permissions";
import type { Capability } from "../src/lib/permissions";
import { effectiveCurrentJdCycle, elapsedJdOccurrences, loadWorkCalendar } from "./workCalendar";
import { defaultTimeZone } from "./taskCycles";
import { applyConfirmerChange, assertConfirmerInCompany, canManageJdLifecycle, preserveJdCompletionStamp, reconcileOneTimeOverdue, recordMissedJdCycles, retireJdHistoryAtCycle, transitionJdTaskActiveState, type TaskVisibilityAuth } from "./tasks";
import { syncReferenceCounter } from "./references";
import { normalizeEmail, nonEmpty } from "./validation";

const kindValidator = v.union(v.literal("jd"), v.literal("one_time"));
const sourceValidator = v.literal("cendro");
const recurrenceValidator = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const priorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"));
const statusValidator = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"));
const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const presentFieldValidator = v.union(v.literal("reference"), v.literal("title"), v.literal("description"), v.literal("notes"), v.literal("recurrence"), v.literal("dueDate"), v.literal("priority"), v.literal("time"), v.literal("quantity"), v.literal("assignees"), v.literal("status"), v.literal("isActive"), v.literal("evidenceRequired"), v.literal("confirmationRequired"), v.literal("confirmerEmail"));
const draftValidator = v.object({
  rowKey: v.string(),
  sourceSheet: v.string(),
  sourceRow: v.number(),
  source: sourceValidator,
  kind: kindValidator,
  reference: nullableString,
  title: nullableString,
  description: nullableString,
  notes: nullableString,
  recurrence: v.union(recurrenceValidator, v.null()),
  dueDate: nullableNumber,
  priority: v.union(priorityValidator, v.null()),
  time: nullableString,
  quantity: nullableNumber,
  rawAssigneeText: v.string(),
  assigneeEmails: v.array(v.string()),
  status: v.union(statusValidator, v.null()),
  // Optional on the wire so clients running the pre-column bundle still validate; missing reads as null everywhere below.
  isActive: v.optional(v.union(v.boolean(), v.null())),
  evidenceRequired: v.optional(v.union(v.boolean(), v.null())),
  confirmationRequired: v.optional(v.union(v.boolean(), v.null())),
  confirmerEmail: v.optional(nullableString),
  presentFields: v.array(presentFieldValidator),
  warnings: v.array(v.string()),
});
const reviewedRowValidator = v.object({
  draft: draftValidator,
  include: v.boolean(),
  expectedUpdatedAt: v.optional(v.number()),
  selectedAssigneeMembershipIds: v.union(v.array(v.id("companyMemberships")), v.null()),
});

const MAX_PREVIEW_ROWS = 500;
// An import commits in a single mutation so the whole file is one atomic
// transaction: a failure mid-import can never leave partially imported tasks.
const MAX_COMMIT_ROWS = MAX_PREVIEW_ROWS;
// Preview records bind a commit to the exact file the server validated. They
// are consumed by the committing mutation; abandoned ones expire with the
// sweepExpiredTaskImportPreviews cron after this TTL.
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
// A JD update runs three index lookups per elapsed cycle to catch up missed
// records (completion, missed record, pending confirmation request), plus a
// few fixed reads per committed row (reference lookup, counter sync, the
// post-catch-up task read, the current-cycle completion check). The
// whole import is one transaction under Convex's index-read limit, so the
// estimated total is bounded up front: a file past this fails cleanly instead
// of hitting the limit mid-write. Splitting the file stays the escape hatch.
const FIXED_LOOKUPS_PER_ROW = 4;
const MAX_COMMIT_LOOKUPS = 3500;

type TaskKind = "jd" | "one_time";
type ImportSource = "cendro";
type Ctx = QueryCtx | MutationCtx;
type Draft = {
  rowKey: string;
  sourceSheet: string;
  sourceRow: number;
  source: ImportSource;
  kind: TaskKind;
  reference: string | null;
  title: string | null;
  description: string | null;
  notes: string | null;
  recurrence: "daily" | "every_other_day" | "weekly" | "semimonthly" | "monthly" | "quarterly" | "semiannually" | "annually" | null;
  dueDate: number | null;
  priority: "low" | "medium" | "high" | "critical" | null;
  time: string | null;
  quantity: number | null;
  rawAssigneeText: string;
  assigneeEmails: string[];
  status: "due" | "in_progress" | "completed" | null;
  isActive?: boolean | null;
  evidenceRequired?: boolean | null;
  confirmationRequired?: boolean | null;
  confirmerEmail?: string | null;
  presentFields: string[];
  warnings: string[];
};
type ReviewedRow = { draft: Draft; include: boolean; expectedUpdatedAt?: number; selectedAssigneeMembershipIds: Id<"companyMemberships">[] | null };
type Task = Doc<"jdTasks"> | Doc<"oneTimeTasks">;
type ImportAuth = {
  caps: Set<Capability>;
  canCreate: boolean;
  canUpdate: boolean;
  membership: Doc<"companyMemberships">;
  scoped: Set<Id<"companyMemberships">>;
  assignable: Set<Id<"companyMemberships">>;
  membershipIdsByEmail: Map<string, Id<"companyMemberships">[]>;
  activeMembershipIdsByEmail: Map<string, Id<"companyMemberships">[]>;
  companyMemberEmails: Set<string>;
};

function prefix(kind: TaskKind) { return kind === "jd" ? "JD" : "TSK"; }
function capabilityPrefix(kind: TaskKind) { return kind === "jd" ? "tasks:jd" : "tasks:one_time"; }
function cleanText(value: string | null) { const text = value?.trim() ?? ""; return text || undefined; }
function normalizedReference(value: string | null) { return value?.trim().toUpperCase() ?? ""; }
function hasField(draft: Draft, field: string) { return draft.presentFields.includes(field); }
function hasAssigneeValue(draft: Draft) { return draft.assigneeEmails.length > 0 || draft.rawAssigneeText.trim().length > 0; }
function fail(message: string): never { throw new ConvexError(message); }

async function fingerprintRows(rows: readonly unknown[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseReference(reference: string | null, kind: TaskKind) {
  const normalized = normalizedReference(reference);
  if (!normalized) return { value: null as string | null, error: `Task code is required and must match ${prefix(kind)}-001.` };
  const valid = kind === "jd"
    ? /^JD-\d{3,15}$/.test(normalized)
    : /^(?:TSK|OT)-\d{3,15}$/.test(normalized);
  if (!valid) return { value: normalized, error: `Code must match ${prefix(kind)}-001.` };
  return { value: normalized };
}

function validateReference(reference: string | null, kind: TaskKind): string {
  const parsed = parseReference(reference, kind);
  if (parsed.error || !parsed.value) fail(parsed.error ?? `Task code is required and must match ${prefix(kind)}-001.`);
  return parsed.value;
}

function capabilitiesForImport(caps: Set<Capability>, kind: TaskKind) {
  const p = capabilityPrefix(kind);
  const canCreate = caps.has(`${p}:create` as Capability);
  const canUpdate = caps.has(`${p}:update:any` as Capability) || caps.has(`${p}:update:managed` as Capability) || caps.has(`${p}:update:self` as Capability);
  return { canCreate, canUpdate };
}

function extractAssigneeTargets(
  drafts: Iterable<{ assigneeEmails?: string[]; confirmerEmail?: string | null }>,
  selectedMembershipIds?: Iterable<Id<"companyMemberships">[] | null | undefined>
) {
  const emails = new Set<string>();
  for (const item of drafts) {
    if (item.assigneeEmails) {
      for (const email of item.assigneeEmails) {
        try {
          emails.add(normalizeEmail(email));
        } catch {
          // Unparseable emails are handled during draft validation / resolution
        }
      }
    }
    if (item.confirmerEmail) {
      try {
        emails.add(normalizeEmail(item.confirmerEmail));
      } catch {
        // Unparseable emails are handled during draft validation / resolution
      }
    }
  }
  const membershipIds = new Set<Id<"companyMemberships">>();
  if (selectedMembershipIds) {
    for (const list of selectedMembershipIds) {
      if (list) {
        for (const id of list) {
          membershipIds.add(id);
        }
      }
    }
  }
  return { emails, membershipIds };
}

async function buildImportAuth(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  kind: TaskKind,
  requestedEmails: Iterable<string>,
  selectedMembershipIds?: Iterable<Id<"companyMemberships">>,
  precomputedCaps?: Set<Capability>,
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  const p = capabilityPrefix(kind);
  const canAssignAny = caps.has(`${p}:assign:any` as Capability);
  const canAssignManaged = caps.has(`${p}:assign:managed` as Capability);
  const canAssignSelf = caps.has(`${p}:assign:self` as Capability);
  const needsScope = caps.has(`${p}:update:managed` as Capability) || canAssignManaged
    || (kind === "jd" && (caps.has("tasks:jd:pause") || caps.has("tasks:jd:resume")));
  const scoped = needsScope
    ? await getManagedMembershipIds(ctx, companyId, membership._id)
    : new Set<Id<"companyMemberships">>([membership._id]);

  async function isAssignable(m: Doc<"companyMemberships">) {
    if (!m.active || m.companyId !== companyId) return false;
    if (canAssignAny) return true;
    if (canAssignManaged) return await isManagedMembership(ctx, companyId, membership._id, m._id, scoped);
    if (canAssignSelf) return m._id === membership._id;
    return false;
  }

  const membershipIdsByEmail = new Map<string, Id<"companyMemberships">[]>();
  const activeMembershipIdsByEmail = new Map<string, Id<"companyMemberships">[]>();
  const companyMemberEmails = new Set<string>();
  const assignable = new Set<Id<"companyMemberships">>();

  if (await isAssignable(membership)) {
    assignable.add(membership._id);
  }

  for (const email of requestedEmails) {
    const users = await ctx.db
      .query("appUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(10);

    for (const user of users) {
      const candidate = await ctx.db
        .query("companyMemberships")
        .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id))
        .unique();

      if (candidate && candidate.active) {
        companyMemberEmails.add(email);
        // A confirmer need not be assignable, but resolves through the same
        // email → active-membership lookup so unknown and inactive emails
        // behave consistently across assignees and confirmers.
        const activeCurrent = activeMembershipIdsByEmail.get(email) ?? [];
        if (!activeCurrent.includes(candidate._id)) {
          activeMembershipIdsByEmail.set(email, [...activeCurrent, candidate._id]);
        }
        if (await isAssignable(candidate)) {
          assignable.add(candidate._id);
          const current = membershipIdsByEmail.get(email) ?? [];
          if (!current.includes(candidate._id)) {
            membershipIdsByEmail.set(email, [...current, candidate._id]);
          }
        }
      }
    }
  }

  if (selectedMembershipIds) {
    for (const id of selectedMembershipIds) {
      if (!assignable.has(id)) {
        const candidate = await ctx.db.get(id);
        if (candidate && (await isAssignable(candidate))) {
          assignable.add(candidate._id);
        }
      }
    }
  }

  return { ...capabilitiesForImport(caps, kind), caps, membership, scoped, assignable, membershipIdsByEmail, activeMembershipIdsByEmail, companyMemberEmails } satisfies ImportAuth;
}

async function taskByReference(ctx: Ctx, companyId: Id<"companies">, kind: TaskKind, reference: string) {
  return kind === "jd"
    ? await ctx.db.query("jdTasks").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", companyId).eq("reference", reference)).unique()
    : await ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", companyId).eq("reference", reference)).unique();
}

async function taskCanUpdate(ctx: Ctx, companyId: Id<"companies">, auth: ImportAuth, task: Task, kind: TaskKind) {
  const p = capabilityPrefix(kind);
  if (auth.caps.has(`${p}:update:any` as Capability)) return true;
  const targets = task.assigneeMembershipIds.length ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (auth.caps.has(`${p}:update:managed` as Capability) && await hasAllManagedMemberships(ctx, companyId, auth.membership._id, targets, auth.scoped)) return true;
  return auth.caps.has(`${p}:update:self` as Capability) && targets.includes(auth.membership._id);
}

function validateDraftValues(row: Draft, kind: TaskKind) {
  const errors = row.warnings.filter((warning) => /^(Quantity must|Numeric due dates|Ambiguous due date|Due date must|Invalid (spreadsheet )?date|Invalid due date|Formula-like text|Frequency is not|Priority is not|Is active must|Evidence required must|Task code |Code must )/.test(warning));
  if (row.kind !== kind) errors.push("Wrong task kind.");
  if (!row.rowKey.trim() || row.rowKey.length > 200 || !row.sourceSheet.trim() || row.sourceSheet.length > 200 || !Number.isInteger(row.sourceRow) || row.sourceRow < 1 || row.sourceRow > 1_000_000) errors.push("Import row source is invalid.");
  if (row.reference !== null && row.reference.length > 200) errors.push("Reference is too long.");
  if (hasField(row, "title") && !row.title?.trim()) errors.push("Task title is required.");
  if (row.title !== null && row.title.length > 500) errors.push("Title is too long.");
  if (row.description !== null && row.description.length > 20_000) errors.push("Description is too long.");
  if (row.notes !== null && row.notes.length > 20_000) errors.push("Notes is too long.");
  if (row.time !== null && row.time.length > 200) errors.push("Time is too long.");
  if (row.quantity !== null && (!Number.isFinite(row.quantity) || row.quantity <= 0)) errors.push("Quantity must be a positive number.");
  if (row.presentFields.length > 15 || new Set(row.presentFields).size !== row.presentFields.length) errors.push("Import row contains invalid field markers.");
  if (row.reference !== null && !hasField(row, "reference")) errors.push("Reference was not marked as present in the source.");
  if (row.rawAssigneeText.length > 2_000 || row.assigneeEmails.length > 50 || row.assigneeEmails.some((email) => email.length > 320)) errors.push("Assignee data is too large.");
  if (row.warnings.length > 20 || row.warnings.some((warning) => warning.length > 500)) errors.push("Import warnings are too large.");
  if (hasAssigneeValue(row) && row.assigneeEmails.length === 0) errors.push("Assignee text needs an exact email address or manual selection.");
  if (hasAssigneeValue(row) && !hasField(row, "assignees")) errors.push("Assignee data was not marked as present in the source.");
  if (kind === "jd" && (row.dueDate !== null || hasField(row, "dueDate") || row.priority !== null || hasField(row, "priority"))) errors.push("JD rows contain one-time task fields.");
  if (kind === "one_time" && (row.recurrence !== null || hasField(row, "recurrence"))) errors.push("One-time rows contain a recurrence.");
  if (kind === "one_time" && (row.isActive != null || hasField(row, "isActive"))) errors.push("One-time rows contain an active state.");
  if (kind === "jd" && row.isActive == null && hasField(row, "isActive")) errors.push("Is active must be Yes or No.");
  if (hasField(row, "evidenceRequired") && row.evidenceRequired == null) errors.push("Evidence required must be Yes or No.");
  if (hasField(row, "confirmationRequired") && row.confirmationRequired == null) errors.push("Confirmation required must be Yes or No.");
  const confirmerEmail = row.confirmerEmail?.trim() ?? "";
  if (confirmerEmail.length > 320) errors.push("Confirmer email is too long.");
  if (row.confirmationRequired === true && !confirmerEmail) errors.push("Confirmation required needs a confirmer email.");
  if (row.confirmationRequired !== true && confirmerEmail) errors.push("Confirmer email is only allowed when confirmation is required.");
  if (kind === "jd" && row.recurrence === null && hasField(row, "recurrence")) errors.push("Frequency is required and must be valid.");
  if (kind === "one_time" && row.priority === null && hasField(row, "priority")) errors.push("Priority is required and must be valid.");
  if (kind === "one_time" && row.dueDate !== null && !Number.isFinite(row.dueDate)) errors.push("Due date is invalid.");
  return errors;
}

// The import auth object precomputes the managed scope as a hint; lifecycle
// checks fall back to per-target verification so a stale or partial set can
// never over-permit.
function lifecycleScopeAuth(auth: ImportAuth): TaskVisibilityAuth {
  return { caps: auth.caps, getManagedScope: async () => ({ ids: auth.scoped, complete: false }) };
}

async function checkJdLifecycleChange(
  ctx: Ctx,
  companyId: Id<"companies">,
  auth: ImportAuth,
  draft: Draft,
  task: Doc<"jdTasks"> | null,
): Promise<{ change: "pause" | "resume" | null; error: string | null }> {
  if (!hasField(draft, "isActive") || draft.isActive == null) return { change: null, error: null };
  const wantPaused = draft.isActive === false;
  if (task) {
    if ((task.pausedAt !== undefined) === wantPaused) return { change: null, error: null };
    if (!(await canManageJdLifecycle(ctx, companyId, auth.membership, task, lifecycleScopeAuth(auth), wantPaused))) {
      return { change: null, error: `You do not have permission to make this task ${wantPaused ? "inactive" : "active"}.` };
    }
    return { change: wantPaused ? "pause" : "resume", error: null };
  }
  if (!wantPaused) return { change: null, error: null };
  if (!auth.caps.has("tasks:jd:pause")) return { change: null, error: "You do not have permission to make tasks inactive." };
  return { change: "pause", error: null };
}

function resolveAssignees(auth: ImportAuth, draft: Draft, selected: Id<"companyMemberships">[] | null, existing: Task | null) {
  const hints: string[] = [];
  const autoMatched: Id<"companyMemberships">[] = [];
  const errors: string[] = [];
  for (const email of draft.assigneeEmails) {
    let normalized: string;
    try { normalized = normalizeEmail(email); } catch { hints.push(email); continue; }
    const matches = auth.membershipIdsByEmail.get(normalized) ?? [];
    if (matches.length === 1) autoMatched.push(matches[0]);
    else if (matches.length > 1) hints.push(email);
    else {
      if (auth.companyMemberEmails.has(normalized)) {
        errors.push(`Assignee "${email}" is outside your assignable scope.`);
      } else {
        hints.push(email);
      }
    }
  }
  const proposed = selected ?? (hasAssigneeValue(draft) ? autoMatched : existing?.assigneeMembershipIds ?? []);
  const unique = Array.from(new Set(proposed));
  if (selected && unique.some((id) => !auth.assignable.has(id))) errors.push("One or more selected assignees are outside your assignable scope.");
  if (selected && unique.length === 0) errors.push("Tasks need at least one assignee.");
  if (!selected && hasAssigneeValue(draft) && hints.length > 0) errors.push("Review unresolved assignee hints before importing.");
  if (!selected && hasAssigneeValue(draft) && unique.length === 0 && !existing && errors.length === 0) errors.push("New tasks need at least one resolved assignee.");
  return { membershipIds: unique, hints, errors };
}

async function resolveConfirmer(ctx: Ctx, companyId: Id<"companies">, auth: ImportAuth, draft: Draft, existing: Task | null): Promise<{ membershipId?: Id<"companyMemberships">; error: string | null }> {
  const email = draft.confirmerEmail?.trim() ?? "";
  // The cross-field rules are reported by validateDraftValues; this resolves
  // the membership once those pass.
  if (draft.confirmationRequired !== true || !email) return { error: null };
  let normalized: string;
  try {
    normalized = normalizeEmail(email);
  } catch {
    return { error: `Confirmer email "${email}" is invalid.` };
  }
  const matches = auth.activeMembershipIdsByEmail.get(normalized) ?? [];
  if (matches.length === 0) return { error: `Confirmer "${email}" is not an active member of this company.` };
  if (matches.length > 1) return { error: `Confirmer "${email}" matches more than one member.` };
  // Keeping the current confirmer is not a new appointment: a confirmer who
  // later lost the capability must not block an unrelated import row.
  if (existing?.confirmerMembershipId === matches[0]) return { membershipId: matches[0], error: null };
  try {
    await assertConfirmerInCompany(ctx, companyId, matches[0]);
  } catch (error) {
    const data = (error as { data?: unknown } | null)?.data;
    return { error: typeof data === "string" ? data : "The selected confirmer cannot confirm task completion." };
  }
  return { membershipId: matches[0], error: null };
}

/**
 * The same confirmer-change rules as a task edit, surfaced as a row error so
 * the preview blocks before the commit writes anything.
 */
async function confirmerChangeError(
  ctx: Ctx,
  companyId: Id<"companies">,
  kind: TaskKind,
  auth: ImportAuth,
  task: Task | null,
  nextConfirmer: Id<"companyMemberships"> | undefined,
) {
  if (!task || nextConfirmer === task.confirmerMembershipId) return null;
  const targets = task.assigneeMembershipIds.length ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (!(await canChangeTaskConfirmer(ctx, companyId, auth.membership, targets, kind, auth.caps))) {
    return "You cannot change who confirms this task.";
  }
  if (nextConfirmer === undefined) {
    const pending = await ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", kind).eq("taskId", task._id)).first();
    if (pending) return "Confirm or send back the pending submissions before turning off confirmation.";
  }
  return null;
}

// Preview is a mutation so it can stage the server-side file record that a
// later commit is bound to. It writes only taskImportPreviews rows.
export const previewTaskImport = mutation({
  args: { companyId: v.id("companies"), kind: kindValidator, drafts: v.array(draftValidator) },
  handler: async (ctx, args) => {
    if (args.drafts.length > MAX_PREVIEW_ROWS) fail(`Imports may contain at most ${MAX_PREVIEW_ROWS} task rows.`);
    const capability: Capability = args.kind === "jd" ? "tasks:jd:import" : "tasks:one_time:import";
    const { membership, capabilities } = await requireCapability(ctx, args.companyId, capability);
    const { emails } = extractAssigneeTargets(args.drafts);
    const auth = await buildImportAuth(ctx, args.companyId, membership, args.kind, emails, undefined, capabilities);
    const duplicateRefs = new Set<string>();
    const seenRefs = new Set<string>();
    const duplicateRowKeys = new Set<string>();
    const seenRowKeys = new Set<string>();
    for (const draft of args.drafts) {
      const reference = normalizedReference(draft.reference);
      if (reference && seenRefs.has(reference)) duplicateRefs.add(reference);
      if (reference) seenRefs.add(reference);
      if (seenRowKeys.has(draft.rowKey)) duplicateRowKeys.add(draft.rowKey);
      seenRowKeys.add(draft.rowKey);
    }
    const rows = [];
    for (const draft of args.drafts) {
      const errors = [...validateDraftValues(draft, args.kind)];
      const warnings = [...draft.warnings];
      let operation: "create" | "update" | "blocked" = "blocked";
      let task: Task | null = null;
      const referenceParsed = parseReference(draft.reference, args.kind);
      const reference = referenceParsed.value;
      if (referenceParsed.error) errors.push(referenceParsed.error);
      if (reference && duplicateRefs.has(reference)) errors.push("Duplicate reference in workbook.");
      if (duplicateRowKeys.has(draft.rowKey)) errors.push("Duplicate source row in workbook.");
      if (reference) {
        const candidateTask = await taskByReference(ctx, args.companyId, args.kind, reference);
        if (candidateTask) {
          if (!(await taskCanUpdate(ctx, args.companyId, auth, candidateTask, args.kind))) {
            errors.push("Task code belongs to an existing task that you do not have permission to edit.");
          } else {
            task = candidateTask;
            operation = "update";
          }
        } else {
          if (!auth.canCreate) {
            errors.push("You do not have permission to create tasks for this task kind.");
          } else {
            operation = "create";
          }
        }
      }
      const assignees = resolveAssignees(auth, draft, null, task);
      errors.push(...assignees.errors);
      const confirmer = await resolveConfirmer(ctx, args.companyId, auth, draft, task);
      if (confirmer.error) errors.push(confirmer.error);
      else {
        const confirmationPatchRequested = hasField(draft, "confirmationRequired") || hasField(draft, "confirmerEmail");
        const nextConfirmer = task
          ? (confirmationPatchRequested ? confirmer.membershipId : task.confirmerMembershipId)
          : confirmer.membershipId;
        const changeError = await confirmerChangeError(ctx, args.companyId, args.kind, auth, task, nextConfirmer);
        if (changeError) errors.push(changeError);
      }
      if (operation === "create" && assignees.membershipIds.length === 0 && !assignees.errors.some((e) => e.includes("assignee"))) {
        errors.push("New tasks need at least one assignee.");
      }
      if (hasAssigneeValue(draft) && assignees.hints.length > 0) warnings.push(`Unresolved assignee hints: ${assignees.hints.join(", ")}`);
      if (operation === "create" && !draft.title?.trim()) errors.push("Title is required for new tasks.");
      if (operation === "create" && args.kind === "jd" && !draft.recurrence) errors.push("Frequency is required for new JD tasks.");
      if (operation === "create" && args.kind === "one_time" && !draft.priority) errors.push("Priority is required for new one-time tasks.");
      if (args.kind === "jd" && task && draft.recurrence && draft.recurrence !== (task as Doc<"jdTasks">).recurrence) warnings.push("Changing recurrence resets the active JD cycle and status.");
      if (args.kind === "jd" && (operation === "update" || operation === "create")) {
        // Authorize the lifecycle change against the post-import assignees so a
        // combined reassign + lifecycle row cannot slip out of a managed scope.
        const lifecycle = await checkJdLifecycleChange(ctx, args.companyId, auth, draft, task ? { ...(task as Doc<"jdTasks">), assigneeMembershipIds: assignees.membershipIds } : null);
        if (lifecycle.error) errors.push(lifecycle.error);
        else if (lifecycle.change === "pause") warnings.push(task ? "This task will be made inactive." : "This task will be created inactive.");
        else if (lifecycle.change === "resume") warnings.push("This task will be made active.");
      }
      if (args.kind === "one_time" && draft.dueDate !== null && draft.dueDate < Date.now() && (!task || task.status !== "completed")) warnings.push("This task will be overdue immediately.");
      rows.push({ rowKey: draft.rowKey, sourceSheet: draft.sourceSheet, sourceRow: draft.sourceRow, operation: errors.length > 0 ? "blocked" : operation, reference: reference ?? null, draft, current: task ? editableSnapshot(task, args.kind) : null, proposedAssigneeMembershipIds: assignees.membershipIds, proposedConfirmerMembershipId: confirmer.membershipId ?? null, unresolvedAssigneeHints: assignees.hints, errors, warnings, include: errors.length === 0 });
    }
    // Stage the whole-file record a commit must match: commits that omit rows,
    // alter drafts, or arrive from older clients without a previewId are
    // rejected before they write anything.
    const previewId = await ctx.db.insert("taskImportPreviews", {
      companyId: args.companyId,
      actorMembershipId: membership._id,
      kind: args.kind,
      fingerprint: await fingerprintRows(args.drafts),
      rowCount: args.drafts.length,
      createdAt: Date.now(),
    });
    return { rows, canCreate: auth.canCreate, canUpdate: auth.canUpdate, previewId };
  },
});

function editableSnapshot(task: Task, kind: TaskKind) {
  return kind === "jd"
    ? { reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, recurrence: (task as Doc<"jdTasks">).recurrence, time: task.time ?? null, quantity: task.quantity ?? null, assigneeMembershipIds: task.assigneeMembershipIds, isActive: (task as Doc<"jdTasks">).pausedAt === undefined, updatedAt: task.updatedAt }
    : { reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, dueDate: (task as Doc<"oneTimeTasks">).dueDate ?? null, priority: (task as Doc<"oneTimeTasks">).priority, time: task.time ?? null, quantity: task.quantity ?? null, assigneeMembershipIds: task.assigneeMembershipIds, updatedAt: task.updatedAt };
}

async function validateCommitRow(ctx: MutationCtx, companyId: Id<"companies">, kind: TaskKind, auth: ImportAuth, row: ReviewedRow) {
  const draft = row.draft;
  const reference = validateReference(draft.reference, kind);
  const task = await taskByReference(ctx, companyId, kind, reference);
  if (task) {
    if (!(await taskCanUpdate(ctx, companyId, auth, task, kind))) {
      fail("Task code belongs to an existing task that you do not have permission to edit.");
    }
    if (row.expectedUpdatedAt === undefined || task.updatedAt !== row.expectedUpdatedAt) {
      fail("One or more import rows changed since preview. Re-preview and try again.");
    }
  } else {
    if (!auth.canCreate) {
      fail("You do not have permission to create tasks for this task kind.");
    }
    if (row.expectedUpdatedAt !== undefined) {
      fail("One or more import rows became unavailable. Re-preview and try again.");
    }
  }
  const errors = validateDraftValues(draft, kind);
  if (errors.length) fail(errors[0]);
  const resolved = resolveAssignees(auth, draft, row.selectedAssigneeMembershipIds, task);
  if (resolved.errors.length) fail(resolved.errors[0]);
  const confirmer = await resolveConfirmer(ctx, companyId, auth, draft, task);
  if (confirmer.error) fail(confirmer.error);
  const confirmationPatchRequested = hasField(draft, "confirmationRequired") || hasField(draft, "confirmerEmail");
  const nextConfirmer = task
    ? (confirmationPatchRequested ? confirmer.membershipId : task.confirmerMembershipId)
    : confirmer.membershipId;
  const changeError = await confirmerChangeError(ctx, companyId, kind, auth, task, nextConfirmer);
  if (changeError) fail(changeError);
  if (!task && !draft.title?.trim()) fail("New tasks need a title.");
  if (!task && kind === "jd" && !draft.recurrence) fail("New JD tasks need a frequency.");
  if (!task && kind === "one_time" && !draft.priority) fail("New one-time tasks need a priority.");
  if (!task && resolved.membershipIds.length === 0) fail("New tasks need an assignee.");
  const assigneePatchRequested = row.selectedAssigneeMembershipIds !== null || hasAssigneeValue(draft);
  if (assigneePatchRequested && resolved.membershipIds.length === 0) fail("Tasks need at least one assignee.");
  const lifecycle = kind === "jd" ? await checkJdLifecycleChange(ctx, companyId, auth, draft, task ? { ...(task as Doc<"jdTasks">), assigneeMembershipIds: resolved.membershipIds } : null) : { change: null, error: null };
  if (lifecycle.error) fail(lifecycle.error);
  return { draft, task, reference, assigneeMembershipIds: resolved.membershipIds, assigneePatchRequested, confirmerMembershipId: confirmer.membershipId, confirmationPatchRequested, lifecycleChange: lifecycle.change };
}

export const commitTaskImportBatch = mutation({
  args: { companyId: v.id("companies"), kind: kindValidator, importKey: v.string(), batchKey: v.string(), source: sourceValidator, previewId: v.id("taskImportPreviews"), rows: v.array(reviewedRowValidator) },
  handler: async (ctx, args) => {
    if (args.rows.length === 0 || args.rows.length > MAX_COMMIT_ROWS) fail(`Import batches must contain 1-${MAX_COMMIT_ROWS} rows.`);
    if (!args.importKey.trim() || !args.batchKey.trim() || args.importKey.length > 200 || args.batchKey.length > 200) fail("Import keys are invalid.");
    const capability: Capability = args.kind === "jd" ? "tasks:jd:import" : "tasks:one_time:import";
    const { membership, user, company, capabilities } = await requireCapability(ctx, args.companyId, capability);
    const requestFingerprint = await fingerprintRows(args.rows);
    const existingReceipt = await ctx.db.query("taskImportBatches").withIndex("by_companyId_and_importKey_and_batchKey", (q) => q.eq("companyId", args.companyId).eq("importKey", args.importKey).eq("batchKey", args.batchKey)).unique();
    if (existingReceipt) {
      if (existingReceipt.actorMembershipId !== membership._id || existingReceipt.kind !== args.kind || existingReceipt.source !== args.source) fail("Import receipt is not available.");
      if (existingReceipt.requestFingerprint !== requestFingerprint) fail("Import batch key was already used for different rows. Re-preview and try again.");
      return existingReceipt.result;
    }
    if (args.rows.some((row) => row.draft.source !== args.source || row.draft.kind !== args.kind)) fail("Import source or task kind changed. Re-preview and try again.");
    // All-or-nothing: the commit must present exactly the file the preview
    // validated, so an omitted or altered row can never produce a partial
    // import. Every reviewed row must also be included.
    const preview = await ctx.db.get(args.previewId);
    if (!preview || preview.companyId !== args.companyId || preview.actorMembershipId !== membership._id || preview.kind !== args.kind) fail("Import preview is not available. Preview the file again.");
    if (preview.rowCount !== args.rows.length || preview.fingerprint !== (await fingerprintRows(args.rows.map((row) => row.draft)))) fail("Import rows do not match the previewed file. Preview the file again.");
    if (args.rows.some((row) => !row.include)) fail("Import batches must include every reviewed row.");
    const rowKeys = args.rows.map((row) => row.draft.rowKey);
    if (new Set(rowKeys).size !== rowKeys.length) fail("Import batch contains duplicate source rows.");
    const references = args.rows.map((row) => validateReference(row.draft.reference, args.kind));
    if (new Set(references).size !== references.length) fail("Import batch contains duplicate task references.");
    const priorReceipts = await ctx.db.query("taskImportBatches").withIndex("by_companyId_and_importKey_and_batchKey", (q) => q.eq("companyId", args.companyId).eq("importKey", args.importKey)).take(2);
    if (priorReceipts.some((receipt) => receipt.actorMembershipId !== membership._id || receipt.kind !== args.kind || receipt.source !== args.source)) fail("Import key is not available.");
    // A committed import already wrote its receipt; the same-batchKey retry was
    // replayed above, so any other batch under this key is a spent import.
    if (priorReceipts.length > 0) fail("This import was already committed. Preview the file again to retry.");
    const { emails, membershipIds } = extractAssigneeTargets(
      args.rows.map((row) => row.draft),
      args.rows.map((row) => row.selectedAssigneeMembershipIds)
    );
    const auth = await buildImportAuth(ctx, args.companyId, membership, args.kind, emails, membershipIds, capabilities);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const prepared = [];
    for (const row of args.rows) prepared.push(await validateCommitRow(ctx, args.companyId, args.kind, auth, row));
    // Estimate the transaction's read work without reads: elapsed occurrence
    // counts are pure calendar math and the rest scales with the row count.
    // Reject before any write when the file needs more than a transaction holds.
    const estimateNow = Date.now();
    let estimatedLookups = 0;
    for (const item of prepared) {
      estimatedLookups += FIXED_LOOKUPS_PER_ROW;
      const task = args.kind === "jd" ? item.task as Doc<"jdTasks"> | null : null;
      if (task && task.pausedAt === undefined) {
        estimatedLookups += 3 * elapsedJdOccurrences(calendar, task.recurrence, task.cycleStartedAt, estimateNow, 200, company.timeZone).occurrences.length;
      }
      if (estimatedLookups > MAX_COMMIT_LOOKUPS) fail("This file needs more work than one import can process. Split it into smaller files and import each.");
    }
    let created = 0;
    let updated = 0;
    const taskReferences: string[] = [];
    for (const item of prepared) {
      const now = Date.now();
      await syncReferenceCounter(ctx, args.companyId, args.kind, item.reference);
      if (item.task) {
        if (args.kind === "jd") {
          const task = item.task as Doc<"jdTasks">;
          const recurrence = hasField(item.draft, "recurrence") && item.draft.recurrence ? item.draft.recurrence : task.recurrence;
          const currentCycle = effectiveCurrentJdCycle(calendar, recurrence, now, company.timeZone);
          const nextCycleStart = recurrence !== task.recurrence ? currentCycle.start : undefined;
          await recordMissedJdCycles(ctx, task, now, company.timeZone, calendar);
          const rolled = await ctx.db.get(task._id);
          if (!rolled) fail("One or more import rows became unavailable. Re-preview and try again.");
          const activeCycleStart = nextCycleStart ?? currentCycle.start;
          const previousDone = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).eq("cycleStart", activeCycleStart)).filter((q) => q.eq(q.field("retiredAt"), undefined)).unique();
          const previousStatus = previousDone || (rolled.statusCycleStart === activeCycleStart && rolled.status === "completed") ? "completed" : rolled.statusCycleStart === activeCycleStart ? rolled.status : "due";
          const nextTask = { ...rolled };
          if (hasField(item.draft, "title")) nextTask.title = nonEmpty(item.draft.title ?? "", "Task title");
          if (hasField(item.draft, "description")) {
            const desc = cleanText(item.draft.description);
            if (desc === undefined) delete nextTask.description;
            else nextTask.description = desc;
          }
          if (hasField(item.draft, "notes")) {
            const n = cleanText(item.draft.notes);
            if (n === undefined) delete nextTask.notes;
            else nextTask.notes = n;
          }
          if (hasField(item.draft, "time")) {
            const t = cleanText(item.draft.time);
            if (t === undefined) delete nextTask.time;
            else nextTask.time = t;
          }
          if (hasField(item.draft, "quantity")) {
            if (item.draft.quantity === null || item.draft.quantity === undefined) delete nextTask.quantity;
            else nextTask.quantity = item.draft.quantity;
          }
          if (hasField(item.draft, "recurrence") && item.draft.recurrence) nextTask.recurrence = item.draft.recurrence;
          if (item.assigneePatchRequested) nextTask.assigneeMembershipIds = item.assigneeMembershipIds;
          if (hasField(item.draft, "evidenceRequired")) {
            if (item.draft.evidenceRequired === true) nextTask.evidenceRequired = true;
            else delete nextTask.evidenceRequired;
          }
          const nextConfirmer = item.confirmationPatchRequested ? item.confirmerMembershipId : rolled.confirmerMembershipId;
          if (item.confirmationPatchRequested) {
            if (nextConfirmer === undefined) delete nextTask.confirmerMembershipId;
            else nextTask.confirmerMembershipId = nextConfirmer;
          }
          if (nextCycleStart !== undefined) {
            // Inactivating alone preserves even an in-cycle completion stamp;
            // a combined frequency + inactive row must not lose it to the reset.
            if (item.lifecycleChange === "pause" && rolled.status === "completed" && rolled.statusCycleStart !== undefined) {
              await preserveJdCompletionStamp(ctx, rolled, rolled.statusCycleStart + 1, company.timeZone ?? defaultTimeZone, calendar);
            }
            // Preserve the old grid's work without completing the reset cycle.
            await retireJdHistoryAtCycle(ctx, task._id, nextCycleStart, now);
            nextTask.cycleStartedAt = nextCycleStart;
            nextTask.status = "due";
            nextTask.statusCycleStart = nextCycleStart;
          }
          nextTask.updatedAt = now;
          await ctx.db.replace(task._id, nextTask);
          if (item.confirmationPatchRequested) {
            await applyConfirmerChange(ctx, { taskType: "jd", taskId: task._id, previousConfirmer: rolled.confirmerMembershipId, nextConfirmer });
          }
          if (previousStatus !== nextTask.status) {
            await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "jd", taskId: task._id, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: nextTask.status, createdAt: now });
          }
          if (item.lifecycleChange) {
            await transitionJdTaskActiveState(ctx, { companyId: args.companyId, task: nextTask, paused: item.lifecycleChange === "pause", actorMembershipId: membership._id, now, timeZone: company.timeZone ?? defaultTimeZone, calendar });
          }
        } else {
          const task = item.task as Doc<"oneTimeTasks">;
          const nextTask = { ...task };
          if (hasField(item.draft, "title")) nextTask.title = nonEmpty(item.draft.title ?? "", "Task title");
          if (hasField(item.draft, "description")) {
            const desc = cleanText(item.draft.description);
            if (desc === undefined) delete nextTask.description;
            else nextTask.description = desc;
          }
          if (hasField(item.draft, "notes")) {
            const n = cleanText(item.draft.notes);
            if (n === undefined) delete nextTask.notes;
            else nextTask.notes = n;
          }
          if (hasField(item.draft, "dueDate")) {
            if (item.draft.dueDate === null || item.draft.dueDate === undefined) delete nextTask.dueDate;
            else nextTask.dueDate = item.draft.dueDate;
          }
          if (hasField(item.draft, "priority") && item.draft.priority) nextTask.priority = item.draft.priority;
          if (hasField(item.draft, "time")) {
            const t = cleanText(item.draft.time);
            if (t === undefined) delete nextTask.time;
            else nextTask.time = t;
          }
          if (hasField(item.draft, "quantity")) {
            if (item.draft.quantity === null || item.draft.quantity === undefined) delete nextTask.quantity;
            else nextTask.quantity = item.draft.quantity;
          }
          if (item.assigneePatchRequested) nextTask.assigneeMembershipIds = item.assigneeMembershipIds;
          if (hasField(item.draft, "evidenceRequired")) {
            if (item.draft.evidenceRequired === true) nextTask.evidenceRequired = true;
            else delete nextTask.evidenceRequired;
          }
          const nextConfirmer = item.confirmationPatchRequested ? item.confirmerMembershipId : task.confirmerMembershipId;
          if (item.confirmationPatchRequested) {
            if (nextConfirmer === undefined) delete nextTask.confirmerMembershipId;
            else nextTask.confirmerMembershipId = nextConfirmer;
          }
          reconcileOneTimeOverdue(nextTask, now);
          nextTask.updatedAt = now;
          await ctx.db.replace(task._id, nextTask);
          if (item.confirmationPatchRequested) {
            await applyConfirmerChange(ctx, { taskType: "one_time", taskId: task._id, previousConfirmer: task.confirmerMembershipId, nextConfirmer });
          }
        }
        updated += 1;
        taskReferences.push(item.task.reference);
      } else {
        const reference = item.reference;
        if (args.kind === "jd") {
          const cycle = effectiveCurrentJdCycle(calendar, item.draft.recurrence!, now, company.timeZone);
          const id = await ctx.db.insert("jdTasks", { companyId: args.companyId, reference, title: nonEmpty(item.draft.title ?? "", "Task title"), description: cleanText(item.draft.description), notes: cleanText(item.draft.notes), time: cleanText(item.draft.time), quantity: item.draft.quantity ?? undefined, recurrence: item.draft.recurrence!, cycleStartedAt: now, status: "due", statusCycleStart: cycle.start, evidenceRequired: item.draft.evidenceRequired === true ? true : undefined, confirmerMembershipId: item.confirmerMembershipId, assigneeMembershipIds: item.assigneeMembershipIds, createdByMembershipId: membership._id, createdAt: now, updatedAt: now, pausedAt: item.lifecycleChange === "pause" ? now : undefined });
          await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "jd", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
        } else {
          const id = await ctx.db.insert("oneTimeTasks", { companyId: args.companyId, reference, title: nonEmpty(item.draft.title ?? "", "Task title"), description: cleanText(item.draft.description), notes: cleanText(item.draft.notes), dueDate: item.draft.dueDate ?? undefined, time: cleanText(item.draft.time), quantity: item.draft.quantity ?? undefined, assigneeMembershipIds: item.assigneeMembershipIds, createdByMembershipId: membership._id, priority: item.draft.priority!, status: "due", evidenceRequired: item.draft.evidenceRequired === true ? true : undefined, confirmerMembershipId: item.confirmerMembershipId, createdAt: now, updatedAt: now });
          await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "one_time", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
        }
        created += 1;
        taskReferences.push(reference);
      }
    }
    const result = { created, updated, skipped: 0, failed: 0, taskReferences };
    await ctx.db.delete(args.previewId);
    await ctx.db.insert("taskImportBatches", { companyId: args.companyId, actorMembershipId: membership._id, kind: args.kind, importKey: args.importKey, batchKey: args.batchKey, source: args.source, requestFingerprint, result, createdAt: Date.now() });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "task_import.batch", targetType: "taskImportBatch", metadata: { importKey: args.importKey, source: args.source, kind: args.kind, createCount: created, updateCount: updated, taskReferences }, createdAt: Date.now() });
    return result;
  },
});

export const sweepExpiredTaskImportPreviews = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    const page = await ctx.db.query("taskImportPreviews").order("asc").paginate({ numItems: 200, cursor: args.cursor ?? null });
    for (const preview of page.page) {
      // Rows scan in creation order — a fresh preview means the rest are fresh.
      if (preview.createdAt >= cutoff) return null;
      await ctx.db.delete(preview._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.taskImports.sweepExpiredTaskImportPreviews, { cursor: page.continueCursor });
    return null;
  },
});

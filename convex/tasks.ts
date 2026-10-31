import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentJdCycle, defaultTimeZone, nextJdCycleStart, type JdRecurrence } from "./taskCycles";
import { effectiveCurrentJdCycle, elapsedJdOccurrences, loadWorkCalendar, occurrenceDeadline, type WorkCalendar } from "./workCalendar";
import { activeCompanyMembershipIds, assertCanAssign, assertCanChangeTaskConfirmer, assertCanDeleteTask, assertCanUpdateTask, canViewTask, getManagedMembershipIds, hasAllManagedMemberships, hasAnyManagedMembership, memberFirstName, memberFullName, membershipCapabilities, requireCapability, requireMembership, roleNameCapabilities, scanManagedMembershipIds, scopedMembershipIds } from "./permissions";
import type { Capability } from "../src/lib/permissions";
import { nonEmpty } from "./validation";
import { DEFAULT_QUERY_LIMIT, takeWithOverflow } from "./queryLimits";
import { paletteSearchInput, searchPaletteRows, referenceSearchKey } from "./searchText";
import { ASSIGNEE_SEARCH_MAX_LENGTH } from "../src/lib/assignee-search";
import { nextReference } from "./references";
import {
  activeTaskEvidence,
  deleteActiveTaskEvidence,
  deleteTaskEvidenceBatch,
  evidenceInputValidator,
  evidenceMatchesSubmission,
  isBlobReferenced,
  retireTaskEvidenceAtCycle,
  storeTaskEvidence,
  TASK_UPLOAD_CLAIM_TTL_MS,
  validateEvidenceInput,
  type EvidenceInput,
} from "./taskEvidence";
import {
  assertTaskListSort,
  taskListPreferenceResultValidator,
  taskListSortValidator,
  taskListTaskTypeValidator,
} from "./taskListPreferences";

type ManualStatus = "due" | "in_progress" | "completed";
type TaskStatus = ManualStatus | "awaiting_confirmation";
type TaskKind = "jd" | "one_time";
type Ctx = QueryCtx | MutationCtx;
export type TaskVisibilityAuth = {
  caps: Set<Capability>;
  /**
   * Lazily resolved managed scope, shared by every check in this invocation.
   * `complete` is true only when the bounded scope read was not truncated, so
   * a complete set can answer membership checks without per-target fallbacks.
   */
  getManagedScope: () => Promise<{ ids: Set<Id<"companyMemberships">>; complete: boolean }>;
};

const recurrenceValidator = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const priorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"));
const statusValidator = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"));
const jdFrequencyFilterValidator = v.union(v.literal("all"), v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const TASK_LIST_ORDER_LIMIT = 2_000;
const TASK_LIST_ORDER_MAX_SERIALIZED_BYTES = 128 * 1024;
const TASK_LIST_ORDER_KEY_MAX_LENGTH = 512;
const ASSIGNABLE_USER_INITIAL_LIMIT = DEFAULT_QUERY_LIMIT;
const ASSIGNABLE_USER_SEARCH_MIN_LENGTH = 3;
const ASSIGNABLE_USER_SEARCH_SCAN_LIMIT = 1_000;
const ASSIGNABLE_USER_SEARCH_RESULT_LIMIT = 50;
const ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE = 50;
const taskListOrderKeyPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/;
function statusLabel(status: TaskStatus | "overdue") { return status === "due" ? "Pending" : status === "in_progress" ? "In Progress" : status === "completed" ? "Completed" : status === "awaiting_confirmation" ? "Awaiting confirmation" : "Overdue"; }
function cleanOptionalText(value?: string) { const text = value?.trim(); return text ? text : undefined; }
function cleanOptionalQuantity(value?: number) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
async function enrich(ctx: Ctx, ids: Id<"companyMemberships">[]) {
  const uniqueIds = Array.from(new Set(ids));
  const memberships = (await Promise.all(uniqueIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"companyMemberships">[];
  const users = (await Promise.all(memberships.map((membership) => ctx.db.get(membership.userId)))).filter(Boolean) as Doc<"appUsers">[];
  const userById = new Map(users.map((user) => [user._id, user]));
  return memberships.flatMap((membership) => {
    const user = userById.get(membership.userId);
    if (!user) return [];
    const fName = memberFirstName(membership, user);
    const sName = membership.secondName !== undefined ? membership.secondName.trim() : (user.secondName?.trim() ?? "");
    const full = memberFullName(membership, user);
    return [{ membership: { _id: membership._id, role: membership.role }, user: { name: fName, firstName: fName, secondName: sName, fullName: full, email: user.email, imageUrl: user.imageUrl } }];
  });
}

async function taskVisibilityAuth(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, precomputedCaps?: Set<Capability>): Promise<TaskVisibilityAuth> {
  // Callers that already resolved access through requireMembership /
  // requireCapability pass the same set instead of re-reading the role doc.
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  let scope: Promise<{ ids: Set<Id<"companyMemberships">>; complete: boolean }> | undefined;
  return {
    caps,
    getManagedScope: () => scope ??= (async () => {
      let complete = true;
      const ids = await getManagedMembershipIds(ctx, companyId, membership._id, () => { complete = false; });
      return { ids, complete };
    })(),
  };
}

async function visible(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId" | "confirmerMembershipId">, kind: TaskKind, auth?: TaskVisibilityAuth) {
  // The designated confirmer may see the task they must act on even when it
  // sits outside their normal view scope.
  if (task.confirmerMembershipId === membership._id) {
    const caps = auth?.caps ?? (await membershipCapabilities(ctx, membership));
    if (caps.has("tasks:confirm")) return true;
  }
  if (!auth) {
    return await canViewTask(ctx, companyId, membership, { companyId, assigneeMembershipIds: task.assigneeMembershipIds, createdByMembershipId: task.createdByMembershipId }, kind);
  }
  const caps = auth.caps;
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:view:any` as Capability)) return true;
  const targets = task.assigneeMembershipIds.length > 0 ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (caps.has(`${prefix}:view:managed` as Capability)) {
    const scope = await auth.getManagedScope();
    if (targets.some((id) => scope.ids.has(id))) return true;
    // A truncated scope is not authoritative, so fall back to per-target checks.
    if (!scope.complete && await hasAnyManagedMembership(ctx, companyId, membership._id, targets, scope.ids)) return true;
  }
  if (caps.has(`${prefix}:view:self` as Capability)) {
    if (targets.includes(membership._id) || task.createdByMembershipId === membership._id) return true;
  }
  return false;
}

/** Assignees the viewer may see: all active members for company-wide viewers, otherwise the shared managed scope. */
async function displayScopedMembershipIds(ctx: Ctx, companyId: Id<"companies">, auth: TaskVisibilityAuth, anyCapability: Capability) {
  if (auth.caps.has(anyCapability)) return await activeCompanyMembershipIds(ctx, companyId);
  return (await auth.getManagedScope()).ids;
}

async function assertAssigneesInCompany(ctx: Ctx, companyId: Id<"companies">, assignees: Id<"companyMemberships">[]) {
  for (const id of assignees) {
    const membership = await ctx.db.get(id);
    if (!membership || membership.companyId !== companyId || !membership.active) throw new ConvexError("Assignee not found in this company.");
  }
}

function requireTaskAssignee(assignees: Id<"companyMemberships">[]) {
  if (assignees.length === 0) throw new ConvexError("Task assignee is required.");
  if (new Set(assignees).size !== assignees.length) throw new ConvexError("Duplicate assignees are not allowed.");
}

// A confirmation request is per task (one-time) or per cycle (JD); pending
// lists and per-task resolution stay bounded so a long history cannot make an
// edit or a status change unbounded.
const CONFIRMATION_REQUEST_LIMIT = 100;

/**
 * The pending request for a JD cycle on the given grid. A request stamped with
 * another recurrence belongs to a superseded grid and is never "pending" for
 * the current one.
 */
async function pendingConfirmationRequest(ctx: Ctx, taskType: TaskKind, taskId: string, cycleStart?: number, recurrence?: JdRecurrence) {
  if (taskType === "jd") {
    const request = ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", taskType).eq("taskId", taskId).eq("cycleStart", cycleStart!));
    return recurrence === undefined
      ? await request.first()
      : await request.filter((q) => q.eq(q.field("recurrence"), recurrence)).first();
  }
  return await ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).filter((q) => q.eq(q.field("cycleStart"), undefined)).first();
}

export async function assertConfirmerInCompany(ctx: Ctx, companyId: Id<"companies">, confirmerMembershipId: Id<"companyMemberships">) {
  const confirmer = await ctx.db.get(confirmerMembershipId);
  if (!confirmer || confirmer.companyId !== companyId || !confirmer.active) throw new ConvexError("Confirmer not found in this company.");
  if (!(await membershipCapabilities(ctx, confirmer)).has("tasks:confirm")) throw new ConvexError("The selected confirmer cannot confirm task completion.");
}

/**
 * Applies the Confirm effect a request represents, in the caller's
 * transaction. Authorization is the caller's job: the confirm mutation checks
 * designation, and the confirmer's own completion path checks capability.
 */
async function resolveConfirmationRequest(ctx: MutationCtx, request: Doc<"taskConfirmationRequests">, actorMembershipId: Id<"companyMemberships">, now: number) {
  if (request.taskType === "jd") {
    const taskId = ctx.db.normalizeId("jdTasks", request.taskId);
    const task = taskId ? await ctx.db.get(taskId) : null;
    if (!taskId || !task || task.companyId !== request.companyId || request.cycleStart === undefined) {
      await ctx.db.delete(request._id);
      return;
    }
    const cycleStart = request.cycleStart;
    // A request submitted on an earlier grid shares no cycle identity with the
    // current one even when their starts coincide. Its confirmation is history:
    // record the work retired and never touch the current grid's status.
    const retired = request.recurrence !== task.recurrence;
    if (!(await currentJdCompletion(ctx, taskId, cycleStart))) {
      await ctx.db.insert("jdTaskCompletions", {
        companyId: request.companyId,
        jdTaskId: taskId,
        cycleStart,
        cycleEnd: request.cycleEnd,
        completedByMembershipId: request.submittedByMembershipId,
        completedAt: request.submittedAt,
        ...(retired ? { retiredAt: now } : {}),
      });
    }
    if (retired) {
      await ctx.db.delete(request._id);
      return;
    }
    const missed = await currentJdCycleRecord(ctx, taskId, cycleStart);
    if (missed) await ctx.db.delete(missed._id);
    if (task.statusCycleStart === cycleStart && task.status !== "completed") await ctx.db.patch(taskId, { status: "completed", updatedAt: now });
  } else {
    const taskId = ctx.db.normalizeId("oneTimeTasks", request.taskId);
    const task = taskId ? await ctx.db.get(taskId) : null;
    if (!taskId || !task || task.companyId !== request.companyId) {
      await ctx.db.delete(request._id);
      return;
    }
    if (task.status !== "completed") {
      await ctx.db.replace(taskId, { ...task, status: "completed", completedAt: request.submittedAt, completedByMembershipId: request.submittedByMembershipId, updatedAt: now });
    }
  }
  await logTaskActivity(ctx, { companyId: request.companyId, taskType: request.taskType, taskId: request.taskId, actorMembershipId, event: "status_changed", fromStatus: "awaiting_confirmation", toStatus: "completed", createdAt: now });
  await ctx.db.delete(request._id);
}

/**
 * Applies an edit that changes the task's confirmer: pending requests follow
 * the new confirmer. Turning confirmation off is refused while anything is
 * still pending, so no submission is silently approved by the edit.
 */
export async function applyConfirmerChange(
  ctx: MutationCtx,
  args: {
    taskType: TaskKind;
    taskId: string;
    previousConfirmer?: Id<"companyMemberships">;
    nextConfirmer?: Id<"companyMemberships">;
  },
) {
  if (args.previousConfirmer === args.nextConfirmer) return;
  const requests = ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId));
  if (args.nextConfirmer === undefined) {
    if (await requests.first()) throw new ConvexError("Confirm or send back the pending submissions before turning off confirmation.");
    return;
  }
  const batch = await requests.take(CONFIRMATION_REQUEST_LIMIT);
  for (const request of batch) {
    if (request.confirmerMembershipId !== args.nextConfirmer) await ctx.db.patch(request._id, { confirmerMembershipId: args.nextConfirmer });
  }
  // A long-running JD task can hold more pending cycles than one transaction
  // should write; the continuation finishes the re-point from the task's
  // current confirmer, so a later edit still wins.
  if (batch.length === CONFIRMATION_REQUEST_LIMIT) {
    await ctx.scheduler.runAfter(0, internal.tasks.repointConfirmationRequests, { taskType: args.taskType, taskId: args.taskId });
  }
}

/** Idempotent continuation of a confirmer re-point across every pending request batch. */
export const repointConfirmationRequests = internalMutation({
  args: {
    taskType: v.union(v.literal("jd"), v.literal("one_time")),
    taskId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const normalized = args.taskType === "jd" ? ctx.db.normalizeId("jdTasks", args.taskId) : ctx.db.normalizeId("oneTimeTasks", args.taskId);
    const task = normalized ? await ctx.db.get(normalized) : null;
    const confirmer = task?.confirmerMembershipId;
    // The task may have been deleted or confirmation turned off since the edit.
    if (confirmer === undefined) return null;
    const page = await ctx.db.query("taskConfirmationRequests")
      .withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId))
      .paginate({ numItems: CONFIRMATION_REQUEST_LIMIT, cursor: args.cursor ?? null });
    for (const request of page.page) {
      if (request.confirmerMembershipId !== confirmer) await ctx.db.patch(request._id, { confirmerMembershipId: confirmer });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.repointConfirmationRequests, { taskType: args.taskType, taskId: args.taskId, cursor: page.continueCursor });
    }
    return null;
  },
});

function updateAuthTargets(task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">) {
  return task.assigneeMembershipIds.length === 0 ? [task.createdByMembershipId] : task.assigneeMembershipIds;
}

/** A confirmer change needs update authority beyond the self scope. */
async function assertConfirmerChangeAllowed(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId" | "confirmerMembershipId">,
  kind: TaskKind,
  capabilities: Set<Capability>,
  nextConfirmer?: Id<"companyMemberships">,
) {
  if (nextConfirmer === task.confirmerMembershipId) return;
  await assertCanChangeTaskConfirmer(ctx, companyId, membership, updateAuthTargets(task), kind, capabilities);
}

async function canUpdateTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  auth?: TaskVisibilityAuth,
) {
  const caps = auth?.caps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:update:any` as any)) return true;
  if (caps.has(`${prefix}:update:managed` as any)) {
    const scope = auth ? await auth.getManagedScope() : { ids: await getManagedMembershipIds(ctx, companyId, membership._id), complete: false };
    // A complete scope is authoritative; otherwise fall back to per-target checks.
    if (scope.complete ? targets.every((id) => scope.ids.has(id)) : await hasAllManagedMemberships(ctx, companyId, membership._id, targets, scope.ids)) return true;
  }
  return Boolean(caps.has(`${prefix}:update:self` as any) && targets.includes(membership._id));
}

// Status moves with the assignee, not the permission system: anyone assigned
// can always change it. Everyone else needs normal task update access.
async function assertCanUpdateTaskStatus(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  precomputedCaps?: Set<Capability>,
) {
  if (task.assigneeMembershipIds.includes(membership._id)) return;
  await assertCanUpdateTask(ctx, companyId, membership, updateAuthTargets(task), kind, precomputedCaps);
}

async function canDeleteTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  auth?: TaskVisibilityAuth,
) {
  const caps = auth?.caps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:delete:any` as any)) return true;
  if (caps.has(`${prefix}:delete:managed` as any)) {
    const scope = auth ? await auth.getManagedScope() : { ids: await getManagedMembershipIds(ctx, companyId, membership._id), complete: false };
    if (scope.complete ? targets.every((id) => scope.ids.has(id)) : await hasAllManagedMemberships(ctx, companyId, membership._id, targets, scope.ids)) return true;
  }
  return Boolean(caps.has(`${prefix}:delete:self` as any) && targets.includes(membership._id));
}


/** Lifecycle grants never widen a manager's assignment scope. */
export async function canManageJdLifecycle(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, task: Doc<"jdTasks">, auth: TaskVisibilityAuth, paused: boolean) {
  if (!auth.caps.has(paused ? "tasks:jd:pause" : "tasks:jd:resume")) return false;
  if (membership.role !== "Manager" && auth.caps.has("tasks:jd:view:any")) return true;
  const targets = updateAuthTargets(task);
  // Self-only grants cover assigned shared work. Managers must still own
  // every target in the selection, even when they are also an assignee.
  if (membership.role !== "Manager" && !auth.caps.has("tasks:jd:view:managed") && auth.caps.has("tasks:jd:view:self") && targets.includes(membership._id)) return true;
  const scope = await auth.getManagedScope();
  return scope.complete ? targets.every((id) => scope.ids.has(id)) : await hasAllManagedMemberships(ctx, companyId, membership._id, targets, scope.ids);
}

async function companyTimeZone(ctx: Ctx, companyId: Id<"companies">) {
  const company = await ctx.db.get(companyId);
  return company?.timeZone ?? defaultTimeZone;
}

async function currentJdCompletion(ctx: Ctx, taskId: Id<"jdTasks">, cycleStart: number) {
  return await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart)).filter((q) => q.eq(q.field("retiredAt"), undefined)).unique();
}

// A previous grid can share the new cycle's start. Retire its ledger rows
// from current state while retaining the original work and deadlines as history.
export async function retireJdHistoryAtCycle(ctx: MutationCtx, taskId: Id<"jdTasks">, cycleStart: number, now = Date.now()) {
  const [done, missed] = await Promise.all([currentJdCompletion(ctx, taskId, cycleStart), currentJdCycleRecord(ctx, taskId, cycleStart)]);
  if (done) await ctx.db.patch(done._id, { retiredAt: now });
  if (missed) await ctx.db.patch(missed._id, { retiredAt: now });
  await retireTaskEvidenceAtCycle(ctx, taskId, cycleStart, now);
}

async function currentJdCycleRecord(ctx: Ctx, taskId: Id<"jdTasks">, cycleStart: number) {
  return await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart)).filter((q) => q.eq(q.field("retiredAt"), undefined)).unique();
}

export async function recordMissedJdCycles(ctx: MutationCtx, task: Doc<"jdTasks">, now = Date.now(), timeZone?: string, calendar?: WorkCalendar) {
  if (task.pausedAt !== undefined) return { occurrences: [], nextActiveAt: task.cycleStartedAt };
  const zone = timeZone ?? await companyTimeZone(ctx, task.companyId);
  const cal = calendar ?? await loadWorkCalendar(ctx, task.companyId);
  const { occurrences, nextActiveAt } = elapsedJdOccurrences(cal, task.recurrence, task.cycleStartedAt, now, 200, zone);
  // The per-cycle lookups run in parallel instead of two sequential index
  // lookups per elapsed cycle. Keeping each lookup bounded to its own cycle
  // start means retired rows left at other starts by older, denser grids are
  // never scanned.
  const [doneDocs, recordDocs, pendingDocs] = await Promise.all([
    Promise.all(occurrences.map((cycle) => currentJdCompletion(ctx, task._id, cycle.start))),
    Promise.all(occurrences.map((cycle) => currentJdCycleRecord(ctx, task._id, cycle.start))),
    Promise.all(occurrences.map((cycle) => pendingConfirmationRequest(ctx, "jd", task._id, cycle.start, task.recurrence))),
  ]);
  for (let i = 0; i < occurrences.length; i++) {
    const cycle = occurrences[i];
    const done = doneDocs[i];
    // Legacy tasks predate jdTaskCompletions; their only completed-cycle signal
    // is the status pair stamped when the cycle was current.
    const markedDone = task.status === "completed" && task.statusCycleStart === cycle.start;
    const recorded = recordDocs[i];
    if (done) continue;
    // A submitted cycle waiting on its confirmer is neither done nor missed.
    if (pendingDocs[i]) continue;
    if (markedDone) {
      // Persist the stamped completion before cycleStartedAt advances past the
      // cycle, or the dashboard loses it once the stamp moves on. A missed
      // record for the same cycle is wrong history, so remove it rather than
      // leave a completed cycle listed as missed.
      if (recorded) await ctx.db.delete(recorded._id);
      await ctx.db.insert("jdTaskCompletions", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.deadline, completedAt: cycle.end });
    } else if (!recorded) {
      // cycleEnd stores the effective deadline: for week-and-longer cycles a
      // non-working due date was already shifted to the next working day.
      await ctx.db.insert("jdTaskCycleRecords", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.deadline, status: "missed", recordedAt: now });
    }
  }
  // The floor also advances past skipped occurrences (non-working days on
  // daily/alternate schedules), so the cron never re-walks them.
  if (nextActiveAt !== task.cycleStartedAt) {
    await ctx.db.patch(task._id, { cycleStartedAt: nextActiveAt });
    task.cycleStartedAt = nextActiveAt;
  }
  return { occurrences, nextActiveAt };
}

/**
 * Converts the legacy {status, statusCycleStart} completion stamp into a real
 * completion row before the stamp is overwritten, so deferred catch-up cannot
 * record the stamped cycle as missed. Bounded to one stamped cycle.
 */
export async function preserveJdCompletionStamp(ctx: MutationCtx, task: Doc<"jdTasks">, currentCycleStart: number, timeZone: string, calendar?: WorkCalendar) {
  if (task.status !== "completed" || task.statusCycleStart === undefined || task.statusCycleStart >= currentCycleStart) return;
  const stampedStart = task.statusCycleStart;
  const [existingCompletion, existingRecord] = await Promise.all([
    currentJdCompletion(ctx, task._id, stampedStart),
    currentJdCycleRecord(ctx, task._id, stampedStart),
  ]);
  if (existingCompletion) return;
  if (existingRecord) await ctx.db.delete(existingRecord._id);
  const stampedEnd = nextJdCycleStart(stampedStart, task.recurrence, timeZone);
  const cal = calendar ?? await loadWorkCalendar(ctx, task.companyId);
  await ctx.db.insert("jdTaskCompletions", { companyId: task.companyId, jdTaskId: task._id, cycleStart: stampedStart, cycleEnd: occurrenceDeadline(cal, task.recurrence, stampedEnd, timeZone) ?? stampedEnd, completedAt: stampedEnd });
}

/**
 * Runs full missed-cycle catch-up off the interactive path. Cheap to call: it
 * only schedules work when cycles actually elapsed since cycleStartedAt. When
 * the caller is about to replace the task's recurrence, pass the old schedule
 * as `schedule` so the deferred run reconstructs the old grid — by the time it
 * executes, the task document already carries the new recurrence.
 */
function scheduleMissedJdCycleCatchUp(ctx: MutationCtx, task: Doc<"jdTasks">, currentCycleStart: number, schedule?: { recurrence: JdRecurrence; cycleStartedAt: number }, timeZone?: string) {
  if (task.pausedAt !== undefined) return;
  // The snapshot path re-walks the old grid from the cycle containing the
  // floor: anything between it and that grid's current cycle — elapsed or
  // still pending on a shifted deadline — needs the check. `through` pins the
  // walk's bound at the change instant so delayed runs never evaluate cycles
  // the old schedule never covered.
  const needsCatchUp = schedule
    ? currentJdCycle(schedule.recurrence, task.cycleStartedAt, timeZone).start < currentJdCycle(schedule.recurrence, Date.now(), timeZone).start
    : task.cycleStartedAt < currentCycleStart;
  if (needsCatchUp) {
    const snapshot = schedule ? { ...schedule, through: currentJdCycle(schedule.recurrence, Date.now(), timeZone).start, stoppedAt: Date.now() } : undefined;
    return ctx.scheduler.runAfter(0, internal.tasks.catchUpMissedJdCycles, { taskId: task._id, schedule: snapshot });
  }
}

async function jdState(ctx: Ctx, task: Doc<"jdTasks">, now = Date.now(), timeZone?: string, calendar?: WorkCalendar) {
  if (task.pausedAt !== undefined) return { status: "Inactive", rawStatus: "paused" as const, isOverdue: false, currentCycleStart: null, currentCycleEnd: null, dueAt: null };
  const zone = timeZone ?? await companyTimeZone(ctx, task.companyId);
  const cal = calendar ?? await loadWorkCalendar(ctx, task.companyId);
  const c = effectiveCurrentJdCycle(cal, task.recurrence, now, zone);
  const currentDone = await currentJdCompletion(ctx, task._id, c.start);
  const status: TaskStatus = currentDone || (task.statusCycleStart === c.start && task.status === "completed") ? "completed" : task.statusCycleStart === c.start ? task.status : "due";
  const dueAt = occurrenceDeadline(cal, task.recurrence, c.end, zone) ?? c.end;
  return { status: statusLabel(status), rawStatus: status, isOverdue: false, currentCycleStart: c.start, currentCycleEnd: c.end, dueAt };
}

// Overdue is an overlay; keep the stored manual status when a deadline changes.
export function reconcileOneTimeOverdue(task: Doc<"oneTimeTasks">, now = Date.now()) {
  if (task.status !== "completed" && task.status !== "awaiting_confirmation" && task.dueDate !== undefined && task.dueDate < now) {
    task.overdueAt ??= now;
  } else {
    delete task.overdueAt;
  }
}

function oneState(task: Doc<"oneTimeTasks">) {
  // Submitted work waiting on its confirmer is not overdue; a sticky overdueAt
  // still wins, exactly as it does for completed tasks.
  const isOverdue = Boolean(task.overdueAt) || Boolean(task.dueDate && task.status !== "completed" && task.status !== "awaiting_confirmation" && task.dueDate < Date.now());
  const status: TaskStatus | "overdue" = isOverdue ? "overdue" : task.status;
  return { status: statusLabel(status), rawStatus: status, isOverdue, dueAt: task.dueDate ?? null };
}

async function getVisibleTask(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, taskType: TaskKind, taskId: string, auth?: TaskVisibilityAuth) {
  const normalized = taskType === "jd" ? ctx.db.normalizeId("jdTasks", taskId) : ctx.db.normalizeId("oneTimeTasks", taskId);
  if (!normalized) throw new ConvexError("Task not found.");
  const task = await ctx.db.get(normalized);
  if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, taskType, auth))) throw new ConvexError("Task not found.");
  return { normalized, task };
}

async function logTaskActivity(ctx: MutationCtx, args: { companyId: Id<"companies">; taskType: TaskKind; taskId: string; actorMembershipId: Id<"companyMemberships">; event: "created" | "status_changed" | "paused" | "resumed"; fromStatus?: TaskStatus; toStatus?: TaskStatus; createdAt?: number }) {
  await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: args.taskType, taskId: args.taskId, actorMembershipId: args.actorMembershipId, event: args.event, ...(args.fromStatus ? { fromStatus: args.fromStatus } : {}), ...(args.toStatus ? { toStatus: args.toStatus } : {}), createdAt: args.createdAt ?? Date.now() });
}

async function enrichedJd(ctx: Ctx, task: Doc<"jdTasks">, timeZone?: string, canUpdate?: boolean, canDelete?: boolean, scopedMembershipIds?: Set<Id<"companyMemberships">>, customOrderKey?: string, calendar?: WorkCalendar) {
  const visibleAssigneeIds = scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
  return {
    ...task,
    state: await jdState(ctx, task, Date.now(), timeZone, calendar),
    assignees: await enrich(ctx, visibleAssigneeIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
    ...(customOrderKey ? { customOrderKey } : {}),
  };
}
async function enrichedOneTime(ctx: Ctx, task: Doc<"oneTimeTasks">, canUpdate?: boolean, canDelete?: boolean, scopedMembershipIds?: Set<Id<"companyMemberships">>, customOrderKey?: string) {
  const visibleAssigneeIds = scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
  return {
    ...task,
    state: oneState(task),
    assignees: await enrich(ctx, visibleAssigneeIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
    ...(customOrderKey ? { customOrderKey } : {}),
  };
}

/** Detail payloads carry the confirmer as an enriched member so the client never resolves it itself. */
async function withConfirmer<T extends { confirmerMembershipId?: Id<"companyMemberships"> }>(ctx: Ctx, task: T) {
  const confirmer = task.confirmerMembershipId === undefined ? null : (await enrich(ctx, [task.confirmerMembershipId]))[0] ?? null;
  return { ...task, confirmer };
}
function matchesSearch(task: { title: string; reference: string }, search?: string) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  const needleKey = referenceSearchKey(needle);
  return (
    task.title.toLowerCase().includes(needle) ||
    task.reference.toLowerCase().includes(needle) ||
    (needleKey !== "" && referenceSearchKey(task.reference).includes(needleKey))
  );
}

async function filterAssignableUsersBySearch(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  memberships: Doc<"companyMemberships">[],
  search: string,
) {
  const needle = search.toLowerCase();
  const matches: Id<"companyMemberships">[] = [];
  const activeMemberships = memberships.filter(
    (membership) => membership.companyId === companyId && membership.active,
  );
  for (let start = 0; start < activeMemberships.length; start += ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE) {
    const batch = activeMemberships.slice(start, start + ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE);
    const users = await Promise.all(batch.map((membership) => ctx.db.get(membership.userId)));
    for (let index = 0; index < batch.length; index += 1) {
      const membership = batch[index];
      const user = users[index];
      if (!user) continue;
      const searchable = `${memberFullName(membership, user)} ${user.email} ${membership.role}`.toLowerCase();
      if (!searchable.includes(needle)) continue;
      matches.push(membership._id);
      if (matches.length > ASSIGNABLE_USER_SEARCH_RESULT_LIMIT) {
        return {
          ids: matches.slice(0, ASSIGNABLE_USER_SEARCH_RESULT_LIMIT),
          isTruncated: true,
        };
      }
    }
  }
  return { ids: matches, isTruncated: false };
}

async function loadMembershipsById(ctx: QueryCtx, ids: Id<"companyMemberships">[]) {
  const memberships: Doc<"companyMemberships">[] = [];
  for (let start = 0; start < ids.length; start += ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE) {
    const batch = await Promise.all(
      ids.slice(start, start + ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE).map((id) => ctx.db.get(id)),
    );
    for (const membership of batch) if (membership) memberships.push(membership);
  }
  return memberships;
}

async function assignableUsersResult(
  ctx: QueryCtx,
  ids: Id<"companyMemberships">[],
  isTruncated: boolean,
) {
  return { users: await enrich(ctx, ids), isTruncated };
}

async function getTaskListPreference(
  ctx: Ctx,
  companyId: Id<"companies">,
  membershipId: Id<"companyMemberships">,
  taskType: TaskKind,
) {
  return await ctx.db
    .query("taskListPreferences")
    .withIndex("by_companyId_and_membershipId_and_taskType", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membershipId).eq("taskType", taskType),
    )
    .unique();
}

function taskListPreferenceResult(
  taskType: TaskKind,
  preference: Doc<"taskListPreferences"> | null,
) {
  if (taskType === "jd") {
    return {
      taskType: "jd" as const,
      sort: preference?.sort ?? { mode: "default" as const },
      customOrder: preference?.taskType === "jd" ? preference.customOrder ?? null : null,
      ...(preference?.orderFormat ? { orderFormat: preference.orderFormat } : {}),
      revision: preference?.revision ?? 0,
      updatedAt: preference?.updatedAt ?? null,
    };
  }
  return {
    taskType: "one_time" as const,
    sort: preference?.sort ?? { mode: "default" as const },
    customOrder: preference?.taskType === "one_time" ? preference.customOrder ?? null : null,
    ...(preference?.orderFormat ? { orderFormat: preference.orderFormat } : {}),
    revision: preference?.revision ?? 0,
    updatedAt: preference?.updatedAt ?? null,
  };
}

function assertExpectedPreferenceRevision(
  preference: Doc<"taskListPreferences"> | null,
  expectedRevision: number,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ConvexError("Task list preference revision is invalid.");
  }
  if ((preference?.revision ?? 0) !== expectedRevision) {
    throw new ConvexError("Task list preference was updated. Refresh and try again.");
  }
}

function assertTaskListOrderInput(orderedIds: string[]) {
  if (orderedIds.length > TASK_LIST_ORDER_LIMIT) {
    throw new ConvexError(`Task list order can contain at most ${TASK_LIST_ORDER_LIMIT} tasks.`);
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ConvexError("Task list order contains duplicate task IDs.");
  }
  if (JSON.stringify(orderedIds).length > TASK_LIST_ORDER_MAX_SERIALIZED_BYTES) {
    throw new ConvexError("Task list order is too large to save.");
  }
}

function assertTaskListOrderKey(orderKey: string) {
  if (orderKey.length > TASK_LIST_ORDER_KEY_MAX_LENGTH || !taskListOrderKeyPattern.test(orderKey)) {
    throw new ConvexError("Task list order position is invalid.");
  }
}

async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: "jd",
  orderedIds: string[],
  caps?: Set<Capability>,
): Promise<Doc<"jdTasks">[]>;
async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: "one_time",
  orderedIds: string[],
  caps?: Set<Capability>,
): Promise<Doc<"oneTimeTasks">[]>;
async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: TaskKind,
  orderedIds: string[],
  caps?: Set<Capability>,
) {
  const auth = await taskVisibilityAuth(ctx, companyId, membership, caps);
  if (taskType === "jd") {
    const normalized: Doc<"jdTasks">[] = [];
    for (const rawId of orderedIds) {
      const id = ctx.db.normalizeId("jdTasks", rawId);
      if (!id) throw new ConvexError("Task not found.");
      const task = await ctx.db.get(id);
      if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, "jd", auth))) {
        throw new ConvexError("Task not found.");
      }
      normalized.push(task);
    }
    return normalized;
  }

  const normalized: Doc<"oneTimeTasks">[] = [];
  for (const rawId of orderedIds) {
    const id = ctx.db.normalizeId("oneTimeTasks", rawId);
    if (!id) throw new ConvexError("Task not found.");
    const task = await ctx.db.get(id);
    if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, "one_time", auth))) {
      throw new ConvexError("Task not found.");
    }
    normalized.push(task);
  }
  return normalized;
}

async function applyTaskListOrderKeyUpdates(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: TaskKind,
  orderKeyUpdates: { taskId: string; orderKey: string }[],
  now: number,
  caps?: Set<Capability>,
) {
  const tasks = taskType === "jd"
    ? await validateTaskListOrder(ctx, companyId, membership, "jd", orderKeyUpdates.map(({ taskId }) => taskId), caps)
    : await validateTaskListOrder(ctx, companyId, membership, "one_time", orderKeyUpdates.map(({ taskId }) => taskId), caps);
  const taskIds = tasks.map((task) => task._id);
  const entries = await ctx.db
    .query("taskListOrderEntries")
    .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membership._id).eq("taskType", taskType),
    )
    .take(TASK_LIST_ORDER_LIMIT + 1);
  const entryByTaskId = new Map(entries.map((entry) => [entry.taskId, entry]));
  const missingEntryCount = taskIds.filter((taskId) => !entryByTaskId.has(taskId)).length;
  if (entries.length + missingEntryCount > TASK_LIST_ORDER_LIMIT) {
    throw new ConvexError("Task list order is too large to save.");
  }

  // This only supports older clients, but a full legacy rebalance can contain 2,000 writes.
  for (let start = 0; start < taskIds.length; start += 100) {
    const writes: Promise<unknown>[] = [];
    for (let index = start; index < Math.min(start + 100, taskIds.length); index += 1) {
      const taskId = taskIds[index];
      const { orderKey } = orderKeyUpdates[index];
      const entry = entryByTaskId.get(taskId);
      if (entry) {
        writes.push(ctx.db.patch(entry._id, { orderKey, updatedAt: now }));
      } else if (taskType === "jd") {
        writes.push(ctx.db.insert("taskListOrderEntries", {
          companyId,
          membershipId: membership._id,
          taskType: "jd",
          taskId: taskId as Id<"jdTasks">,
          orderKey,
          updatedAt: now,
        }));
      } else {
        writes.push(ctx.db.insert("taskListOrderEntries", {
          companyId,
          membershipId: membership._id,
          taskType: "one_time",
          taskId: taskId as Id<"oneTimeTasks">,
          orderKey,
          updatedAt: now,
        }));
      }
    }
    await Promise.all(writes);
  }
}

/** Loads every custom-order entry for the list in one indexed read instead of one lookup per row. */
async function taskListOrderKeyMap(ctx: Ctx, companyId: Id<"companies">, membershipId: Id<"companyMemberships">, taskType: TaskKind) {
  const entries = await ctx.db
    .query("taskListOrderEntries")
    .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membershipId).eq("taskType", taskType),
    )
    .take(TASK_LIST_ORDER_LIMIT + 1);
  return new Map(entries.map((entry) => [entry.taskId, entry.orderKey]));
}

export const listJdRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), frequency: v.optional(jdFrequencyFilterValidator), paused: v.optional(v.boolean()), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership, company, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const [scoped, preference] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
      getTaskListPreference(ctx, args.companyId, membership._id, "jd"),
    ]);
    const page = await ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => args.paused ? q.eq("companyId", args.companyId).gt("pausedAt", undefined) : q.eq("companyId", args.companyId).eq("pausedAt", undefined)).order("desc").paginate(args.paginationOpts);
    const candidates = page.page.filter((task) =>
      (!args.frequency || args.frequency === "all" || task.recurrence === args.frequency) && matchesSearch(task, args.search),
    );
    const visibleFlags = await Promise.all(candidates.map((task) => visible(ctx, args.companyId, membership, task, "jd", auth)));
    const visibleTasks = candidates.filter((_, index) => visibleFlags[index]);

    // Enrich the whole page at once: unique assignees are fetched in a single
    // batched pass and per-row state reads run concurrently instead of serially.
    const now = Date.now();
    const timeZone = company.timeZone ?? defaultTimeZone;
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const includeCustomOrderKeys = preference && preference.orderFormat !== "vector";
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const [states, updates, deletes, orderKeys] = await Promise.all([
      Promise.all(visibleTasks.map((task) => jdState(ctx, task, now, timeZone, calendar))),
      Promise.all(visibleTasks.map((task) => canUpdateTask(ctx, args.companyId, membership, task, "jd", auth))),
      Promise.all(visibleTasks.map((task) => canDeleteTask(ctx, args.companyId, membership, task, "jd", auth))),
      includeCustomOrderKeys ? taskListOrderKeyMap(ctx, args.companyId, membership._id, "jd") : Promise.resolve(null),
    ]);
    const lifecycleScopes = await Promise.all(visibleTasks.map((task) => canManageJdLifecycle(ctx, args.companyId, membership, task, auth, task.pausedAt === undefined)));
    const rows = visibleTasks.map((task, index) => ({
      ...task,
      state: states[index],
      assignees: task.assigneeMembershipIds.filter((id) => scoped.has(id)).flatMap((id) => assigneeById.get(id) ?? []),
      canUpdate: updates[index],
      canDelete: deletes[index],
      canPause: task.pausedAt === undefined && lifecycleScopes[index],
      canResume: task.pausedAt !== undefined && lifecycleScopes[index],
      ...(orderKeys?.get(task._id) ? { customOrderKey: orderKeys.get(task._id) } : {}),
    }));
    return { ...page, page: rows };
  },
});

export const exportRows = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const capability: Capability = args.kind === "jd" ? "tasks:jd:export" : "tasks:one_time:export";
    const { membership, capabilities } = await requireCapability(ctx, args.companyId, capability);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const scoped = await displayScopedMembershipIds(ctx, args.companyId, auth, args.kind === "jd" ? "tasks:jd:view:any" : "tasks:one_time:view:any");
    if (args.kind === "jd") {
      // Exports always include inactive tasks: the sheet declares their state
      // via isActive rather than dropping them like the on-screen list does.
      const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
      const visibleFlags = await Promise.all(page.page.map((task) => visible(ctx, args.companyId, membership, task, "jd", auth)));
      const visibleTasks = page.page.filter((_, index) => visibleFlags[index]);
      const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
      const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
      const confirmerRows = await enrich(ctx, visibleTasks.flatMap((task) => task.confirmerMembershipId === undefined ? [] : [task.confirmerMembershipId]));
      const confirmerEmailById = new Map(confirmerRows.map((row) => [row.membership._id, row.user.email]));
      const rows = visibleTasks.map((task) => ({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, recurrence: task.recurrence, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: task.assigneeMembershipIds.filter((id) => scoped.has(id)).map((id) => assigneeById.get(id)?.user.email).filter(Boolean).join("; "), isActive: task.pausedAt === undefined, evidenceRequired: task.evidenceRequired === true, confirmationRequired: task.confirmerMembershipId !== undefined, confirmerEmail: task.confirmerMembershipId === undefined ? null : confirmerEmailById.get(task.confirmerMembershipId) ?? null }));
      return { ...page, page: rows };
    }
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
    const visibleFlags = await Promise.all(page.page.map((task) => visible(ctx, args.companyId, membership, task, "one_time", auth)));
    const visibleTasks = page.page.filter((_, index) => visibleFlags[index]);
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const confirmerRows = await enrich(ctx, visibleTasks.flatMap((task) => task.confirmerMembershipId === undefined ? [] : [task.confirmerMembershipId]));
    const confirmerEmailById = new Map(confirmerRows.map((row) => [row.membership._id, row.user.email]));
    const rows = visibleTasks.map((task) => ({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, dueDate: task.dueDate ?? null, priority: task.priority, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: task.assigneeMembershipIds.filter((id) => scoped.has(id)).map((id) => assigneeById.get(id)?.user.email).filter(Boolean).join("; "), evidenceRequired: task.evidenceRequired === true, confirmationRequired: task.confirmerMembershipId !== undefined, confirmerEmail: task.confirmerMembershipId === undefined ? null : confirmerEmailById.get(task.confirmerMembershipId) ?? null }));
    return { ...page, page: rows };
  },
});

export const listOneTimeRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), priority: v.optional(v.union(v.literal("all"), priorityValidator)), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const [scoped, preference] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
      getTaskListPreference(ctx, args.companyId, membership._id, "one_time"),
    ]);
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const candidates = page.page.filter((task) =>
      (!args.priority || args.priority === "all" || task.priority === args.priority) && matchesSearch(task, args.search),
    );
    const visibleFlags = await Promise.all(candidates.map((task) => visible(ctx, args.companyId, membership, task, "one_time", auth)));
    const visibleTasks = candidates.filter((_, index) => visibleFlags[index]);

    const includeCustomOrderKeys = preference && preference.orderFormat !== "vector";
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const [updates, deletes, orderKeys] = await Promise.all([
      Promise.all(visibleTasks.map((task) => canUpdateTask(ctx, args.companyId, membership, task, "one_time", auth))),
      Promise.all(visibleTasks.map((task) => canDeleteTask(ctx, args.companyId, membership, task, "one_time", auth))),
      includeCustomOrderKeys ? taskListOrderKeyMap(ctx, args.companyId, membership._id, "one_time") : Promise.resolve(null),
    ]);
    const rows = visibleTasks.map((task, index) => ({
      ...task,
      state: oneState(task),
      assignees: task.assigneeMembershipIds.filter((id) => scoped.has(id)).flatMap((id) => assigneeById.get(id) ?? []),
      canUpdate: updates[index],
      canDelete: deletes[index],
      ...(orderKeys?.get(task._id) ? { customOrderKey: orderKeys.get(task._id) } : {}),
    }));
    return { ...page, page: rows };
  },
});

// Palette search reads only indexed title matches or a reference-code range.

async function searchTasksOfKind(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  auth: TaskVisibilityAuth,
  kind: "jd",
  needle: string,
): Promise<{ rows: Doc<"jdTasks">[]; truncated: boolean }>;
async function searchTasksOfKind(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  auth: TaskVisibilityAuth,
  kind: "one_time",
  needle: string,
): Promise<{ rows: Doc<"oneTimeTasks">[]; truncated: boolean }>;
async function searchTasksOfKind(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  auth: TaskVisibilityAuth,
  kind: TaskKind,
  needle: string,
) {
  const input = paletteSearchInput(needle);
  if (!input) return { rows: [], truncated: false };
  return await searchPaletteRows<Doc<"jdTasks"> | Doc<"oneTimeTasks">>(ctx, {
    input,
    prefixes: kind === "jd" ? ["JD"] : ["TSK", "OT"],
    byReference: (prefix) => kind === "jd"
      ? ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt_and_reference", (q) => q.eq("companyId", companyId).eq("pausedAt", undefined).gte("reference", prefix).lt("reference", `${prefix}\uffff`))
      : ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", companyId).gte("reference", prefix).lt("reference", `${prefix}\uffff`)),
    byTitle: (title) => kind === "jd"
      ? ctx.db.query("jdTasks").withSearchIndex("search_active_title", (q) => q.search("title", title).eq("companyId", companyId).eq("pausedAt", undefined))
      : ctx.db.query("oneTimeTasks").withSearchIndex("search_title", (q) => q.search("title", title).eq("companyId", companyId)),
    isVisible: async (task) => !("pausedAt" in task && task.pausedAt !== undefined) && await visible(ctx, companyId, membership, task, kind, auth),
  });
}

// Each kind searches its own table, so each gets its own query export; the
// palette fires both plus api.sops.search.
const paletteSearchArgs = { companyId: v.id("companies"), query: v.string() };

async function paletteSearch(ctx: QueryCtx, args: { companyId: Id<"companies">; query: string }, kind: TaskKind) {
  const needle = args.query.trim();
  if (!paletteSearchInput(needle)) return { tasks: [], truncated: false };
  const { membership, capabilities } = await requireMembership(ctx, args.companyId);
  const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
  const capabilityPrefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (!["any", "managed", "self"].some((scope) => auth.caps.has(`${capabilityPrefix}:view:${scope}` as Capability))) {
    return { tasks: [], truncated: false };
  }
  const { rows, truncated } =
    kind === "jd"
      ? await searchTasksOfKind(ctx, args.companyId, membership, auth, "jd", needle)
      : await searchTasksOfKind(ctx, args.companyId, membership, auth, "one_time", needle);
  const tasks = rows.map(({ _id, reference, title }) => ({ _id, reference, title }));
  return { tasks, truncated };
}

const paletteTaskResultValidator = v.object({
  tasks: v.array(v.object({ _id: v.union(v.id("jdTasks"), v.id("oneTimeTasks")), reference: v.string(), title: v.string() })),
  truncated: v.boolean(),
});

export const searchJd = query({
  args: paletteSearchArgs,
  returns: paletteTaskResultValidator,
  handler: async (ctx, args) => await paletteSearch(ctx, args, "jd"),
});

export const searchOneTime = query({
  args: paletteSearchArgs,
  returns: paletteTaskResultValidator,
  handler: async (ctx, args) => await paletteSearch(ctx, args, "one_time"),
});

// A mutation supplies fresh, uncached server time without changing any data.
export const getServerTime = mutation({
  args: { companyId: v.id("companies") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.companyId);
    return Date.now();
  },
});

export const getListPreference = query({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    return taskListPreferenceResult(args.taskType, preference);
  },
});

const customViewResultValidator = v.object({ orderedIds: v.array(v.string()), revision: v.number() });

export const getCustomView = query({
  args: { companyId: v.id("companies"), taskType: taskListTaskTypeValidator },
  returns: customViewResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const view = await ctx.db.query("taskCustomViews")
      .withIndex("by_companyId_and_membershipId_and_taskType", (q) => q.eq("companyId", args.companyId).eq("membershipId", membership._id).eq("taskType", args.taskType))
      .unique();
    return { orderedIds: view?.orderedIds ?? [], revision: view?.revision ?? 0 };
  },
});

export const saveCustomView = mutation({
  args: { companyId: v.id("companies"), taskType: taskListTaskTypeValidator, orderedIds: v.array(v.string()), expectedRevision: v.number() },
  returns: customViewResultValidator,
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    assertTaskListOrderInput(args.orderedIds);
    const view = await ctx.db.query("taskCustomViews")
      .withIndex("by_companyId_and_membershipId_and_taskType", (q) => q.eq("companyId", args.companyId).eq("membershipId", membership._id).eq("taskType", args.taskType))
      .unique();
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || (view?.revision ?? 0) !== args.expectedRevision) {
      throw new ConvexError("Task custom view was updated. Refresh and try again.");
    }
    const tasks = args.taskType === "jd"
      ? await validateTaskListOrder(ctx, args.companyId, membership, "jd", args.orderedIds, capabilities)
      : await validateTaskListOrder(ctx, args.companyId, membership, "one_time", args.orderedIds, capabilities);
    // Visible managed tasks are not necessarily the caller's own tasks.
    for (const task of tasks) {
      if (!task.assigneeMembershipIds.includes(membership._id)) throw new ConvexError("Task not found.");
    }
    const orderedIds = tasks.map((task) => task._id);
    const revision = args.expectedRevision + 1;
    if (view) await ctx.db.patch(view._id, { orderedIds, revision });
    else await ctx.db.insert("taskCustomViews", { companyId: args.companyId, membershipId: membership._id, taskType: args.taskType, orderedIds, revision });
    return { orderedIds, revision };
  },
});

export const setListSort = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    sort: taskListSortValidator,
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    assertTaskListSort(args.taskType, args.sort);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    if (preference) {
      await ctx.db.patch(preference._id, { sort: args.sort, revision, updatedAt: now });
      preferenceId = preference._id;
    } else if (args.taskType === "jd") {
      preferenceId = await ctx.db.insert("taskListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        taskType: "jd",
        sort: args.sort,
        revision,
        updatedAt: now,
      });
    } else {
      preferenceId = await ctx.db.insert("taskListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        taskType: "one_time",
        sort: args.sort,
        revision,
        updatedAt: now,
      });
    }

    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
  },
});

export const saveListOrder = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    orderedIds: v.array(v.string()),
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    assertTaskListOrderInput(args.orderedIds);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    if (args.taskType === "jd") {
      const tasks = await validateTaskListOrder(ctx, args.companyId, membership, "jd", args.orderedIds, capabilities);
      const customOrder = tasks.map((task) => task._id);
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, customOrder, orderFormat: "vector", revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "jd",
          sort: { mode: "custom" },
          customOrder,
          orderFormat: "vector",
          revision,
          updatedAt: now,
        });
      }
    } else {
      const tasks = await validateTaskListOrder(ctx, args.companyId, membership, "one_time", args.orderedIds, capabilities);
      const customOrder = tasks.map((task) => task._id);
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, customOrder, orderFormat: "vector", revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "one_time",
          sort: { mode: "custom" },
          customOrder,
          orderFormat: "vector",
          revision,
          updatedAt: now,
        });
      }
    }

    if (preference && preference.orderFormat !== "vector") {
      await ctx.scheduler.runAfter(0, internal.tasks.cleanupLegacyListOrder, { preferenceId });
    }
    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
  },
});

// Converted preferences no longer read these entries. Keep legacy preferences intact.
export const cleanupLegacyListOrder = internalMutation({
  args: { preferenceId: v.id("taskListPreferences") },
  returns: v.null(),
  handler: async (ctx, { preferenceId }) => {
    const preference = await ctx.db.get(preferenceId);
    if (!preference || preference.orderFormat !== "vector") return null;
    const entries = await ctx.db.query("taskListOrderEntries")
      .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
        q.eq("companyId", preference.companyId)
          .eq("membershipId", preference.membershipId)
          .eq("taskType", preference.taskType))
      .take(100);
    for (const entry of entries) await ctx.db.delete(entry._id);
    if (entries.length === 100) {
      await ctx.scheduler.runAfter(0, internal.tasks.cleanupLegacyListOrder, { preferenceId });
    }
    return null;
  },
});

export const moveListOrderTask = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    taskId: v.string(),
    orderKey: v.string(),
    rebalancedOrderKeys: v.optional(v.array(v.object({ taskId: v.string(), orderKey: v.string() }))),
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const orderKeyUpdates = args.rebalancedOrderKeys ?? [{ taskId: args.taskId, orderKey: args.orderKey }];
    assertTaskListOrderInput(orderKeyUpdates.map(({ taskId }) => taskId));
    for (const { orderKey } of orderKeyUpdates) assertTaskListOrderKey(orderKey);
    if (!orderKeyUpdates.some(({ taskId, orderKey }) => taskId === args.taskId && orderKey === args.orderKey)) {
      throw new ConvexError("Task list order position is invalid.");
    }
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    if (preference?.orderFormat === "vector") {
      throw new ConvexError("Task ordering has been upgraded. Reload this page before reordering.");
    }
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    await applyTaskListOrderKeyUpdates(ctx, args.companyId, membership, args.taskType, orderKeyUpdates, now, capabilities);
    if (args.taskType === "jd") {
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "jd",
          sort: { mode: "custom" },
          revision,
          updatedAt: now,
        });
      }
    } else {
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "one_time",
          sort: { mode: "custom" },
          revision,
          updatedAt: now,
        });
      }
    }

    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
  },
});

export const personalFilterOptions = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    if (args.kind === "jd") {
      const tasks = await ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).take(500);
      const values = new Set<string>();
      for (const t of tasks) {
        if (t.pausedAt === undefined && t.assigneeMembershipIds.includes(membership._id)) values.add(t.recurrence);
      }
      return { values: Array.from(values) };
    } else {
      const tasks = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      const values = new Set<string>();
      for (const t of tasks) {
        if (t.assigneeMembershipIds.includes(membership._id)) values.add(t.priority);
      }
      return { values: Array.from(values) };
    }
  },
});

export const getJd = query({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => {
    const { membership, company, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd", auth))) throw new ConvexError("Task not found.");
    const [canUpdate, canDelete, scoped] = await Promise.all([
      canUpdateTask(ctx, args.companyId, membership, task, "jd", auth),
      canDeleteTask(ctx, args.companyId, membership, task, "jd", auth),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
    ]);
    return { task: await withConfirmer(ctx, await enrichedJd(ctx, task, company.timeZone ?? defaultTimeZone, canUpdate, canDelete, scoped)), canUpdate, canDelete };
  },
});

export const createJd = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), time: v.optional(v.string()), quantity: v.optional(v.number()), recurrence: recurrenceValidator, evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())), assigneeMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, user, company, capabilities } = await requireCapability(ctx, args.companyId, "tasks:jd:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd", capabilities);
    if (args.confirmerMembershipId) await assertConfirmerInCompany(ctx, args.companyId, args.confirmerMembershipId);
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "jd");
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const id = await ctx.db.insert("jdTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), time: cleanOptionalText(args.time), quantity: cleanOptionalQuantity(args.quantity), recurrence: args.recurrence, cycleStartedAt: now, status: "due", statusCycleStart: effectiveCurrentJdCycle(calendar, args.recurrence, now, company.timeZone).start, evidenceRequired: args.evidenceRequired === true ? true : undefined, confirmerMembershipId: args.confirmerMembershipId ?? undefined, assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "jd", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "jd_task.create", targetType: "jdTask", targetId: id, createdAt: now });
    return id;
  },
});

export const updateJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), time: v.optional(v.string()), quantity: v.optional(v.number()), recurrence: recurrenceValidator, evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())), assigneeMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd", capabilities);
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    const confirmer = args.confirmerMembershipId === undefined ? task.confirmerMembershipId : args.confirmerMembershipId ?? undefined;
    if (confirmer !== task.confirmerMembershipId) {
      await assertConfirmerChangeAllowed(ctx, args.companyId, membership, task, "jd", capabilities, confirmer);
      // Only a newly chosen confirmer is validated, so a confirmer who later
      // lost the capability never blocks unrelated edits to the task.
      if (confirmer !== undefined) await assertConfirmerInCompany(ctx, args.companyId, confirmer);
    }
    const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
    if (assigneesChanged && args.assigneeMembershipIds.length) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd", capabilities);
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    // The stamp and cycleStartedAt live on the old recurrence's grid, so the
    // preservation/catch-up checks must use the old recurrence's current cycle.
    const oldCycleStart = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone).start;
    await preserveJdCompletionStamp(ctx, task, oldCycleStart, timeZone, calendar);
    await scheduleMissedJdCycleCatchUp(ctx, task, oldCycleStart, args.recurrence !== task.recurrence ? { recurrence: task.recurrence, cycleStartedAt: task.cycleStartedAt } : undefined, timeZone);
    const nextCycleStart = args.recurrence !== task.recurrence ? effectiveCurrentJdCycle(calendar, args.recurrence, now, timeZone).start : oldCycleStart;
    const nextTask = { ...task };
    nextTask.title = nonEmpty(args.title, "Task title");
    const desc = cleanOptionalText(args.description);
    if (desc === undefined) delete nextTask.description;
    else nextTask.description = desc;
    const n = cleanOptionalText(args.notes);
    if (n === undefined) delete nextTask.notes;
    else nextTask.notes = n;
    const t = cleanOptionalText(args.time);
    if (t === undefined) delete nextTask.time;
    else nextTask.time = t;
    const q = cleanOptionalQuantity(args.quantity);
    if (q === undefined) delete nextTask.quantity;
    else nextTask.quantity = q;
    nextTask.recurrence = args.recurrence;
    if (args.evidenceRequired !== undefined) {
      if (args.evidenceRequired) nextTask.evidenceRequired = true;
      else delete nextTask.evidenceRequired;
    }
    if (args.confirmerMembershipId !== undefined) {
      if (confirmer === undefined) delete nextTask.confirmerMembershipId;
      else nextTask.confirmerMembershipId = confirmer;
    }
    nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    if (args.recurrence !== task.recurrence) {
      await retireJdHistoryAtCycle(ctx, task._id, nextCycleStart, now);
      nextTask.cycleStartedAt = nextCycleStart;
      nextTask.status = "due";
      nextTask.statusCycleStart = nextCycleStart;
    }
    nextTask.updatedAt = now;
    await ctx.db.replace(args.taskId, nextTask);
    await applyConfirmerChange(ctx, { taskType: "jd", taskId: args.taskId, previousConfirmer: task.confirmerMembershipId, nextConfirmer: confirmer });
    return null;
  },
});

export const updateJdText = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), title: v.optional(v.string()), description: v.optional(v.string()), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.title === undefined && args.description === undefined && args.notes === undefined) return null;
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd", capabilities);
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateJdFields = mutation({
  args: {
    companyId: v.id("companies"),
    taskId: v.id("jdTasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    notes: v.optional(v.string()),
    time: v.optional(v.string()),
    quantity: v.optional(v.union(v.number(), v.null())),
    recurrence: v.optional(recurrenceValidator),
    evidenceRequired: v.optional(v.boolean()),
    confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())),
    assigneeMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
  },
  handler: async (ctx, args) => {
    const hasUpdate = args.title !== undefined || args.description !== undefined || args.notes !== undefined || args.time !== undefined || args.quantity !== undefined || args.recurrence !== undefined || args.evidenceRequired !== undefined || args.confirmerMembershipId !== undefined || args.assigneeMembershipIds !== undefined;
    if (!hasUpdate) return null;
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd", capabilities);
    const confirmer = args.confirmerMembershipId === undefined ? task.confirmerMembershipId : args.confirmerMembershipId ?? undefined;
    if (confirmer !== task.confirmerMembershipId) {
      await assertConfirmerChangeAllowed(ctx, args.companyId, membership, task, "jd", capabilities, confirmer);
      // Only a newly chosen confirmer is validated, so a confirmer who later
      // lost the capability never blocks unrelated edits to the task.
      if (confirmer !== undefined) await assertConfirmerInCompany(ctx, args.companyId, confirmer);
    }
    if (args.assigneeMembershipIds !== undefined) {
      requireTaskAssignee(args.assigneeMembershipIds);
      await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
      const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
      if (assigneesChanged) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd", capabilities);
    }
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const currentCycleStart = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone).start;
    await preserveJdCompletionStamp(ctx, task, currentCycleStart, timeZone, calendar);
    await scheduleMissedJdCycleCatchUp(ctx, task, currentCycleStart, args.recurrence !== undefined && args.recurrence !== task.recurrence ? { recurrence: task.recurrence, cycleStartedAt: task.cycleStartedAt } : undefined, timeZone);
    const nextCycleStart = args.recurrence !== undefined ? effectiveCurrentJdCycle(calendar, args.recurrence, now, timeZone).start : undefined;
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    if (args.time !== undefined) {
      const t = cleanOptionalText(args.time);
      if (t === undefined) delete nextTask.time;
      else nextTask.time = t;
    }
    if (args.quantity !== undefined) {
      const q = args.quantity === null ? undefined : cleanOptionalQuantity(args.quantity);
      if (q === undefined) delete nextTask.quantity;
      else nextTask.quantity = q;
    }
    if (args.recurrence !== undefined) {
      nextTask.recurrence = args.recurrence;
      if (args.recurrence !== task.recurrence) {
        await retireJdHistoryAtCycle(ctx, task._id, nextCycleStart!, now);
        nextTask.cycleStartedAt = nextCycleStart!;
        nextTask.status = "due";
        nextTask.statusCycleStart = nextCycleStart;
      }
    }
    if (args.assigneeMembershipIds !== undefined) nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    if (args.evidenceRequired !== undefined) {
      if (args.evidenceRequired) nextTask.evidenceRequired = true;
      else delete nextTask.evidenceRequired;
    }
    if (args.confirmerMembershipId !== undefined) {
      if (confirmer === undefined) delete nextTask.confirmerMembershipId;
      else nextTask.confirmerMembershipId = confirmer;
    }
    nextTask.updatedAt = now;
    await ctx.db.replace(args.taskId, nextTask);
    await applyConfirmerChange(ctx, { taskType: "jd", taskId: args.taskId, previousConfirmer: task.confirmerMembershipId, nextConfirmer: confirmer });
    return null;
  },
});

async function setJdStatus(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"jdTasks">, status: ManualStatus, note?: string, evidence?: EvidenceInput) {
  const { membership, capabilities } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanUpdateTaskStatus(ctx, companyId, membership, task, "jd", capabilities);
  if (task.pausedAt !== undefined) throw new ConvexError("Make this task active before changing its status.");
  const now = Date.now();
  const timeZone = await companyTimeZone(ctx, companyId);
  const calendar = await loadWorkCalendar(ctx, companyId);
  // On a non-working day the "current" cycle is the next working occurrence,
  // so a completion on an off day counts toward that occurrence.
  const cycle = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone);
  // Keep the click small: preserve the stamped cycle and schedule the full
  // historical catch-up instead of reconstructing up to 200 cycles inline.
  await preserveJdCompletionStamp(ctx, task, cycle.start, timeZone, calendar);
  await scheduleMissedJdCycleCatchUp(ctx, task, cycle.start);
  const existing = await currentJdCompletion(ctx, taskId, cycle.start);
  const alreadyCompleted = Boolean(existing) || (task.statusCycleStart === cycle.start && task.status === "completed");
  const previousStatus: TaskStatus = alreadyCompleted ? "completed" : task.statusCycleStart === cycle.start ? task.status : "due";
  if (status === "completed") {
    const activeEvidence = await activeTaskEvidence(ctx, "jd", taskId, cycle.start);
    if (activeEvidence) {
      // Two members can finish the same cycle from dialogs opened before
      // either saved. A retry of the recorded submission is an idempotent
      // no-op, but a different submission must not be reported as saved when
      // nothing was recorded (its uploads are discarded by the client).
      if (evidence && !evidenceMatchesSubmission(activeEvidence, evidence)) {
        throw new ConvexError("This task was already completed with different evidence.");
      }
    } else if (evidence) {
      const validated = await validateEvidenceInput(ctx, { companyId, membershipId: membership._id, evidence, now });
      await storeTaskEvidence(ctx, { companyId, taskType: "jd", taskId, cycleStart: cycle.start, createdByMembershipId: membership._id, now, evidence: validated });
    } else if (task.evidenceRequired === true && !alreadyCompleted) {
      // Reaffirming Completed is an idempotent no-op, so enabling the flag
      // after the fact must not strand the task in an unchangeable state.
      throw new ConvexError("Evidence is required to complete this task.");
    }
    const confirmer = task.confirmerMembershipId;
    const isConfirmer = confirmer !== undefined && confirmer === membership._id;
    // Losing tasks:confirm also loses the direct-completion bypass; submitting
    // a request addressed to yourself would leave the task stuck forever.
    if (isConfirmer && !alreadyCompleted && !capabilities.has("tasks:confirm")) {
      throw new ConvexError("You can no longer confirm this task. Ask an admin to choose a new confirmer.");
    }
    if (confirmer !== undefined && !isConfirmer && !alreadyCompleted) {
      // Someone other than the designated confirmer submitted: hold the
      // cycle. A retry for the same cycle keeps the original submission time.
      if (!(await pendingConfirmationRequest(ctx, "jd", taskId, cycle.start, task.recurrence))) {
        await ctx.db.insert("taskConfirmationRequests", {
          companyId,
          taskType: "jd",
          taskId,
          cycleStart: cycle.start,
          cycleEnd: occurrenceDeadline(calendar, task.recurrence, cycle.end, timeZone) ?? cycle.end,
          recurrence: task.recurrence,
          confirmerMembershipId: confirmer,
          submittedByMembershipId: membership._id,
          submittedAt: now,
        });
      }
      if (task.status !== "awaiting_confirmation" || task.statusCycleStart !== cycle.start) {
        await ctx.db.patch(taskId, { status: "awaiting_confirmation", statusCycleStart: cycle.start, updatedAt: now });
      }
      if (previousStatus !== "awaiting_confirmation") await logTaskActivity(ctx, { companyId, taskType: "jd", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: "awaiting_confirmation", createdAt: now });
      return;
    }
    const pending = await pendingConfirmationRequest(ctx, "jd", taskId, cycle.start, task.recurrence);
    if (pending) {
      if (isConfirmer) {
        // The confirmer completing the task in the ordinary flow approves the
        // submission, keeping its original time and author.
        await resolveConfirmationRequest(ctx, pending, membership._id, now);
        return;
      }
      // A task without a confirmer has no live submission to resolve.
      await ctx.db.delete(pending._id);
    }
    if (!existing) await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: taskId, cycleStart: cycle.start, cycleEnd: occurrenceDeadline(calendar, task.recurrence, cycle.end, timeZone) ?? cycle.end, completedByMembershipId: membership._id, completedAt: now, note: cleanOptionalText(note) });
  } else {
    // Withdrawing a submission deletes its request along with its evidence.
    const pending = await pendingConfirmationRequest(ctx, "jd", taskId, cycle.start, task.recurrence);
    if (pending) await ctx.db.delete(pending._id);
    await deleteActiveTaskEvidence(ctx, "jd", taskId, cycle.start);
    if (existing) await ctx.db.delete(existing._id);
  }
  // A retry against a task row that already carries this status and cycle is
  // a no-op; only inconsistent rows (e.g. a drifted status) need the write.
  if (task.status !== status || task.statusCycleStart !== cycle.start) {
    await ctx.db.patch(taskId, { status, statusCycleStart: cycle.start, updatedAt: now });
  }
  if (previousStatus !== status) await logTaskActivity(ctx, { companyId, taskType: "jd", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: status, createdAt: now });
}

export const setJdPausedBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("jdTasks")), paused: v.boolean() },
  handler: async (ctx, args) => {
    const { membership, company, capabilities } = await requireCapability(ctx, args.companyId, args.paused ? "tasks:jd:pause" : "tasks:jd:resume");
    if (args.taskIds.length === 0 || args.taskIds.length > 100 || new Set(args.taskIds).size !== args.taskIds.length) {
      throw new ConvexError("Select between 1 and 100 unique tasks.");
    }
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const now = Date.now();
    const timeZone = company.timeZone ?? defaultTimeZone;
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    // All checks and writes share one transaction: a stale or forbidden row
    // rejects the entire selection, rather than partially changing it.
    for (const taskId of args.taskIds) {
      const task = await ctx.db.get(taskId);
      if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd", auth))) throw new ConvexError("Task not found.");
      if (!(await canManageJdLifecycle(ctx, args.companyId, membership, task, auth, args.paused))) throw new ConvexError("You can only make tasks active or inactive within your managed scope.");
      if ((task.pausedAt !== undefined) === args.paused) continue; // Retry-safe.
      await transitionJdTaskActiveState(ctx, { companyId: args.companyId, task, paused: args.paused, actorMembershipId: membership._id, now, timeZone, calendar });
    }
    return null;
  },
});

// One active/inactive transition for a JD task, shared by the bulk mutation
// and the import commit path. Callers authorize and guard no-ops first.
export async function transitionJdTaskActiveState(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    task: Doc<"jdTasks">;
    paused: boolean;
    actorMembershipId: Id<"companyMemberships">;
    now: number;
    timeZone: string;
    calendar: WorkCalendar;
  },
) {
  const { task } = args;
  const cycle = effectiveCurrentJdCycle(args.calendar, task.recurrence, args.now, args.timeZone);
  if (args.paused) {
    await preserveJdCompletionStamp(ctx, task, cycle.start + 1, args.timeZone, args.calendar);
    // Freeze both the grid and deadline bound. Deferred catch-up may keep
    // pre-pause history, but must never turn suspended deadlines into misses.
    await ctx.scheduler.runAfter(0, internal.tasks.catchUpMissedJdCycles, {
      taskId: task._id, schedule: { recurrence: task.recurrence, cycleStartedAt: task.cycleStartedAt, through: cycle.start, deadlineThrough: args.now },
    });
    await ctx.db.patch(task._id, { pausedAt: args.now, overdueAt: undefined, updatedAt: args.now });
  } else {
    // Rejoin the existing calendar grid, not a backlog of suspended cycles.
    // Keep same-cycle completion rows: resuming must not erase history.
    const sameCycle = task.statusCycleStart === cycle.start;
    await ctx.db.patch(task._id, { pausedAt: undefined, cycleStartedAt: cycle.start, status: sameCycle ? task.status : "due", statusCycleStart: cycle.start, overdueAt: undefined, updatedAt: args.now });
  }
  await logTaskActivity(ctx, { companyId: args.companyId, taskType: "jd", taskId: task._id, actorMembershipId: args.actorMembershipId, event: args.paused ? "paused" : "resumed", createdAt: args.now });
}

export const updateJdStatus = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), status: statusValidator, evidence: v.optional(evidenceInputValidator) },
  handler: async (ctx, args) => { await setJdStatus(ctx, args.companyId, args.taskId, args.status, undefined, args.evidence); return null; },
});

export const completeJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), note: v.optional(v.string()), evidence: v.optional(evidenceInputValidator) },
  handler: async (ctx, args) => { await setJdStatus(ctx, args.companyId, args.taskId, "completed", args.note, args.evidence); return null; },
});

export const listJdCycleRecords = query({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd", auth))) throw new ConvexError("Task not found.");
    return await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", args.taskId)).order("desc").take(100);
  },
});

/** Deferred per-task catch-up scheduled by interactive mutations. Idempotent. */
export const catchUpMissedJdCycles = internalMutation({
  args: { taskId: v.id("jdTasks"), schedule: v.optional(v.object({ recurrence: recurrenceValidator, cycleStartedAt: v.number(), through: v.optional(v.number()), stoppedAt: v.optional(v.number()), deadlineThrough: v.optional(v.number()) })) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    if (args.schedule) {
      // The initiating mutation already replaced the task's recurrence and
      // cycleStartedAt, so the old grid only exists in this snapshot. The
      // legacy completion stamp was preserved synchronously, and the new
      // grid's cycleStartedAt must not move from here.
      const timeZone = await companyTimeZone(ctx, task.companyId);
      const calendar = await loadWorkCalendar(ctx, task.companyId);
      // An older recurrence snapshot can outlive a pause and resume. The
      // first subsequent pause permanently caps its deadlines, even after
      // later resumes or further pauses remove/replace task.pausedAt.
      const firstPause = args.schedule.deadlineThrough === undefined
        ? await ctx.db.query("taskActivityLogs")
          .withIndex("by_taskType_and_taskId_and_event_and_createdAt", (q) => q.eq("taskType", "jd").eq("taskId", task._id).eq("event", "paused").gte("createdAt", args.schedule!.stoppedAt ?? args.schedule!.through ?? task.createdAt))
          .first()
        : null;
      const deadlineThrough = args.schedule.deadlineThrough ?? firstPause?.createdAt;
      const now = Math.min(Date.now(), deadlineThrough ?? Infinity);
      // `through` freezes the walk's bound at the grid position where the old
      // schedule stopped — cycles after the recurrence change are not the old
      // schedule's to record.
      const throughStart = args.schedule.through ?? currentJdCycle(args.schedule.recurrence, now, timeZone).start;
      const { occurrences, nextActiveAt } = elapsedJdOccurrences(calendar, args.schedule.recurrence, args.schedule.cycleStartedAt, now, 200, timeZone, throughStart);
      const completionThrough = args.schedule.stoppedAt ?? args.schedule.deadlineThrough ?? now;
      // The two index lookups per elapsed cycle now run in parallel; each
      // stays bounded to its own cycle start so retired rows from older,
      // denser grids are never scanned.
      const perCycle = await Promise.all(
        occurrences.map((cycle) =>
          Promise.all([
            // Credit work belonging to this grid when it stopped. Deadlines
            // depend on the mutable calendar, so they are not cycle identity.
            // Earlier retired grids and work completed after the stop do not count.
            ctx.db.query("jdTaskCompletions")
              .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).eq("cycleStart", cycle.start))
              .filter((q) => q.and(
                q.or(q.eq(q.field("retiredAt"), undefined), q.gte(q.field("retiredAt"), completionThrough)),
                q.lte(q.field("completedAt"), completionThrough),
              ))
              .first(),
            ctx.db.query("jdTaskCycleRecords")
              .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).eq("cycleStart", cycle.start))
              .filter((q) => q.eq(q.field("cycleEnd"), cycle.deadline))
              .first(),
            pendingConfirmationRequest(ctx, "jd", task._id, cycle.start, args.schedule!.recurrence),
          ] as const),
        ),
      );
      for (let i = 0; i < occurrences.length; i++) {
        const cycle = occurrences[i];
        const [done, recorded, pending] = perCycle[i];
        if (!done && !recorded && !pending) {
          await ctx.db.insert("jdTaskCycleRecords", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.deadline, status: "missed", recordedAt: now });
        }
      }
      // The batch cap may leave elapsed old-grid cycles unprocessed; continue
      // from the first unprocessed start so the tail of history is not lost.
      if (occurrences.length === 200) {
        await ctx.scheduler.runAfter(0, internal.tasks.catchUpMissedJdCycles, {
          taskId: args.taskId,
          schedule: { ...args.schedule, cycleStartedAt: nextActiveAt, deadlineThrough },
        });
      } else if (deadlineThrough === undefined && nextActiveAt < throughStart) {
        // The walk stopped at an old-grid occurrence whose shifted deadline is
        // still pending. The task's new-grid floor will never revisit it, so
        // schedule the one re-check that records it if it goes undone — still
        // bounded by the same change instant.
        const deadline = occurrenceDeadline(calendar, args.schedule.recurrence, nextJdCycleStart(nextActiveAt, args.schedule.recurrence, timeZone), timeZone);
        if (deadline !== null && deadline > now) {
          await ctx.scheduler.runAfter(deadline - now, internal.tasks.catchUpMissedJdCycles, {
            taskId: args.taskId,
            schedule: { ...args.schedule, cycleStartedAt: nextActiveAt, through: throughStart },
          });
        }
      }
      return null;
    }
    await recordMissedJdCycles(ctx, task);
    return null;
  },
});

export const recordMissedJdCyclesBatch = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const timeZones = new Map<Id<"companies">, Promise<string>>();
    const calendars = new Map<Id<"companies">, Promise<WorkCalendar>>();
    const page = await ctx.db.query("jdTasks").paginate({ numItems: 10, cursor: args.cursor ?? null });
    for (const task of page.page) {
      if (task.pausedAt !== undefined) continue;
      // Skip the catch-up entirely when no cycle has elapsed for this task:
      // the cron scans every JD task hourly, so the common case must not
      // touch completion/cycle-record reads at all.
      const timeZone = await (timeZones.get(task.companyId) ?? timeZones.set(task.companyId, companyTimeZone(ctx, task.companyId)).get(task.companyId)!);
      if (currentJdCycle(task.recurrence, now, timeZone).start > task.cycleStartedAt) {
        const calendar = await (calendars.get(task.companyId) ?? calendars.set(task.companyId, loadWorkCalendar(ctx, task.companyId)).get(task.companyId)!);
        await recordMissedJdCycles(ctx, task, now, timeZone, calendar);
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.recordMissedJdCyclesBatch, { cursor: page.continueCursor });
    return page.page.length;
  },
});

export const clearMissedJdCyclesBatch = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const page = args.companyId
      ? await ctx.db
          .query("jdTaskCycleRecords")
          .withIndex("by_companyId_and_cycleEnd", (q) => q.eq("companyId", args.companyId!))
          .paginate({ numItems: 250, cursor: args.cursor ?? null })
      : await ctx.db
          .query("jdTaskCycleRecords")
          .paginate({ numItems: 250, cursor: args.cursor ?? null });

    for (const record of page.page) {
      await ctx.db.delete(record._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.clearMissedJdCyclesBatch, {
        companyId: args.companyId,
        cursor: page.continueCursor,
      });
    }
    return { deleted: page.page.length, isDone: page.isDone };
  },
});

export const resetJdTaskCyclesBatch = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const page = args.companyId
      ? await ctx.db
          .query("jdTasks")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
          .paginate({ numItems: 100, cursor: args.cursor ?? null })
      : await ctx.db
          .query("jdTasks")
          .paginate({ numItems: 100, cursor: args.cursor ?? null });

    const timeZones = new Map<Id<"companies">, Promise<string>>();
    const calendars = new Map<Id<"companies">, Promise<WorkCalendar>>();
    for (const task of page.page) {
      const timeZone = await (timeZones.get(task.companyId) ?? timeZones.set(task.companyId, companyTimeZone(ctx, task.companyId)).get(task.companyId)!);
      const calendar = await (calendars.get(task.companyId) ?? calendars.set(task.companyId, loadWorkCalendar(ctx, task.companyId)).get(task.companyId)!);
      const current = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone);
      await ctx.db.patch(task._id, {
        cycleStartedAt: current.start,
        statusCycleStart: current.start,
        status: "due",
        updatedAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.resetJdTaskCyclesBatch, {
        companyId: args.companyId,
        now,
        cursor: page.continueCursor,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.tasks.clearMissedJdCyclesBatch, {
        companyId: args.companyId,
      });
    }
    return { reset: page.page.length, isDone: page.isDone };
  },
});

export const resetAndClearMissedJdCycles = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.tasks.resetJdTaskCyclesBatch, {
      companyId: args.companyId,
      now: args.now ?? Date.now(),
    });
    return { status: "scheduled" };
  },
});

export const countMissedJdCycles = internalQuery({
  args: {
    companyId: v.optional(v.id("companies")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const max = Math.min(args.limit ?? 5000, 5000);
    const records = args.companyId
      ? await ctx.db
          .query("jdTaskCycleRecords")
          .withIndex("by_companyId_and_cycleEnd", (q) => q.eq("companyId", args.companyId!))
          .take(max + 1)
      : await ctx.db.query("jdTaskCycleRecords").take(max + 1);
    const hasMore = records.length > max;
    return { count: hasMore ? max : records.length, hasMore };
  },
});

export const getOneTime = query({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "one_time", auth))) throw new ConvexError("Task not found.");
    const [canUpdate, canDelete, scoped] = await Promise.all([
      canUpdateTask(ctx, args.companyId, membership, task, "one_time", auth),
      canDeleteTask(ctx, args.companyId, membership, task, "one_time", auth),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
    ]);
    return { task: await withConfirmer(ctx, await enrichedOneTime(ctx, task, canUpdate, canDelete, scoped)), canUpdate, canDelete };
  },
});

export const createOneTime = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), time: v.optional(v.string()), quantity: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: priorityValidator, evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())) },
  handler: async (ctx, args) => {
    const { membership, user, capabilities } = await requireCapability(ctx, args.companyId, "tasks:one_time:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time", capabilities);
    if (args.confirmerMembershipId) await assertConfirmerInCompany(ctx, args.companyId, args.confirmerMembershipId);
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "one_time");
    const id = await ctx.db.insert("oneTimeTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), dueDate: args.dueDate, time: cleanOptionalText(args.time), quantity: cleanOptionalQuantity(args.quantity), assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, priority: args.priority, status: "due", evidenceRequired: args.evidenceRequired === true ? true : undefined, confirmerMembershipId: args.confirmerMembershipId ?? undefined, createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "one_time", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "one_time_task.create", targetType: "oneTimeTask", targetId: id, createdAt: now });
    return id;
  },
});

export const updateOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), time: v.optional(v.string()), quantity: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: priorityValidator, evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time", capabilities);
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    const confirmer = args.confirmerMembershipId === undefined ? task.confirmerMembershipId : args.confirmerMembershipId ?? undefined;
    if (confirmer !== task.confirmerMembershipId) {
      await assertConfirmerChangeAllowed(ctx, args.companyId, membership, task, "one_time", capabilities, confirmer);
      // Only a newly chosen confirmer is validated, so a confirmer who later
      // lost the capability never blocks unrelated edits to the task.
      if (confirmer !== undefined) await assertConfirmerInCompany(ctx, args.companyId, confirmer);
    }
    const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
    if (assigneesChanged && args.assigneeMembershipIds.length) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time", capabilities);
    const nextTask = { ...task };
    nextTask.title = nonEmpty(args.title, "Task title");
    const desc = cleanOptionalText(args.description);
    if (desc === undefined) delete nextTask.description;
    else nextTask.description = desc;
    const n = cleanOptionalText(args.notes);
    if (n === undefined) delete nextTask.notes;
    else nextTask.notes = n;
    if (args.dueDate === undefined) delete nextTask.dueDate;
    else nextTask.dueDate = args.dueDate;
    const t = cleanOptionalText(args.time);
    if (t === undefined) delete nextTask.time;
    else nextTask.time = t;
    const q = cleanOptionalQuantity(args.quantity);
    if (q === undefined) delete nextTask.quantity;
    else nextTask.quantity = q;
    nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    nextTask.priority = args.priority;
    if (args.evidenceRequired !== undefined) {
      if (args.evidenceRequired) nextTask.evidenceRequired = true;
      else delete nextTask.evidenceRequired;
    }
    if (args.confirmerMembershipId !== undefined) {
      if (confirmer === undefined) delete nextTask.confirmerMembershipId;
      else nextTask.confirmerMembershipId = confirmer;
    }
    reconcileOneTimeOverdue(nextTask);
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    await applyConfirmerChange(ctx, { taskType: "one_time", taskId: args.taskId, previousConfirmer: task.confirmerMembershipId, nextConfirmer: confirmer });
    return null;
  },
});

export const updateOneTimeText = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), title: v.optional(v.string()), description: v.optional(v.string()), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.title === undefined && args.description === undefined && args.notes === undefined) return null;
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time", capabilities);
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateOneTimeFields = mutation({
  args: {
    companyId: v.id("companies"),
    taskId: v.id("oneTimeTasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    notes: v.optional(v.string()),
    dueDate: v.optional(v.union(v.number(), v.null())),
    time: v.optional(v.string()),
    quantity: v.optional(v.union(v.number(), v.null())),
    assigneeMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
    priority: v.optional(priorityValidator),
    evidenceRequired: v.optional(v.boolean()),
    confirmerMembershipId: v.optional(v.union(v.id("companyMemberships"), v.null())),
  },
  handler: async (ctx, args) => {
    const hasUpdate = args.title !== undefined || args.description !== undefined || args.notes !== undefined || args.dueDate !== undefined || args.time !== undefined || args.quantity !== undefined || args.assigneeMembershipIds !== undefined || args.priority !== undefined || args.evidenceRequired !== undefined || args.confirmerMembershipId !== undefined;
    if (!hasUpdate) return null;
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time", capabilities);
    const confirmer = args.confirmerMembershipId === undefined ? task.confirmerMembershipId : args.confirmerMembershipId ?? undefined;
    if (confirmer !== task.confirmerMembershipId) {
      await assertConfirmerChangeAllowed(ctx, args.companyId, membership, task, "one_time", capabilities, confirmer);
      // Only a newly chosen confirmer is validated, so a confirmer who later
      // lost the capability never blocks unrelated edits to the task.
      if (confirmer !== undefined) await assertConfirmerInCompany(ctx, args.companyId, confirmer);
    }
    if (args.assigneeMembershipIds !== undefined) {
      requireTaskAssignee(args.assigneeMembershipIds);
      await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
      const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
      if (assigneesChanged) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time", capabilities);
    }
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    if (args.dueDate !== undefined) {
      if (args.dueDate === null) delete nextTask.dueDate;
      else nextTask.dueDate = args.dueDate;
    }
    if (args.time !== undefined) {
      const t = cleanOptionalText(args.time);
      if (t === undefined) delete nextTask.time;
      else nextTask.time = t;
    }
    if (args.quantity !== undefined) {
      const q = args.quantity === null ? undefined : cleanOptionalQuantity(args.quantity);
      if (q === undefined) delete nextTask.quantity;
      else nextTask.quantity = q;
    }
    if (args.assigneeMembershipIds !== undefined) nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    if (args.priority !== undefined) nextTask.priority = args.priority;
    if (args.evidenceRequired !== undefined) {
      if (args.evidenceRequired) nextTask.evidenceRequired = true;
      else delete nextTask.evidenceRequired;
    }
    if (args.confirmerMembershipId !== undefined) {
      if (confirmer === undefined) delete nextTask.confirmerMembershipId;
      else nextTask.confirmerMembershipId = confirmer;
    }
    reconcileOneTimeOverdue(nextTask);
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    await applyConfirmerChange(ctx, { taskType: "one_time", taskId: args.taskId, previousConfirmer: task.confirmerMembershipId, nextConfirmer: confirmer });
    return null;
  },
});

async function setOneTimeStatus(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"oneTimeTasks">, status: ManualStatus, evidence?: EvidenceInput) {
  const { membership, capabilities } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanUpdateTaskStatus(ctx, companyId, membership, task, "one_time", capabilities);
  const state = oneState(task);
  if (state.isOverdue) {
    if (!task.overdueAt) await ctx.db.patch(taskId, { overdueAt: Date.now(), updatedAt: Date.now() });
    throw new ConvexError("Overdue tasks are locked and cannot be changed back.");
  }
  const now = Date.now();
  const previousStatus = state.rawStatus as TaskStatus;
  if (status === "completed") {
    const activeEvidence = await activeTaskEvidence(ctx, "one_time", taskId);
    if (activeEvidence) {
      // Keep a retry idempotent, but never report a different submission as
      // saved when the task already holds someone else's evidence.
      if (evidence && !evidenceMatchesSubmission(activeEvidence, evidence)) {
        throw new ConvexError("This task was already completed with different evidence.");
      }
      // The completion is already recorded; rewriting the row would move the
      // stamp to the retry time and actor.
      if (previousStatus === "completed") return null;
    } else if (evidence) {
      const validated = await validateEvidenceInput(ctx, { companyId, membershipId: membership._id, evidence, now });
      await storeTaskEvidence(ctx, { companyId, taskType: "one_time", taskId, createdByMembershipId: membership._id, now, evidence: validated });
    } else if (task.evidenceRequired === true && previousStatus !== "completed") {
      // Reaffirming Completed is an idempotent no-op, so enabling the flag
      // after the fact must not strand the task in an unchangeable state.
      throw new ConvexError("Evidence is required to complete this task.");
    }
    const confirmer = task.confirmerMembershipId;
    const isConfirmer = confirmer !== undefined && confirmer === membership._id;
    // Losing tasks:confirm also loses the direct-completion bypass; submitting
    // a request addressed to yourself would leave the task stuck forever.
    if (isConfirmer && task.status !== "completed" && !capabilities.has("tasks:confirm")) {
      throw new ConvexError("You can no longer confirm this task. Ask an admin to choose a new confirmer.");
    }
    if (confirmer !== undefined && !isConfirmer && task.status !== "completed") {
      // Someone other than the designated confirmer submitted. A retry keeps
      // the original submission time instead of moving the stamp.
      if (!(await pendingConfirmationRequest(ctx, "one_time", taskId))) {
        await ctx.db.insert("taskConfirmationRequests", {
          companyId,
          taskType: "one_time",
          taskId,
          recurrence: null,
          confirmerMembershipId: confirmer,
          submittedByMembershipId: membership._id,
          submittedAt: now,
        });
      }
      if (task.status !== "awaiting_confirmation" || task.completedAt !== undefined) {
        const awaiting = { ...task, status: "awaiting_confirmation" as const, updatedAt: now };
        delete awaiting.completedAt;
        delete awaiting.completedByMembershipId;
        await ctx.db.replace(taskId, awaiting);
      }
      if (previousStatus !== "awaiting_confirmation") await logTaskActivity(ctx, { companyId, taskType: "one_time", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: "awaiting_confirmation", createdAt: now });
      return null;
    }
    const pending = await pendingConfirmationRequest(ctx, "one_time", taskId);
    if (pending) {
      if (isConfirmer) {
        // The confirmer completing the task in the ordinary flow approves the
        // submission, keeping its original time and author.
        await resolveConfirmationRequest(ctx, pending, membership._id, now);
        return null;
      }
      // A task without a confirmer has no live submission to resolve.
      await ctx.db.delete(pending._id);
    }
  } else {
    // Withdrawing a submission deletes its request along with its evidence.
    const pending = await pendingConfirmationRequest(ctx, "one_time", taskId);
    if (pending) await ctx.db.delete(pending._id);
    await deleteActiveTaskEvidence(ctx, "one_time", taskId);
  }
  const nextTask = { ...task, status, updatedAt: now };
  if (status === "completed") {
    nextTask.completedAt = now;
    nextTask.completedByMembershipId = membership._id;
  } else {
    delete nextTask.completedAt;
    delete nextTask.completedByMembershipId;
  }
  await ctx.db.replace(taskId, nextTask);
  if (previousStatus !== status) await logTaskActivity(ctx, { companyId, taskType: "one_time", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: status, createdAt: now });
}

export const updateOneTimeStatus = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), status: statusValidator, evidence: v.optional(evidenceInputValidator) },
  handler: async (ctx, args) => { await setOneTimeStatus(ctx, args.companyId, args.taskId, args.status, args.evidence); return null; },
});

export const completeOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), evidence: v.optional(evidenceInputValidator) },
  handler: async (ctx, args) => { await setOneTimeStatus(ctx, args.companyId, args.taskId, "completed", args.evidence); return null; },
});

export const confirmTaskCompletion = mutation({
  args: { companyId: v.id("companies"), requestId: v.id("taskConfirmationRequests") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:confirm");
    const request = await ctx.db.get(args.requestId);
    // A retry after the request was resolved has nothing left to confirm.
    if (!request) return null;
    if (request.companyId !== args.companyId || request.confirmerMembershipId !== membership._id) throw new ConvexError("Confirmation request not found.");
    await resolveConfirmationRequest(ctx, request, membership._id, Date.now());
    return null;
  },
});

export const sendBackTaskCompletion = mutation({
  args: { companyId: v.id("companies"), requestId: v.id("taskConfirmationRequests") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:confirm");
    const request = await ctx.db.get(args.requestId);
    if (!request) return null;
    if (request.companyId !== args.companyId || request.confirmerMembershipId !== membership._id) throw new ConvexError("Confirmation request not found.");
    const now = Date.now();
    await deleteActiveTaskEvidence(ctx, request.taskType, request.taskId, request.cycleStart);
    if (request.taskType === "jd") {
      const taskId = ctx.db.normalizeId("jdTasks", request.taskId);
      const task = taskId ? await ctx.db.get(taskId) : null;
      if (taskId && task && task.companyId === args.companyId && request.cycleStart !== undefined) {
        if (request.recurrence !== task.recurrence) {
          // A submission from a superseded grid becomes retired missed
          // history; the current grid's status and records stay untouched.
          if (request.cycleEnd !== undefined) {
            await ctx.db.insert("jdTaskCycleRecords", { companyId: args.companyId, jdTaskId: taskId, cycleStart: request.cycleStart, cycleEnd: request.cycleEnd, status: "missed", recordedAt: now, retiredAt: now });
          }
        } else {
          const timeZone = await companyTimeZone(ctx, args.companyId);
          const calendar = await loadWorkCalendar(ctx, args.companyId);
          const currentCycleStart = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone).start;
          if (request.cycleStart === currentCycleStart) {
            await ctx.db.patch(taskId, { status: "in_progress", statusCycleStart: request.cycleStart, updatedAt: now });
            await logTaskActivity(ctx, { companyId: args.companyId, taskType: "jd", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: "awaiting_confirmation", toStatus: "in_progress", createdAt: now });
          } else if (request.cycleEnd !== undefined && !(await currentJdCycleRecord(ctx, taskId, request.cycleStart))) {
            // Catch-up deferred this elapsed cycle while it was pending; it is
            // missed now that the submission is rejected.
            await ctx.db.insert("jdTaskCycleRecords", { companyId: args.companyId, jdTaskId: taskId, cycleStart: request.cycleStart, cycleEnd: request.cycleEnd, status: "missed", recordedAt: now });
          }
        }
      }
    } else {
      const taskId = ctx.db.normalizeId("oneTimeTasks", request.taskId);
      const task = taskId ? await ctx.db.get(taskId) : null;
      if (taskId && task && task.companyId === args.companyId && task.status === "awaiting_confirmation") {
        await ctx.db.patch(taskId, { status: "in_progress", completedAt: undefined, completedByMembershipId: undefined, updatedAt: now });
        await logTaskActivity(ctx, { companyId: args.companyId, taskType: "one_time", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: "awaiting_confirmation", toStatus: "in_progress", createdAt: now });
      }
    }
    await ctx.db.delete(request._id);
    return null;
  },
});

const DELETE_RELATED_BATCH = 500;
const DELETE_BULK_TASK_LIMIT = 100;

/**
 * Deletes one batch of a task's related rows per call. Returns true while any
 * table still had rows for the task so the caller can re-schedule itself —
 * related-row volume is unbounded, so the purge must not live in a single
 * transaction. Idempotent: rows are keyed by taskId, so re-runs only pick up
 * what remains.
 */
async function deleteTaskRelatedBatch(ctx: MutationCtx, taskType: TaskKind, taskId: string): Promise<boolean> {
  if (await deleteTaskEvidenceBatch(ctx, taskType, taskId)) return true;
  const loaders: (() => Promise<{ _id: Id<"jdTaskCompletions" | "jdTaskCycleRecords" | "taskConfirmationRequests" | "taskComments" | "taskActivityLogs" | "taskAttachments">; storageId?: Id<"_storage"> }[]>)[] = [];
  if (taskType === "jd") {
    const jdTaskId = taskId as Id<"jdTasks">;
    loaders.push(
      () => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).take(DELETE_RELATED_BATCH),
      () => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).take(DELETE_RELATED_BATCH),
    );
  }
  loaders.push(
    () => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
    () => ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
    () => ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
    () => ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
  );
  for (const load of loaders) {
    const rows = await load();
    if (!rows.length) continue;
    for (const row of rows) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    return true;
  }
  return false;
}

/**
 * Continues a task's related-row purge in a fresh transaction after the
 * initiating delete commits. Same pattern as aiChat.deleteSessionMessages.
 */
export const purgeTaskRelatedRows = internalMutation({
  args: { taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const more = await deleteTaskRelatedBatch(ctx, args.taskType, args.taskId);
    if (more) await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, args);
    return null;
  },
});

async function purgeJdTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"jdTasks">) {
  const { membership, user, capabilities } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "jd", capabilities);
  // Deleting the task doc makes its related rows unreachable (all reads go
  // through task visibility); the scheduled purge reclaims them in batches.
  await ctx.db.delete(taskId);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, { taskType: "jd", taskId });
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "jd_task.delete", targetType: "jdTask", targetId: taskId, createdAt: now });
}

async function purgeOneTimeTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"oneTimeTasks">) {
  const { membership, user, capabilities } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "one_time", capabilities);
  await ctx.db.delete(taskId);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, { taskType: "one_time", taskId });
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "one_time_task.delete", targetType: "oneTimeTask", targetId: taskId, createdAt: now });
}

export const deleteJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => { await purgeJdTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteJdBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("jdTasks")) },
  handler: async (ctx, args) => {
    if (args.taskIds.length > DELETE_BULK_TASK_LIMIT) throw new ConvexError(`Select at most ${DELETE_BULK_TASK_LIMIT} tasks to delete at once.`);
    for (const taskId of args.taskIds) await purgeJdTask(ctx, args.companyId, taskId);
    return null;
  },
});

export const deleteOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => { await purgeOneTimeTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteOneTimeBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("oneTimeTasks")) },
  handler: async (ctx, args) => {
    if (args.taskIds.length > DELETE_BULK_TASK_LIMIT) throw new ConvexError(`Select at most ${DELETE_BULK_TASK_LIMIT} tasks to delete at once.`);
    for (const taskId of args.taskIds) await purgeOneTimeTask(ctx, args.companyId, taskId);
    return null;
  },
});

export const listComments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, auth);
    const page = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId)).order("desc").paginate(args.paginationOpts);
    const authors = await enrich(ctx, page.page.map((comment) => comment.authorMembershipId));
    const authorById = new Map(authors.map((author) => [author.membership._id, author]));
    return { ...page, page: page.page.map((comment) => ({ ...comment, author: authorById.get(comment.authorMembershipId) ?? null })) };
  },
});

export const listActivity = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, auth);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 100);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").take(limit + 1);
    const logs = await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").take(limit + 1);
    const actors = await enrich(ctx, [...comments.map((comment) => comment.authorMembershipId), ...logs.map((log) => log.actorMembershipId)]);
    const actorById = new Map(actors.map((actor) => [actor.membership._id, actor]));
    const items = [
      ...comments.map((comment) => ({ kind: "comment" as const, _id: comment._id, body: comment.body, event: null, fromStatus: null, toStatus: null, actorMembershipId: comment.authorMembershipId, actor: actorById.get(comment.authorMembershipId) ?? null, createdAt: comment.createdAt })),
      ...logs.map((log) => ({ kind: "log" as const, _id: log._id, body: null, event: log.event, fromStatus: log.fromStatus ?? null, toStatus: log.toStatus ?? null, actorMembershipId: log.actorMembershipId, actor: actorById.get(log.actorMembershipId) ?? null, createdAt: log.createdAt })),
    ].sort((a, b) => b.createdAt - a.createdAt);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  },
});

export const addComment = mutation({ args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), body: v.string() }, handler: async (ctx, args) => { const { membership, capabilities } = await requireCapability(ctx, args.companyId, "tasks:comment"); const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities)); const body = nonEmpty(args.body, "Comment"); return await ctx.db.insert("taskComments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, authorMembershipId: membership._id, body, createdAt: Date.now() }); } });

export const updateComment = mutation({ args: { companyId: v.id("companies"), commentId: v.id("taskComments"), body: v.string() }, handler: async (ctx, args) => { const { membership, capabilities } = await requireCapability(ctx, args.companyId, "tasks:comment"); const comment = await ctx.db.get(args.commentId); if (!comment || comment.companyId !== args.companyId || comment.authorMembershipId !== membership._id) throw new ConvexError("Comment not found."); await getVisibleTask(ctx, args.companyId, membership, comment.taskType, comment.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities)); await ctx.db.patch(args.commentId, { body: nonEmpty(args.body, "Comment") }); return null; } });

export const deleteComment = mutation({ args: { companyId: v.id("companies"), commentId: v.id("taskComments") }, handler: async (ctx, args) => { const { membership, capabilities } = await requireCapability(ctx, args.companyId, "tasks:comment"); const comment = await ctx.db.get(args.commentId); if (!comment || comment.companyId !== args.companyId || comment.authorMembershipId !== membership._id) throw new ConvexError("Comment not found."); await getVisibleTask(ctx, args.companyId, membership, comment.taskType, comment.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities)); await ctx.db.delete(args.commentId); return null; } });

export const generateAttachmentUploadUrl = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const claimId = await ctx.db.insert("taskUploadClaims", { companyId: args.companyId, membershipId: membership._id, createdAt: Date.now() });
    return { url: await ctx.storage.generateUploadUrl(), claimId };
  },
});

export const addAttachment = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number(), claimId: v.optional(v.id("taskUploadClaims")) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities));
    const existing = await ctx.db
      .query("taskAttachments")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing) throw new ConvexError("This file is already attached.");
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("Uploaded file not found.");
    const attachmentId = await ctx.db.insert("taskAttachments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, storageId: args.storageId, fileName: nonEmpty(args.fileName, "File name"), contentType: metadata.contentType ?? args.contentType, size: metadata.size ?? args.size, createdByMembershipId: membership._id, createdAt: Date.now() });
    // Consume the upload claim so it cannot later "clean up" this blob. A
    // claim bound to a different blob stays for the sweep to reclaim it.
    if (args.claimId) {
      const claim = await ctx.db.get(args.claimId);
      if (claim && claim.companyId === args.companyId && claim.membershipId === membership._id && claim.storageId === args.storageId) await ctx.db.delete(args.claimId);
    }
    return attachmentId;
  },
});

// Binds the blob produced by an upload POST to the claim issued with its URL.
// Binding is what makes the claim a single-use cleanup token: orphan cleanup
// can only ever delete this exact blob.
async function bindClaimToStorage(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membershipId: Id<"companyMemberships">,
  claimId: Id<"taskUploadClaims">,
  storageId: Id<"_storage">,
) {
  const claim = await ctx.db.get(claimId);
  if (!claim || claim.companyId !== companyId || claim.membershipId !== membershipId) throw new ConvexError("Upload claim not found.");
  if (claim.storageId) {
    if (claim.storageId !== storageId) throw new ConvexError("Upload claim is already bound.");
    return;
  }
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) throw new ConvexError("Uploaded file not found.");
  // A claim cannot adopt a blob that task data already owns, so binding can
  // never turn another row's file into this upload's cleanup target.
  if (await isBlobReferenced(ctx, storageId)) throw new ConvexError("This file is already attached.");
  await ctx.db.patch(claimId, { storageId });
}

export const bindUploadClaim = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("taskUploadClaims"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    await bindClaimToStorage(ctx, args.companyId, membership._id, args.claimId, args.storageId);
    return null;
  },
});

export const listAttachments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, auth);
    const page = await ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").paginate(args.paginationOpts);
    return { ...page, page: await Promise.all(page.page.map(async (row) => ({ ...row, url: await ctx.storage.getUrl(row.storageId) }))) };
  },
});

export const deleteAttachment = mutation({
  args: { companyId: v.id("companies"), attachmentId: v.id("taskAttachments") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment || attachment.companyId !== args.companyId) throw new ConvexError("Attachment not found.");
    const { task } = await getVisibleTask(ctx, args.companyId, membership, attachment.taskType, attachment.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities));
    const isOwner = attachment.createdByMembershipId === membership._id;
    if (isOwner) {
      if (!capabilities.has("tasks:attachment:delete:own")) throw new ConvexError("You do not have access to delete this attachment.");
    } else {
      if (!capabilities.has("tasks:attachment:delete:any")) throw new ConvexError("You do not have access to moderate attachments.");
      await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), attachment.taskType, capabilities);
    }
    await ctx.storage.delete(attachment.storageId);
    await ctx.db.delete(args.attachmentId);
    return null;
  },
});

// Reclaims the blob when recording an upload as an attachment or evidence
// failed (e.g. the task was deleted mid-upload, the dialog closed, or the
// completion was rejected). Only the blob already bound to the claim is
// eligible: a caller-supplied storageId is never trusted, so one member can
// never name another member's or tenant's blob for deletion.
async function discardUploadClaim(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membershipId: Id<"companyMemberships">,
  claimId: Id<"taskUploadClaims">,
) {
  const claim = await ctx.db.get(claimId);
  if (!claim || claim.companyId !== companyId || claim.membershipId !== membershipId) throw new ConvexError("Upload claim not found.");
  const blobId = claim.storageId;
  await ctx.db.delete(claimId);
  if (!blobId) return;
  const [referenced, metadata] = await Promise.all([
    isBlobReferenced(ctx, blobId),
    ctx.db.system.get("_storage", blobId),
  ]);
  if (!referenced && metadata) await ctx.storage.delete(blobId);
}

export const deleteOrphanedUpload = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("taskUploadClaims") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    await discardUploadClaim(ctx, args.companyId, membership._id, args.claimId);
    return null;
  },
});

// Evidence follows the same rule as completion: assignees always qualify;
// everyone else needs normal task update access. Both issuing and binding an
// evidence upload claim run through this check.
async function requireEvidenceSubmission(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  taskType: TaskKind,
  taskId: string,
) {
  const { membership, capabilities } = await requireMembership(ctx, companyId);
  const normalized = taskType === "jd" ? ctx.db.normalizeId("jdTasks", taskId) : ctx.db.normalizeId("oneTimeTasks", taskId);
  if (!normalized) throw new ConvexError("Task not found.");
  const task = await ctx.db.get(normalized);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanUpdateTaskStatus(ctx, companyId, membership, task, taskType, capabilities);
  return membership;
}

export const generateEvidenceUploadUrl = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const membership = await requireEvidenceSubmission(ctx, args.companyId, args.taskType, args.taskId);
    const claimId = await ctx.db.insert("taskUploadClaims", { companyId: args.companyId, membershipId: membership._id, createdAt: Date.now() });
    return { url: await ctx.storage.generateUploadUrl(), claimId };
  },
});

// Binds an evidence upload to its claim with evidence-completion rights (the
// attachment capability is irrelevant here). Without the binding, submission
// would accept any storageId the caller happened to know.
export const bindEvidenceUploadClaim = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), claimId: v.id("taskUploadClaims"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const membership = await requireEvidenceSubmission(ctx, args.companyId, args.taskType, args.taskId);
    await bindClaimToStorage(ctx, args.companyId, membership._id, args.claimId, args.storageId);
    return null;
  },
});

export const discardEvidenceUpload = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("taskUploadClaims") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    await discardUploadClaim(ctx, args.companyId, membership._id, args.claimId);
    return null;
  },
});

export const getTaskEvidence = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const { task, normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId, auth);
    // Full history, newest first. Storage IDs never leave the server; clients
    // receive short-lived signed URLs instead.
    const page = await ctx.db.query("taskEvidence").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").paginate(args.paginationOpts);
    const authors = await enrich(ctx, page.page.map((row) => row.createdByMembershipId));
    const authorById = new Map(authors.map((author) => [author.membership._id, author]));
    return {
      ...page,
      evidenceRequired: task.evidenceRequired === true,
      page: await Promise.all(page.page.map(async (row) => ({
        _id: row._id,
        text: row.text ?? null,
        files: await Promise.all(row.files.map(async (file) => ({
          fileName: file.fileName,
          contentType: file.contentType,
          size: file.size,
          url: await ctx.storage.getUrl(file.storageId),
        }))),
        cycleStart: row.cycleStart ?? null,
        createdAt: row.createdAt,
        createdBy: authorById.get(row.createdByMembershipId) ?? null,
        retiredAt: row.retiredAt ?? null,
      }))),
    };
  },
});

// Abandoned claims (failed uploads, closed tabs) are reclaimed once the URL
// they guard could no longer have completed an upload anyway — including the
// bound blob when it was never attached.
export const sweepExpiredTaskUploadClaims = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - TASK_UPLOAD_CLAIM_TTL_MS;
    const page = await ctx.db.query("taskUploadClaims").order("asc").paginate({ numItems: 200, cursor: args.cursor ?? null });
    for (const claim of page.page) {
      // Rows scan in creation order — a fresh claim means the rest are fresh.
      if (claim.createdAt >= cutoff) return null;
      if (claim.storageId) {
        if (!(await isBlobReferenced(ctx, claim.storageId))) await ctx.storage.delete(claim.storageId);
      }
      await ctx.db.delete(claim._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.sweepExpiredTaskUploadClaims, { cursor: page.continueCursor });
    return null;
  },
});

export const assignableUsers = query({
  args: {
    companyId: v.id("companies"),
    kind: v.union(v.literal("jd"), v.literal("one_time")),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const prefix = args.kind === "jd" ? "tasks:jd" : "tasks:one_time";
    const canCreateOrUpdate = caps.has(`${prefix}:create` as any) || caps.has(`${prefix}:update:any` as any) || caps.has(`${prefix}:update:managed` as any) || caps.has(`${prefix}:update:self` as any);
    if (!canCreateOrUpdate) return { users: [], isTruncated: false };

    const search = args.search?.trim();
    if (search && search.length < ASSIGNABLE_USER_SEARCH_MIN_LENGTH) {
      throw new ConvexError(`Enter at least ${ASSIGNABLE_USER_SEARCH_MIN_LENGTH} characters to search assignees.`);
    }
    if (search && search.length > ASSIGNEE_SEARCH_MAX_LENGTH) throw new ConvexError("Assignee search is too long.");

    if (caps.has(`${prefix}:assign:any` as any)) {
      if (search) {
        const candidates = await takeWithOverflow(
          (limit) => ctx.db
            .query("companyMemberships")
            .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
            .take(limit),
          ASSIGNABLE_USER_SEARCH_SCAN_LIMIT,
        );
        const matches = await filterAssignableUsersBySearch(ctx, args.companyId, candidates.rows, search);
        return await assignableUsersResult(ctx, matches.ids, candidates.isTruncated || matches.isTruncated);
      }

      const initial = await takeWithOverflow(
        (limit) => ctx.db
          .query("companyMemberships")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
          .take(limit),
        ASSIGNABLE_USER_INITIAL_LIMIT,
      );
      return await assignableUsersResult(
        ctx,
        initial.rows.filter((candidate) => candidate.active).map((candidate) => candidate._id),
        initial.isTruncated,
      );
    }

    const canAssignManaged = caps.has(`${prefix}:assign:managed` as any);
    const canAssignSelf = caps.has(`${prefix}:assign:self` as any);
    if (!search) {
      if (canAssignManaged) {
        let isTruncated = false;
        const ids = await getManagedMembershipIds(ctx, args.companyId, membership._id, () => {
          isTruncated = true;
        });
        return await assignableUsersResult(ctx, Array.from(ids), isTruncated);
      }
      if (canAssignSelf) return await assignableUsersResult(ctx, [membership._id], false);
      return { users: [], isTruncated: false };
    }

    if (canAssignManaged) {
      const managedCandidates = await scanManagedMembershipIds(
        ctx,
        args.companyId,
        membership._id,
        ASSIGNABLE_USER_SEARCH_SCAN_LIMIT,
      );
      const candidates = await loadMembershipsById(ctx, managedCandidates.ids);
      const matches = await filterAssignableUsersBySearch(ctx, args.companyId, candidates, search);
      return await assignableUsersResult(ctx, matches.ids, managedCandidates.isTruncated || matches.isTruncated);
    }
    if (canAssignSelf) {
      const matches = await filterAssignableUsersBySearch(ctx, args.companyId, [membership], search);
      return await assignableUsersResult(ctx, matches.ids, matches.isTruncated);
    }
    return { users: [], isTruncated: false };
  },
});

export const filterableAssignees = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const ids = await scopedMembershipIds(ctx, args.companyId, membership, capabilities);
    return await enrich(ctx, Array.from(ids));
  },
});

export const eligibleConfirmers = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { capabilities } = await requireMembership(ctx, args.companyId);
    const canConfigureTask = ["tasks:jd:create", "tasks:one_time:create", "tasks:jd:update:any", "tasks:jd:update:managed", "tasks:jd:update:self", "tasks:one_time:update:any", "tasks:one_time:update:managed", "tasks:one_time:update:self"].some((capability) => capabilities.has(capability as Capability));
    if (!canConfigureTask) throw new ConvexError("You do not have access to do that.");
    const result = await takeWithOverflow(
      (limit) => ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
    );
    const roleCache = new Map<string, Promise<Set<Capability>>>();
    const ids: Id<"companyMemberships">[] = [];
    for (const candidate of result.rows) {
      if (candidate.active && (await roleNameCapabilities(ctx, args.companyId, candidate.role, roleCache)).has("tasks:confirm")) ids.push(candidate._id);
    }
    return { users: await enrich(ctx, ids), isTruncated: result.isTruncated };
  },
});

export const listAwaitingConfirmation = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:confirm");
    const result = await takeWithOverflow(
      (limit) => ctx.db
        .query("taskConfirmationRequests")
        .withIndex("by_confirmerMembershipId_and_taskType_and_submittedAt", (q) => q.eq("confirmerMembershipId", membership._id).eq("taskType", args.taskType))
        .order("desc")
        .take(limit),
      CONFIRMATION_REQUEST_LIMIT,
    );
    const joined: { request: Doc<"taskConfirmationRequests">; task: Doc<"jdTasks"> | Doc<"oneTimeTasks"> }[] = [];
    for (const request of result.rows) {
      const taskId = request.taskType === "jd" ? ctx.db.normalizeId("jdTasks", request.taskId) : ctx.db.normalizeId("oneTimeTasks", request.taskId);
      const task = taskId ? await ctx.db.get(taskId) : null;
      if (task && task.companyId === args.companyId) joined.push({ request, task });
    }
    const assignees = await enrich(ctx, joined.flatMap(({ task }) => task.assigneeMembershipIds));
    const assigneeById = new Map(assignees.map((row) => [row.membership._id, row]));
    const submitters = await enrich(ctx, joined.map(({ request }) => request.submittedByMembershipId));
    const submitterById = new Map(submitters.map((row) => [row.membership._id, row]));
    return {
      isTruncated: result.isTruncated,
      rows: joined.map(({ request, task }) => ({
        _id: request._id,
        taskId: request.taskId,
        taskType: request.taskType,
        reference: task.reference,
        title: task.title,
        assignees: task.assigneeMembershipIds.flatMap((id) => assigneeById.get(id) ?? []),
        submittedBy: submitterById.get(request.submittedByMembershipId) ?? null,
        submittedAt: request.submittedAt,
        cycleStart: request.cycleStart ?? null,
        cycleEnd: request.cycleEnd ?? null,
      })),
    };
  },
});


type AiAssignee = { name: string; role: string };

function visibleAssigneeIds(task: Doc<"jdTasks"> | Doc<"oneTimeTasks">, scopedMembershipIds?: Set<Id<"companyMemberships">>) {
  return scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
}

function aiJdRow(task: Doc<"jdTasks">, state: { status: string; dueAt: number | null }, scopedMembershipIds: Set<Id<"companyMemberships">> | undefined, assignees: Map<Id<"companyMemberships">, AiAssignee>) {
  return { kind: "jd" as const, id: task._id, reference: task.reference, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: state.dueAt, recurrence: task.recurrence, quantity: task.quantity, time: task.time, evidenceRequired: task.evidenceRequired === true, confirmationRequired: task.confirmerMembershipId !== undefined, assignees: visibleAssigneeIds(task, scopedMembershipIds).map((id) => assignees.get(id)).filter(Boolean) };
}

function aiOneTimeRow(task: Doc<"oneTimeTasks">, state: { status: string; dueAt: number | null }, scopedMembershipIds: Set<Id<"companyMemberships">> | undefined, assignees: Map<Id<"companyMemberships">, AiAssignee>) {
  return { kind: "one_time" as const, id: task._id, reference: task.reference, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: task.dueDate, priority: task.priority, quantity: task.quantity, time: task.time, evidenceRequired: task.evidenceRequired === true, confirmationRequired: task.confirmerMembershipId !== undefined, assignees: visibleAssigneeIds(task, scopedMembershipIds).map((id) => assignees.get(id)).filter(Boolean) };
}

// Single-task wrapper for the mutation/detail paths — the list path batches
// assignee reads itself, so this only enriches the one task's assignees.
async function aiTaskRow(ctx: Ctx, kind: TaskKind, task: Doc<"jdTasks"> | Doc<"oneTimeTasks">, scopedMembershipIds?: Set<Id<"companyMemberships">>) {
  const assigneeRows = await enrich(ctx, visibleAssigneeIds(task, scopedMembershipIds));
  const assignees = new Map<Id<"companyMemberships">, AiAssignee>(assigneeRows.map((row) => [row.membership._id, { name: row.user.fullName ?? row.user.email, role: row.membership.role }]));
  if (kind === "jd") {
    const jdTask = task as Doc<"jdTasks">;
    return aiJdRow(jdTask, await jdState(ctx, jdTask), scopedMembershipIds, assignees);
  }
  return aiOneTimeRow(task as Doc<"oneTimeTasks">, oneState(task as Doc<"oneTimeTasks">), scopedMembershipIds, assignees);
}

// Source rows scanned per kind before giving up; enough that a sparse status
// or scoped-viewer match usually surfaces instead of silently coming back empty.
const AI_LIST_TASK_SCAN_LIMIT = 400;
const AI_LIST_TASK_EVAL_CHUNK = 32;

export const aiListVisible = query({
  args: { companyId: v.id("companies"), status: v.union(v.literal("all"), v.literal("due"), v.literal("overdue"), v.literal("done")), limit: v.number(), search: v.optional(v.string()), kind: v.optional(v.union(v.literal("jd"), v.literal("one_time"))) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const [scopedJd, scopedOneTime] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
    ]);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 30);
    const needle = args.search?.trim();
    const matches = (status: string) => args.status === "all" || (args.status === "overdue" ? status === "Overdue" : args.status === "done" ? status === "Completed" : status !== "Completed" && status !== "Overdue");
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    // Convex allows only one .paginate() call per function and this handler
    // scans two tables, so each scan is a single bounded take() of the newest
    // rows; `exhausted` reports whether matching rows may remain. Rows are
    // evaluated newest-first in small batches and the scan stops as soon as
    // the requested count fills. Enrichment is deferred: candidates are only
    // visibility- and state-checked here, and assignees load in one batch
    // across all matches so the scan budget also bounds total reads below
    // transaction limits.
    const collect = async (kind: TaskKind, table: "jdTasks" | "oneTimeTasks") => {
      const page = table === "jdTasks"
        ? await ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).order("desc").take(AI_LIST_TASK_SCAN_LIMIT)
        : await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(AI_LIST_TASK_SCAN_LIMIT);
      const matched: { task: Doc<"jdTasks"> | Doc<"oneTimeTasks">; state: { status: string; dueAt: number | null } }[] = [];
      let offset = 0;
      while (offset < page.length && matched.length < limit) {
        const batch = page.slice(offset, offset + AI_LIST_TASK_EVAL_CHUNK);
        const evaluated = await Promise.all(batch.map(async (task) => {
          if ("pausedAt" in task && task.pausedAt !== undefined) return null;
          if (!(await visible(ctx, args.companyId, membership, task, kind, auth))) return null;
          if (!matchesSearch(task, needle)) return null;
          const state = kind === "jd" ? await jdState(ctx, task as Doc<"jdTasks">, now, timeZone, calendar) : oneState(task as Doc<"oneTimeTasks">);
          return matches(state.status) ? { task, state } : null;
        }));
        for (const item of evaluated) if (item && matched.length < limit) matched.push(item);
        offset += batch.length;
      }
      const exhausted = offset >= page.length && page.length < AI_LIST_TASK_SCAN_LIMIT;
      return { matched, exhausted };
    };
    const [jdScan, oneScan] = await Promise.all([
      args.kind !== "one_time" ? collect("jd", "jdTasks") : Promise.resolve({ matched: [], exhausted: true }),
      args.kind !== "jd" ? collect("one_time", "oneTimeTasks") : Promise.resolve({ matched: [], exhausted: true }),
    ]);
    const merged: { kind: TaskKind; task: Doc<"jdTasks"> | Doc<"oneTimeTasks">; state: { status: string; dueAt: number | null } }[] = [];
    for (let i = 0; i < Math.max(jdScan.matched.length, oneScan.matched.length) && merged.length < limit; i += 1) {
      if (jdScan.matched[i]) merged.push({ kind: "jd", ...jdScan.matched[i] });
      if (oneScan.matched[i] && merged.length < limit) merged.push({ kind: "one_time", ...oneScan.matched[i] });
    }
    const assigneeRows = await enrich(ctx, merged.flatMap((item) => visibleAssigneeIds(item.task, item.kind === "jd" ? scopedJd : scopedOneTime)));
    const assignees = new Map<Id<"companyMemberships">, AiAssignee>(assigneeRows.map((row: any) => [row.membership._id, { name: row.user.fullName ?? row.user.email, role: row.membership.role }]));
    const rows = merged.map((item) =>
      item.kind === "jd"
        ? aiJdRow(item.task as Doc<"jdTasks">, item.state, scopedJd, assignees)
        : aiOneTimeRow(item.task as Doc<"oneTimeTasks">, item.state, scopedOneTime, assignees),
    );
    return { rows, truncated: !jdScan.exhausted || !oneScan.exhausted || jdScan.matched.length + oneScan.matched.length > rows.length };
  },
});

export const aiGetDetail = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership, capabilities);
    const { task } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId, auth);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.kind).eq("taskId", task._id)).order("desc").take(5);
    const scoped = await scopedMembershipIds(ctx, args.companyId, membership, capabilities, args.kind === "jd" ? "tasks:jd:view:any" : "tasks:one_time:view:any");
    const row = args.kind === "jd" ? await aiTaskRow(ctx, "jd", task as Doc<"jdTasks">, scoped) : await aiTaskRow(ctx, "one_time", task as Doc<"oneTimeTasks">, scoped);
    return { ...row, comments: comments.map((comment) => ({ body: comment.body, createdAt: comment.createdAt })) };
  },
});

export const aiSetStatus = mutation({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), status: statusValidator, note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const { normalized, task } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities));
    // Evidence is captured through the task's completion dialog, so the agent
    // must not complete these tasks on the user's behalf.
    if (args.status === "completed" && task.evidenceRequired === true) {
      throw new ConvexError("This task requires evidence to complete. Complete it from the task's completion dialog.");
    }
    if (args.kind === "jd") {
      if (args.note !== undefined && args.status !== "completed") throw new ConvexError("Status notes are only saved when completing a task.");
      await setJdStatus(ctx, args.companyId, normalized as Id<"jdTasks">, args.status, args.note);
      const updated = await ctx.db.get(normalized as Id<"jdTasks">);
      if (!updated) throw new ConvexError("Task not found.");
      return await aiTaskRow(ctx, "jd", updated);
    }
    if (args.note !== undefined) throw new ConvexError("Status notes are only supported on recurring tasks.");
    await setOneTimeStatus(ctx, args.companyId, normalized as Id<"oneTimeTasks">, args.status);
    const updated = await ctx.db.get(normalized as Id<"oneTimeTasks">);
    if (!updated) throw new ConvexError("Task not found.");
    return await aiTaskRow(ctx, "one_time", updated);
  },
});

export const aiAddComment = mutation({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireCapability(ctx, args.companyId, "tasks:comment");
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId, await taskVisibilityAuth(ctx, args.companyId, membership, capabilities));
    return await ctx.db.insert("taskComments", { companyId: args.companyId, taskType: args.kind, taskId: normalized, authorMembershipId: membership._id, body: nonEmpty(args.body, "Comment"), createdAt: Date.now() });
  },
});

/**
 * Migrates a single batch of tasks for a given table (jdTasks or oneTimeTasks)
 * using cursor-based pagination to ensure transactions stay bounded.
 */
export const migrateTaskBatch = internalMutation({
  args: {
    table: v.union(v.literal("jdTasks"), v.literal("oneTimeTasks")),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
    dryRun: v.boolean(),
    companyId: v.optional(v.id("companies")),
  },
  handler: async (ctx, args) => {
    const baseQuery = args.companyId
      ? ctx.db.query(args.table).withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
      : ctx.db.query(args.table);

    const page = await baseQuery.paginate({ numItems: args.batchSize, cursor: args.cursor });
    let migrated = 0;
    const batchTargets = new Set<string>();
    const targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }> = [];

    for (const task of page.page) {
      if (args.table === "jdTasks") {
        const match = /^JD-(\d+)$/i.exec(task.reference);
        if (match) {
          const num = parseInt(match[1], 10);
          const newRef = `JD-${String(num).padStart(3, "0")}`;
          if (task.reference !== newRef) {
            const key = `${task.companyId}:${newRef}`;
            if (batchTargets.has(key)) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            const existing = await ctx.db
              .query("jdTasks")
              .withIndex("by_companyId_and_reference", (q) =>
                q.eq("companyId", task.companyId).eq("reference", newRef)
              )
              .first();
            if (existing && existing._id !== task._id) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            batchTargets.add(key);
            targets.push({ id: task._id, reference: task.reference, targetRef: newRef, companyId: task.companyId });
            if (!args.dryRun) {
              await ctx.db.patch(task._id, { reference: newRef });
            }
            migrated += 1;
          }
        }
      } else {
        const match = /^(?:OT|TSK)-(\d+)$/i.exec(task.reference);
        if (match) {
          const num = parseInt(match[1], 10);
          const newRef = `TSK-${String(num).padStart(3, "0")}`;
          if (task.reference !== newRef) {
            const key = `${task.companyId}:${newRef}`;
            if (batchTargets.has(key)) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            const existing = await ctx.db
              .query("oneTimeTasks")
              .withIndex("by_companyId_and_reference", (q) =>
                q.eq("companyId", task.companyId).eq("reference", newRef)
              )
              .first();
            if (existing && existing._id !== task._id) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            batchTargets.add(key);
            targets.push({ id: task._id, reference: task.reference, targetRef: newRef, companyId: task.companyId });
            if (!args.dryRun) {
              await ctx.db.patch(task._id, { reference: newRef });
            }
            migrated += 1;
          }
        }
      }
    }

    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      migrated,
      scanned: page.page.length,
      targets,
    };
  },
});

/**
 * Migrates existing task codes to the 3-digit format across all batches:
 * - JD tasks: "JD-0001" -> "JD-001"
 * - One-time tasks: "OT-0001" -> "TSK-001" (and normalizes 4-digit "TSK-0001" -> "TSK-001")
 *
 * Designed to handle any number of tasks on prod by running bounded batches.
 * Can be run via the Convex CLI:
 *   npx convex run tasks:migrateTaskCodes '{"dryRun": true}'   # preview changes
 *   npx convex run tasks:migrateTaskCodes '{"dryRun": false}'  # apply changes
 */
export const migrateTaskCodes = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    companyId: v.optional(v.id("companies")),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const batchSize = Math.min(Math.max(args.batchSize ?? 250, 1), 1000);

    // Collision preflight across the whole run (dry-run pass that reserves computed targets)
    const reservedTargets = new Set<string>();
    let preflightJdMigrated = 0;
    let preflightOneTimeMigrated = 0;

    let jdCursor: string | null = null;
    let jdDone = false;
    while (!jdDone) {
      const batchResult: {
        continueCursor: string;
        isDone: boolean;
        migrated: number;
        targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }>;
      } = await ctx.runMutation(internal.tasks.migrateTaskBatch, {
        table: "jdTasks",
        cursor: jdCursor,
        batchSize,
        dryRun: true,
        companyId: args.companyId,
      });
      for (const target of batchResult.targets) {
        const key = `${target.companyId}:${target.targetRef}`;
        if (reservedTargets.has(key)) {
          throw new ConvexError(
            `Cannot migrate task ${target.id} (${target.reference}) to ${target.targetRef}: target reference already exists in company ${target.companyId}.`
          );
        }
        reservedTargets.add(key);
      }
      preflightJdMigrated += batchResult.migrated;
      jdCursor = batchResult.continueCursor;
      jdDone = batchResult.isDone;
    }

    let oneTimeCursor: string | null = null;
    let oneTimeDone = false;
    while (!oneTimeDone) {
      const batchResult: {
        continueCursor: string;
        isDone: boolean;
        migrated: number;
        targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }>;
      } = await ctx.runMutation(internal.tasks.migrateTaskBatch, {
        table: "oneTimeTasks",
        cursor: oneTimeCursor,
        batchSize,
        dryRun: true,
        companyId: args.companyId,
      });
      for (const target of batchResult.targets) {
        const key = `${target.companyId}:${target.targetRef}`;
        if (reservedTargets.has(key)) {
          throw new ConvexError(
            `Cannot migrate task ${target.id} (${target.reference}) to ${target.targetRef}: target reference already exists in company ${target.companyId}.`
          );
        }
        reservedTargets.add(key);
      }
      preflightOneTimeMigrated += batchResult.migrated;
      oneTimeCursor = batchResult.continueCursor;
      oneTimeDone = batchResult.isDone;
    }

    const totalMigratable = preflightJdMigrated + preflightOneTimeMigrated;
    if (dryRun) {
      return {
        dryRun: true,
        jdMigrated: preflightJdMigrated,
        oneTimeMigrated: preflightOneTimeMigrated,
        totalMigrated: totalMigratable,
      };
    }

    if (totalMigratable === 0) {
      return {
        dryRun: false,
        jdMigrated: 0,
        oneTimeMigrated: 0,
        totalMigrated: 0,
      };
    }

    // Real run: preflight passed with no collisions, safe to write
    let jdMigrated = 0;
    let oneTimeMigrated = 0;

    jdCursor = null;
    jdDone = false;
    while (!jdDone) {
      const batchResult: { continueCursor: string; isDone: boolean; migrated: number } =
        await ctx.runMutation(internal.tasks.migrateTaskBatch, {
          table: "jdTasks",
          cursor: jdCursor,
          batchSize,
          dryRun: false,
          companyId: args.companyId,
        });
      jdMigrated += batchResult.migrated;
      jdCursor = batchResult.continueCursor;
      jdDone = batchResult.isDone;
    }

    oneTimeCursor = null;
    oneTimeDone = false;
    while (!oneTimeDone) {
      const batchResult: { continueCursor: string; isDone: boolean; migrated: number } =
        await ctx.runMutation(internal.tasks.migrateTaskBatch, {
          table: "oneTimeTasks",
          cursor: oneTimeCursor,
          batchSize,
          dryRun: false,
          companyId: args.companyId,
        });
      oneTimeMigrated += batchResult.migrated;
      oneTimeCursor = batchResult.continueCursor;
      oneTimeDone = batchResult.isDone;
    }

    return {
      dryRun: false,
      jdMigrated,
      oneTimeMigrated,
      totalMigrated: jdMigrated + oneTimeMigrated,
    };
  },
});

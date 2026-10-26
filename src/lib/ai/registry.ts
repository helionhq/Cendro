import { tool } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Capability } from "@/lib/permissions";
import { cendroAiActivityLabels, type CendroAiToolName } from "./activity";
import { firecrawlFetch, firecrawlSearch } from "./web";

export type CendroAiPermissionRequirement = "member" | Capability | Capability[];
export type CendroAiRiskLevel = "read" | "write" | "external";
export type CendroAiActivity = { toolName: CendroAiToolName; label: string };
export type CendroAiToolResult = { ok: true; [key: string]: unknown } | { ok: false; message: string };

type RefKind = "task" | "sop" | "member" | "branch" | "department";
type RefValue = { kind: RefKind; id: string };

export type CendroAiToolContext = {
  client: ConvexHttpClient;
  companyId: Id<"companies">;
  sessionId: Id<"aiChatSessions">;
  membershipId: Id<"companyMemberships">;
  role: string;
  timeZone: string | null;
  capabilities: Set<Capability>;
  refs: Map<string, RefValue>;
  counters: Record<RefKind, number>;
};

export type CendroAiToolDefinition<Input extends z.ZodType = z.ZodType> = {
  name: CendroAiToolName;
  description: string;
  inputSchema: Input;
  activityLabel: string;
  permission: CendroAiPermissionRequirement;
  risk: CendroAiRiskLevel;
  execute: (input: any, ctx: CendroAiToolContext) => Promise<CendroAiToolResult>;
};

class AiToolDenied extends Error {}
class AiToolNotFound extends Error {}
class AiToolInputError extends Error {}

const priority = z.enum(["low", "medium", "high", "critical"]);
const recurrence = z.enum(["daily", "every_other_day", "weekly", "semimonthly", "monthly", "quarterly", "semiannually", "annually"]);
const taskKind = z.enum(["jd", "one_time"]);
const taskStatus = z.enum(["due", "in_progress", "completed"]);
const sopScopeType = z.enum(["company", "branch", "department", "user"]);
const taskRef = z.string().regex(/^task_\d+$/);
const memberRef = z.string().regex(/^member_\d+$/);
const sopRef = z.string().regex(/^sop_\d+$/);
const scopeTargetRef = z.string().regex(/^(branch|department|member)_\d+$/);

function hasPermission(ctx: CendroAiToolContext, requirement: CendroAiPermissionRequirement) {
  if (requirement === "member") return true;
  if (Array.isArray(requirement)) return requirement.some((capability) => ctx.capabilities.has(capability));
  return ctx.capabilities.has(requirement);
}

function ensurePermission(ctx: CendroAiToolContext, requirement: CendroAiPermissionRequirement) {
  if (!hasPermission(ctx, requirement)) throw new AiToolDenied("This action is not available with your current permissions.");
}

function refFor(ctx: CendroAiToolContext, kind: RefKind, id: string) {
  for (const [ref, value] of ctx.refs) if (value.kind === kind && value.id === id) return ref;
  ctx.counters[kind] += 1;
  const ref = `${kind}_${ctx.counters[kind]}`;
  ctx.refs.set(ref, { kind, id });
  return ref;
}

function resolveRef(ctx: CendroAiToolContext, ref: string, kind: RefKind) {
  const value = ctx.refs.get(ref);
  if (!value || value.kind !== kind) throw new AiToolNotFound("I can't find that referenced item in this chat. Ask me to list or search for it first.");
  return value;
}

function taskRefParts(ctx: CendroAiToolContext, ref: string) {
  const [kind, id] = resolveRef(ctx, ref, "task").id.split(":") as ["jd" | "one_time", string];
  return { kind, id };
}

function sopScopeTargets(ctx: CendroAiToolContext, scopeType: z.infer<typeof sopScopeType>, targetRef?: string) {
  if (scopeType === "company") return { branchIds: [], departmentIds: [], userMembershipIds: [] };
  if (!targetRef) throw new AiToolInputError(`A ${scopeType}-scoped SOP needs a targetRef from list_sop_scope_targets.`);
  const prefix = scopeType === "user" ? "member" : scopeType;
  if (!targetRef.startsWith(`${prefix}_`)) throw new AiToolInputError(`A ${scopeType}-scoped SOP needs a ${prefix}_ ref from list_sop_scope_targets.`);
  const resolved = resolveRef(ctx, targetRef, prefix);
  return {
    branchIds: scopeType === "branch" ? [resolved.id as Id<"branches">] : [],
    departmentIds: scopeType === "department" ? [resolved.id as Id<"departments">] : [],
    userMembershipIds: scopeType === "user" ? [resolved.id as Id<"companyMemberships">] : [],
  };
}

function compactText(value?: string | null, max = 700) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeError(error: unknown) {
  if (error instanceof AiToolDenied || error instanceof AiToolNotFound || error instanceof AiToolInputError) return error.message;
  // Convex functions report user-facing failures as ConvexError, whose .data is
  // the thrown message. Pass those through so the agent can explain the
  // specific denial or validation failure instead of a generic error.
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data.trim()) return data;
  return "The requested action could not be completed.";
}

// A committed write can land outside the actor's own visibility (an SOP scoped
// to someone else, a task assigned away): the follow-up read failing must not
// read as a failed write, or a retry would create duplicates.
async function readBack<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

function taskOut(ctx: CendroAiToolContext, row: any) {
  const kind = row.kind === "jd" ? "jd" : "one_time";
  return {
    ref: refFor(ctx, "task", `${kind}:${row.id}`),
    kind,
    reference: row.reference ?? null,
    title: row.title,
    notes: row.notes ? compactText(row.notes, 1500) : null,
    status: row.status,
    dueAt: row.dueAt ?? null,
    priority: row.priority ?? null,
    evidenceRequired: row.evidenceRequired === true,
    confirmationRequired: row.confirmationRequired === true,
    assignees: (row.assignees ?? []).map((assignee: any) => ({ name: assignee.name, role: assignee.role })),
  };
}

function memberOut(ctx: CendroAiToolContext, row: any) {
  return { ref: refFor(ctx, "member", row.membership._id), name: row.user.fullName ?? row.user.name ?? row.user.email, email: row.user.email, role: row.membership.role };
}

function sopOut(ctx: CendroAiToolContext, row: any, includeContent = false) {
  return {
    ref: refFor(ctx, "sop", row.id),
    reference: row.reference ?? null,
    title: row.title,
    scopeType: row.scopeType,
    scopeTargetName: row.scopeTargetName ?? null,
    canUpdate: row.canUpdate ?? null,
    canDelete: row.canDelete ?? null,
    excerpt: compactText(row.excerpt ?? row.content, 600),
    ...(includeContent ? { content: compactText(row.content, 5000) } : {}),
  };
}

export async function createCendroAiContext(input: { client: ConvexHttpClient; companyId: Id<"companies">; sessionId: Id<"aiChatSessions"> }): Promise<CendroAiToolContext> {
  const authz = await input.client.query(api.aiChat.authorizeSessionForAgent, { companyId: input.companyId, sessionId: input.sessionId });
  return {
    client: input.client,
    companyId: input.companyId,
    sessionId: input.sessionId,
    membershipId: authz.membershipId,
    role: authz.role,
    timeZone: authz.timeZone ?? null,
    capabilities: new Set(authz.capabilities as Capability[]),
    refs: new Map(),
    counters: { task: 0, sop: 0, member: 0, branch: 0, department: 0 },
  };
}

export const cendroAiToolDefinitions: CendroAiToolDefinition[] = [
  {
    name: "get_workspace_context",
    description: "Get the current user's role, capabilities, workspace name, and scope summary. Use before answering questions about permissions or what the user can do.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_workspace_context,
    permission: "member",
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, context: await ctx.client.query(api.aiWorkspace.context, { companyId: ctx.companyId }) }),
  },
  {
    name: "list_tasks",
    description: "List or search tasks visible to the current user. Filter by status, kind, or a title/reference query. Returns task refs used by the other task tools.",
    inputSchema: z.object({ status: z.enum(["all", "due", "overdue", "done"]).default("all"), kind: taskKind.optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).default(12) }),
    activityLabel: cendroAiActivityLabels.list_tasks,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const { rows, truncated } = await ctx.client.query(api.tasks.aiListVisible, { companyId: ctx.companyId, status: input.status, kind: input.kind, search: input.query, limit: input.limit });
      return { ok: true, tasks: rows.map((row: any) => taskOut(ctx, row)), truncated };
    },
  },
  {
    name: "get_task",
    description: "Read full details for a task: description, notes, assignees, and recent comments. Requires a task ref from list_tasks.",
    inputSchema: z.object({ taskRef }),
    activityLabel: cendroAiActivityLabels.get_task,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const { kind, id } = taskRefParts(ctx, input.taskRef);
      const row = await ctx.client.query(api.tasks.aiGetDetail, { companyId: ctx.companyId, kind, taskId: id });
      return { ok: true, task: { ...taskOut(ctx, row), description: compactText(row.description, 1500), notes: row.notes ? compactText(row.notes, 1500) : null, comments: row.comments } };
    },
  },
  {
    name: "list_people",
    description: "List workspace members visible to the current user. Use to answer questions about people or to find member refs for task assignment.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.list_people,
    permission: "member",
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, people: (await ctx.client.query(api.tasks.filterableAssignees, { companyId: ctx.companyId })).map((row: any) => memberOut(ctx, row)) }),
  },
  {
    name: "list_assignable_users",
    description: "List people the current user may assign tasks of the given kind to, honoring their assign permission. Use before creating a task when assignees are unclear. Returns member refs.",
    inputSchema: z.object({ kind: taskKind, search: z.string().max(100).optional() }),
    activityLabel: cendroAiActivityLabels.list_assignable_users,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const result = await ctx.client.query(api.tasks.assignableUsers, { companyId: ctx.companyId, kind: input.kind, search: input.search });
      return { ok: true, people: result.users.map((row: any) => memberOut(ctx, row)), isTruncated: result.isTruncated };
    },
  },
  {
    name: "create_task",
    description: "Create a task after the user explicitly asks for one. kind jd is a recurring task and needs recurrence; kind one_time is a one-off and may take dueDateMs and priority. At least one assignee is required: resolve member refs from list_assignable_users or list_people, or ask the user who owns it. Pass confirmerRef to require confirmation before completion, using a member ref for someone whose role can confirm task completion.",
    inputSchema: z.object({ kind: taskKind, title: z.string().min(1).max(160), description: z.string().max(2000).optional(), notes: z.string().max(2000).optional(), recurrence: recurrence.optional(), dueDateMs: z.number().int().positive().optional(), time: z.string().max(20).optional(), quantity: z.number().int().positive().optional(), assigneeRefs: z.array(memberRef).min(1).max(10), priority: priority.optional(), evidenceRequired: z.boolean().optional(), confirmerRef: memberRef.optional() }),
    activityLabel: cendroAiActivityLabels.create_task,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const assigneeMembershipIds = input.assigneeRefs.map((ref: string) => resolveRef(ctx, ref, "member").id as Id<"companyMemberships">);
      const confirmerMembershipId = input.confirmerRef === undefined ? undefined : resolveRef(ctx, input.confirmerRef, "member").id as Id<"companyMemberships">;
      let taskId: string;
      if (input.kind === "jd") {
        ensurePermission(ctx, "tasks:jd:create");
        if (!input.recurrence) throw new AiToolInputError("Recurring tasks need a recurrence value.");
        if (input.dueDateMs !== undefined) throw new AiToolInputError("Recurring tasks do not take a due date; use recurrence instead.");
        taskId = await ctx.client.mutation(api.tasks.createJd, { companyId: ctx.companyId, title: input.title, description: input.description, notes: input.notes, time: input.time, quantity: input.quantity, recurrence: input.recurrence, evidenceRequired: input.evidenceRequired, confirmerMembershipId, assigneeMembershipIds });
      } else {
        ensurePermission(ctx, "tasks:one_time:create");
        if (input.recurrence !== undefined) throw new AiToolInputError("One-time tasks do not take a recurrence; use a due date instead.");
        taskId = await ctx.client.mutation(api.tasks.createOneTime, { companyId: ctx.companyId, title: input.title, description: input.description, notes: input.notes, dueDate: input.dueDateMs, time: input.time, quantity: input.quantity, assigneeMembershipIds, priority: input.priority ?? "medium", evidenceRequired: input.evidenceRequired, confirmerMembershipId });
      }
      const row = await readBack(ctx.client.query(api.tasks.aiGetDetail, { companyId: ctx.companyId, kind: input.kind, taskId }));
      if (!row) return { ok: true, taskRef: refFor(ctx, "task", `${input.kind}:${taskId}`), message: "Task saved, but it is not visible to you, so its details cannot be confirmed." };
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "update_task",
    description: "Update fields on a task: title, description, notes, assignees, schedule fields, priority (one-time only), recurrence (recurring only), and whether completion requires evidence or confirmation. Requires a task ref. Set confirmerRef to require confirmation, or clearConfirmer to remove it.",
    inputSchema: z.object({ taskRef, title: z.string().min(1).max(160).optional(), description: z.string().max(2000).optional(), notes: z.string().max(2000).optional(), dueDateMs: z.number().int().positive().optional(), clearDueDate: z.boolean().optional(), time: z.string().max(20).optional(), quantity: z.number().int().positive().optional(), clearQuantity: z.boolean().optional(), recurrence: recurrence.optional(), assigneeRefs: z.array(memberRef).max(10).optional(), priority: priority.optional(), evidenceRequired: z.boolean().optional(), confirmerRef: memberRef.optional(), clearConfirmer: z.boolean().optional() }),
    activityLabel: cendroAiActivityLabels.update_task,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const { kind, id } = taskRefParts(ctx, input.taskRef);
      const assigneeMembershipIds = input.assigneeRefs?.map((ref: string) => resolveRef(ctx, ref, "member").id as Id<"companyMemberships">);
      if (input.confirmerRef !== undefined && input.clearConfirmer) throw new AiToolInputError("Choose either confirmerRef or clearConfirmer, not both.");
      const confirmerMembershipId = input.clearConfirmer ? null : input.confirmerRef === undefined ? undefined : resolveRef(ctx, input.confirmerRef, "member").id as Id<"companyMemberships">;
      if (kind === "jd") {
        if (input.dueDateMs !== undefined || input.clearDueDate) throw new AiToolInputError("Recurring tasks do not have a due date; update recurrence instead.");
        if (input.priority !== undefined) throw new AiToolInputError("Recurring tasks do not have a priority.");
        await ctx.client.mutation(api.tasks.updateJdFields, { companyId: ctx.companyId, taskId: id as Id<"jdTasks">, title: input.title, description: input.description, notes: input.notes, time: input.time, quantity: input.clearQuantity ? null : input.quantity, recurrence: input.recurrence, evidenceRequired: input.evidenceRequired, confirmerMembershipId, assigneeMembershipIds });
      } else {
        if (input.recurrence !== undefined) throw new AiToolInputError("One-time tasks do not have a recurrence; update the due date instead.");
        await ctx.client.mutation(api.tasks.updateOneTimeFields, { companyId: ctx.companyId, taskId: id as Id<"oneTimeTasks">, title: input.title, description: input.description, notes: input.notes, dueDate: input.clearDueDate ? null : input.dueDateMs, time: input.time, quantity: input.clearQuantity ? null : input.quantity, assigneeMembershipIds, priority: input.priority, evidenceRequired: input.evidenceRequired, confirmerMembershipId });
      }
      const row = await readBack(ctx.client.query(api.tasks.aiGetDetail, { companyId: ctx.companyId, kind, taskId: id }));
      if (!row) return { ok: true, taskRef: input.taskRef, message: "Changes saved, but the task is no longer visible to you, so its details cannot be confirmed." };
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "set_task_status",
    description: "Change a task's status to due, in_progress, or completed. Requires a task ref. A note is only accepted for recurring tasks and records why work completed. Tasks that require evidence cannot be completed here; ask the user to use the task's completion dialog.",
    inputSchema: z.object({ taskRef, status: taskStatus, note: z.string().max(1000).optional() }),
    activityLabel: cendroAiActivityLabels.set_task_status,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const { kind, id } = taskRefParts(ctx, input.taskRef);
      const row = await ctx.client.mutation(api.tasks.aiSetStatus, { companyId: ctx.companyId, kind, taskId: id, status: input.status, note: input.note });
      return { ok: true, task: taskOut(ctx, row) };
    },
  },
  {
    name: "add_task_comment",
    description: "Add a comment to a task when explicitly requested. Requires a task ref.",
    inputSchema: z.object({ taskRef, body: z.string().min(1).max(2000) }),
    activityLabel: cendroAiActivityLabels.add_task_comment,
    permission: "tasks:comment",
    risk: "write",
    execute: async (input, ctx) => {
      const { kind, id } = taskRefParts(ctx, input.taskRef);
      await ctx.client.mutation(api.tasks.aiAddComment, { companyId: ctx.companyId, kind, taskId: id, body: input.body });
      return { ok: true, message: "Comment added." };
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task the user explicitly asked to remove. Requires a task ref. Deletion cannot be undone.",
    inputSchema: z.object({ taskRef }),
    activityLabel: cendroAiActivityLabels.delete_task,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const { kind, id } = taskRefParts(ctx, input.taskRef);
      if (kind === "jd") await ctx.client.mutation(api.tasks.deleteJd, { companyId: ctx.companyId, taskId: id as Id<"jdTasks"> });
      else await ctx.client.mutation(api.tasks.deleteOneTime, { companyId: ctx.companyId, taskId: id as Id<"oneTimeTasks"> });
      return { ok: true, message: "Task deleted." };
    },
  },
  {
    name: "list_sops",
    description: "List or search SOPs visible to the current user. Filter by a title, reference, or content query and optionally by scope. Returns SOP refs used by the other SOP tools.",
    inputSchema: z.object({ query: z.string().max(200).optional(), scope: z.enum(["all", "company", "branch", "department", "user"]).optional(), limit: z.number().int().min(1).max(25).default(12) }),
    activityLabel: cendroAiActivityLabels.list_sops,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => ({ ok: true, sops: (await ctx.client.query(api.sops.aiListSops, { companyId: ctx.companyId, query: input.query, scope: input.scope, limit: input.limit })).map((row: any) => sopOut(ctx, row)) }),
  },
  {
    name: "get_sop",
    description: "Read the full content of an SOP. Requires an SOP ref from list_sops.",
    inputSchema: z.object({ sopRef }),
    activityLabel: cendroAiActivityLabels.get_sop,
    permission: "member",
    risk: "read",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.sopRef, "sop");
      return { ok: true, sop: sopOut(ctx, await ctx.client.query(api.sops.aiGet, { companyId: ctx.companyId, sopId: ref.id as Id<"sops"> }), true) };
    },
  },
  {
    name: "list_sop_scope_targets",
    description: "List the branches, departments, and people the current user may scope SOPs to. Returns branch, department, and member refs used when creating or updating scoped SOPs.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.list_sop_scope_targets,
    permission: "member",
    risk: "read",
    execute: async (_input, ctx) => {
      const options = await ctx.client.query(api.sops.scopeOptions, { companyId: ctx.companyId });
      return {
        ok: true,
        branches: options.branches.map((row: any) => ({ ref: refFor(ctx, "branch", row._id), name: row.name })),
        departments: options.departments.map((row: any) => ({ ref: refFor(ctx, "department", row._id), name: row.name, branchName: row.branchName })),
        users: options.users.map((row: any) => memberOut(ctx, row)),
      };
    },
  },
  {
    name: "create_sop",
    description: "Create an SOP after the user explicitly asks. scopeType defaults to company; branch, department, and user scopes need a matching targetRef from list_sop_scope_targets.",
    inputSchema: z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(8000), scopeType: sopScopeType.default("company"), targetRef: scopeTargetRef.optional() }),
    activityLabel: cendroAiActivityLabels.create_sop,
    permission: "sops:create",
    risk: "write",
    execute: async (input, ctx) => {
      const targets = sopScopeTargets(ctx, input.scopeType, input.targetRef);
      const sopId = await ctx.client.mutation(api.sops.create, { companyId: ctx.companyId, title: input.title, content: input.content, scopeType: input.scopeType, ...targets });
      const row = await readBack(ctx.client.query(api.sops.aiGet, { companyId: ctx.companyId, sopId }));
      if (!row) return { ok: true, sopRef: refFor(ctx, "sop", sopId), message: "SOP saved, but it is not visible to you, so its details cannot be confirmed." };
      return { ok: true, sop: sopOut(ctx, row, true) };
    },
  },
  {
    name: "update_sop",
    description: "Update an SOP's title, content, or scope. Requires an SOP ref. When scopeType is set, non-company scopes need a matching targetRef from list_sop_scope_targets.",
    inputSchema: z.object({ sopRef, title: z.string().min(1).max(160).optional(), content: z.string().min(1).max(8000).optional(), scopeType: sopScopeType.optional(), targetRef: scopeTargetRef.optional() }),
    activityLabel: cendroAiActivityLabels.update_sop,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.sopRef, "sop");
      if (input.scopeType === undefined && input.targetRef !== undefined) throw new AiToolInputError("targetRef only makes sense together with scopeType.");
      await ctx.client.mutation(api.sops.update, {
        companyId: ctx.companyId,
        sopId: ref.id as Id<"sops">,
        title: input.title,
        content: input.content,
        ...(input.scopeType === undefined ? {} : { scopeType: input.scopeType, ...sopScopeTargets(ctx, input.scopeType, input.targetRef) }),
      });
      const row = await readBack(ctx.client.query(api.sops.aiGet, { companyId: ctx.companyId, sopId: ref.id as Id<"sops"> }));
      if (!row) return { ok: true, sopRef: input.sopRef, message: "Changes saved, but the SOP is no longer visible to you, so its details cannot be confirmed." };
      return { ok: true, sop: sopOut(ctx, row, true) };
    },
  },
  {
    name: "delete_sop",
    description: "Permanently delete an SOP the user explicitly asked to remove. Requires an SOP ref. Deletion cannot be undone.",
    inputSchema: z.object({ sopRef }),
    activityLabel: cendroAiActivityLabels.delete_sop,
    permission: "member",
    risk: "write",
    execute: async (input, ctx) => {
      const ref = resolveRef(ctx, input.sopRef, "sop");
      await ctx.client.mutation(api.sops.remove, { companyId: ctx.companyId, sopId: ref.id as Id<"sops"> });
      return { ok: true, message: "SOP deleted." };
    },
  },
  {
    name: "get_analytics_summary",
    description: "Get a permission-scoped analytics summary for this workspace.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_analytics_summary,
    permission: ["analytics:view:company", "analytics:view:managed_scope", "analytics:view:self"],
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, summary: await ctx.client.query(api.analytics.aiSummary, { companyId: ctx.companyId }) }),
  },
  {
    name: "get_performance_summary",
    description: "Get permission-scoped task performance summary. Company for admins, managed scope for managers, self for employees.",
    inputSchema: z.object({}),
    activityLabel: cendroAiActivityLabels.get_performance_summary,
    permission: ["analytics:view:company", "analytics:view:managed_scope", "analytics:view:self"],
    risk: "read",
    execute: async (_input, ctx) => ({ ok: true, summary: await ctx.client.query(api.aiWorkspace.performanceSummary, { companyId: ctx.companyId }) }),
  },
  {
    name: "web_search",
    description: "Search the public web for external or current facts. Never use for Cendro workspace data.",
    inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(5).default(5) }),
    activityLabel: cendroAiActivityLabels.web_search,
    permission: "member",
    risk: "external",
    execute: async (input) => firecrawlSearch(input),
  },
  {
    name: "web_fetch",
    description: "Fetch readable markdown from a public external web page. Never fetch private, internal, or Cendro app URLs.",
    inputSchema: z.object({ url: z.string().url().max(1000) }),
    activityLabel: cendroAiActivityLabels.web_fetch,
    permission: "member",
    risk: "external",
    execute: async (input) => firecrawlFetch(input),
  },
];

export function buildCendroAiTools(ctx: CendroAiToolContext) {
  return Object.fromEntries(cendroAiToolDefinitions.map((def) => [def.name, tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: async (input) => {
      try {
        ensurePermission(ctx, def.permission);
        return await def.execute(input as never, ctx);
      } catch (error) {
        return { ok: false, message: safeError(error) } satisfies CendroAiToolResult;
      }
    },
  })]));
}

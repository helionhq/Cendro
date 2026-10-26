/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { currentJdCycle, defaultTimeZone } from "./taskCycles";
import { MAX_REFERENCE_NUMBER, nextReference, syncReferenceCounter } from "./references";
import { defaultRoleCapabilities } from "../src/lib/permissions";
import type { FunctionArgs } from "convex/server";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seed() {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
    const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId, managerMembershipId, employeeMembershipId };
  });
  return { t, ...ids };
}

const makeTest = () => convexTest(schema, modules);
type ConvexTestEnv = ReturnType<typeof makeTest>;
type ConvexTestActor = ReturnType<ConvexTestEnv["withIdentity"]>;
type CommitArgs = FunctionArgs<typeof api.taskImports.commitTaskImportBatch>;

function draft(overrides: Record<string, unknown> = {}) {
  return {
    rowKey: "JD Tasks:2", sourceSheet: "JD Tasks", sourceRow: 2, source: "cendro" as const, kind: "jd" as const,
    reference: "JD-001", title: "Opening checklist", description: null, notes: null, recurrence: "daily" as const, dueDate: null, priority: null,
    time: null, quantity: null, rawAssigneeText: "admin@example.com", assigneeEmails: ["admin@example.com"], status: null, isActive: null, presentFields: ["reference", "title", "recurrence", "assignees"] as ("reference" | "title" | "recurrence" | "assignees" | "status" | "notes" | "isActive" | "evidenceRequired" | "confirmationRequired" | "confirmerEmail")[],
    warnings: [], ...overrides,
  };
}

// Commits the way the UI does: stage a preview of the file's drafts, then pass
// the returned previewId so the commit is bound to the whole previewed file.
async function commitImport(
  actor: ConvexTestActor,
  args: Omit<CommitArgs, "previewId" | "source" | "batchKey"> & { batchKey?: string },
) {
  const preview = await actor.mutation(api.taskImports.previewTaskImport, {
    companyId: args.companyId,
    kind: args.kind,
    drafts: args.rows.map((row) => row.draft),
  });
  return await actor.mutation(api.taskImports.commitTaskImportBatch, {
    ...args,
    batchKey: args.batchKey ?? "batch-1",
    source: "cendro",
    previewId: preview.previewId,
  });
}

describe("task import backend", () => {
  test("previews and commits a create, then returns the receipt on retry", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [draft()] });
    expect(preview.rows[0]).toMatchObject({ operation: "create", proposedAssigneeMembershipIds: [adminMembershipId] });
    const args = { companyId, kind: "jd" as const, importKey: "import-1", batchKey: "batch-1", source: "cendro" as const, previewId: preview.previewId, rows: [{ draft: draft(), include: true, selectedAssigneeMembershipIds: [adminMembershipId] }] };
    const first = await admin.mutation(api.taskImports.commitTaskImportBatch, args);
    const second = await admin.mutation(api.taskImports.commitTaskImportBatch, args);
    expect(first).toMatchObject({ created: 1, updated: 0, taskReferences: ["JD-001"] });
    expect(second).toEqual(first);
    await expect(commitImport(admin, {
      ...args,
      rows: [{ ...args.rows[0], draft: draft({ title: "Different task" }) }],
    })).rejects.toThrow(/already used for different rows/);
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page).toHaveLength(1);
  });

  test("imported status is ignored for JD tasks even after older cycles elapsed", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily close", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const oldCycleStart = currentJdCycle("daily", Date.now() - 3 * 86_400_000, defaultTimeZone).start;
    const expectedUpdatedAt = await t.run(async (ctx) => {
      const updatedAt = Date.now() + 1;
      await ctx.db.patch(taskId, { cycleStartedAt: oldCycleStart, statusCycleStart: oldCycleStart, status: "due", updatedAt });
      return updatedAt;
    });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-current-cycle", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: task.task.reference, title: "Renamed", status: "completed", presentFields: ["reference", "title", "status"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });

    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("Renamed");
    expect(updated.task.status).toBe("due");
    expect(updated.task.state.rawStatus).toBe("due");
    expect(updated.task.statusCycleStart).toBe(oldCycleStart);
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toHaveLength(0);
    const logs = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect());
    expect(logs.some((l) => l.event === "status_changed")).toBe(false);
  });

  test("status in old drafts is ignored and blank assignees preserve updates", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Old", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const result = await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-2", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ rowKey: "JD Tasks:2", reference: task.task.reference, title: "New", status: "completed", presentFields: ["reference", "title", "assignees", "status"] }) }],
    });
    expect(result.updated).toBe(1);
    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("New");
    expect(updated.task.assigneeMembershipIds).toEqual([adminMembershipId]);
    expect(updated.task.status).toBe("due");
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toHaveLength(0);
    const logs = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect());
    expect(logs.some((l) => l.event === "status_changed")).toBe(false);
  });

  test("requires the preview version and rejects duplicate update references", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Old", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const updateDraft = draft({ reference: task.task.reference, title: "New", presentFields: ["reference", "title"] });
    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-stale", batchKey: "batch-1", 
      rows: [{ include: true, selectedAssigneeMembershipIds: null, draft: updateDraft }],
    })).rejects.toThrow(/changed since preview/);
    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-duplicate", batchKey: "batch-1", 
      rows: [
        { include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: updateDraft },
        { include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: { ...updateDraft, rowKey: "JD Tasks:3" } },
      ],
    })).rejects.toThrow(/duplicate task references/);
  });

  test("updates preserve fields that were absent from the source", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Keep", description: "Keep description", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-partial", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({  reference: task.task.reference, title: "Ignored", description: "Ignored", recurrence: null, presentFields: ["reference"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task).toMatchObject({ title: "Keep", description: "Keep description", recurrence: "weekly" });
  });

  test("a due-date import does not turn a completed one-time task overdue", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Filed", dueDate: Date.now() + 86_400_000, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const oneTimeDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Filed", recurrence: null, dueDate: Date.now() - 86_400_000, priority: "critical" as const, status: "completed" as const, presentFields: ["reference", "dueDate", "priority", "status"] as ("reference" | "dueDate" | "priority" | "status")[], rawAssigneeText: "", assigneeEmails: [] };
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-completed", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: oneTimeDraft }],
    });
    const updated = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(updated.task.status).toBe("completed");
    expect(updated.task.priority).toBe("critical");
    expect(updated.task.overdueAt).toBeUndefined();
    expect(updated.task.state.rawStatus).toBe("completed");
  });

  test("invalid normalized workbook values stay blocked instead of clearing fields", async () => {
    const { t, companyId } = await seed();
    const preview = await t.withIdentity(identity("admin")).mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ quantity: null, presentFields: ["reference", "title", "recurrence", "quantity", "assignees"], warnings: ["Quantity must be a positive number."] })],
    });
    expect(preview.rows[0]).toMatchObject({ operation: "blocked", errors: ["Quantity must be a positive number."] });
  });

  test("unrecognized status warnings from old sheets do not block the import", async () => {
    const { t, companyId } = await seed();
    const preview = await t.withIdentity(identity("admin")).mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ status: null, presentFields: ["reference", "title", "recurrence", "assignees", "status"], warnings: ['Status "Typo" is not recognized (use Pending, In Progress, or Completed).'] })],
    });
    expect(preview.rows[0].operation).toBe("create");
    expect(preview.rows[0].errors).toEqual([]);
  });

  test("an employee without create permission cannot call preview, commit, or export", async () => {
    const { t, companyId } = await seed();
    const employee = t.withIdentity(identity("employee"));
    await expect(employee.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [draft()] })).rejects.toThrow(/You do not have access/);
    await expect(commitImport(employee, { companyId, kind: "jd", importKey: "k", batchKey: "b",  rows: [] })).rejects.toThrow();
    await expect(employee.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } })).rejects.toThrow(/You do not have access/);
  });

  test("manager exportRows and imports are scoped to their managed branch", async () => {
    const t = convexTest(schema, modules);
    const { companyId, empAMembershipId, empBMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Scoped Corp", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empa", email: "empa@example.com", firstName: "EmpA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empb", email: "empb@example.com", firstName: "EmpB", createdAt: now, updatedAt: now });

      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      return { companyId, adminMembershipId, managerMembershipId, empAMembershipId, empBMembershipId };
    });

    const admin = t.withIdentity(identity("admin"));
    const manager = t.withIdentity(identity("manager"));

    // Admin creates 2 JD tasks: one for Branch A employee, one for Branch B employee
    await admin.mutation(api.tasks.createJd, { companyId, title: "Branch A Task", recurrence: "daily", assigneeMembershipIds: [empAMembershipId] });
    await admin.mutation(api.tasks.createJd, { companyId, title: "Branch B Task", recurrence: "daily", assigneeMembershipIds: [empBMembershipId] });

    // Admin export gets all 2 tasks
    const adminExport = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(adminExport.page).toHaveLength(2);

    // Manager export only gets the task in Branch A (their managed branch)
    const managerExport = await manager.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(managerExport.page).toHaveLength(1);
    expect(managerExport.page[0].title).toBe("Branch A Task");

    // Manager preview with Branch A employee is valid
    const validPreview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ reference: "JD-003", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] })],
    });
    expect(validPreview.rows[0].operation).toBe("create");
    expect(validPreview.rows[0].proposedAssigneeMembershipIds).toEqual([empAMembershipId]);

    // Manager preview with Branch B employee (outside scope) fails to resolve assignee
    const outOfScopePreview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ reference: "JD-004", rawAssigneeText: "empb@example.com", assigneeEmails: ["empb@example.com"] })],
    });
    expect(outOfScopePreview.rows[0].operation).toBe("blocked");
    expect(outOfScopePreview.rows[0].errors).toContain('Assignee "empb@example.com" is outside your assignable scope.');
  });

  test("manager imports and updates targets beyond the managed-scope cache", async () => {
    const t = convexTest(schema, modules);
    const { companyId, targetMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Large Scope Corp", createdAt: now });
      const managerUserId = await ctx.db.insert("appUsers", {
        clerkSubject: "clerk|large-scope-manager",
        email: "large-scope-manager@example.com",
        firstName: "Manager",
        createdAt: now,
        updatedAt: now,
      });
      const managerMembershipId = await ctx.db.insert("companyMemberships", {
        companyId,
        userId: managerUserId,
        role: "Manager",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const branchId = await ctx.db.insert("branches", {
        companyId,
        name: "Operations",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId, updatedAt: now });

      let targetMembershipId;
      for (let index = 1; index <= 501; index += 1) {
        const target = index === 501;
        const userId = await ctx.db.insert("appUsers", {
          clerkSubject: `clerk|large-scope-${index}`,
          email: target ? "target@example.com" : `large-scope-${index}@example.com`,
          firstName: target ? "Target" : `Member ${index}`,
          createdAt: now,
          updatedAt: now,
        });
        const membershipId = await ctx.db.insert("companyMemberships", {
          companyId,
          userId,
          role: "Employee",
          active: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("userBranchAssignments", { companyId, membershipId, branchId });
        if (target) targetMembershipId = membershipId;
      }
      return { companyId, targetMembershipId };
    });
    const manager = t.withIdentity(identity("large-scope-manager", "large-scope-manager@example.com"));
    const createDraft = draft({
      reference: "JD-501",
      rawAssigneeText: "target@example.com",
      assigneeEmails: ["target@example.com"],
    });

    const createPreview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [createDraft],
    });
    expect(createPreview.rows[0]).toMatchObject({
      operation: "create",
      proposedAssigneeMembershipIds: [targetMembershipId],
    });
    await expect(commitImport(manager, {
      companyId,
      kind: "jd",
      importKey: "large-scope-create",
      batchKey: "batch-1",
      
      rows: [{ include: true, selectedAssigneeMembershipIds: [targetMembershipId!], draft: createDraft }],
    })).resolves.toMatchObject({ created: 1, updated: 0 });

    const updateDraft = draft({
      reference: "JD-501",
      title: "Updated by manager",
      rawAssigneeText: "",
      assigneeEmails: [],
      presentFields: ["reference", "title"],
    });
    const updatePreview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [updateDraft],
    });
    expect(updatePreview.rows[0]).toMatchObject({ operation: "update" });
    await expect(commitImport(manager, {
      companyId,
      kind: "jd",
      importKey: "large-scope-update",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        expectedUpdatedAt: updatePreview.rows[0].current?.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: updateDraft,
      }],
    })).resolves.toMatchObject({ created: 0, updated: 1 });
  });

  test("imports update overdue one-time tasks without changing their status", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const pastDueDate = Date.now() - 3600_000;
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Past Task", dueDate: pastDueDate, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const exportedDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Past Task", recurrence: null, dueDate: pastDueDate, priority: "medium" as const, status: "due" as const, presentFields: ["reference", "status"] as ("reference" | "status")[], rawAssigneeText: "", assigneeEmails: [] };

    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "one_time", drafts: [exportedDraft],
    });
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[0].errors).toEqual([]);
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-overdue-roundtrip", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: exportedDraft }],
    });

    const unchanged = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(unchanged.task.state.rawStatus).toBe("overdue");
    const changedDraft = { ...exportedDraft, title: "Edited overdue task", priority: "high" as const, status: "completed" as const, presentFields: ["reference", "title", "priority", "status"] as ("reference" | "title" | "priority" | "status")[] };

    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-overdue", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: unchanged.task.updatedAt, selectedAssigneeMembershipIds: null, draft: changedDraft }],
    });

    const updated = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(updated.task.title).toBe("Edited overdue task");
    expect(updated.task.priority).toBe("high");
    expect(updated.task.state.rawStatus).toBe("overdue");
    expect(updated.task.overdueAt).toBeDefined();

    const rescheduledDraft = { ...changedDraft, dueDate: Date.now() + 86_400_000, presentFields: ["reference", "dueDate", "status"] as ("reference" | "dueDate" | "status")[] };
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-rescheduled", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: updated.task.updatedAt, selectedAssigneeMembershipIds: null, draft: rescheduledDraft }],
    });
    const rescheduled = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(rescheduled.task.state).toMatchObject({ rawStatus: "due", isOverdue: false });
    expect(rescheduled.task.overdueAt).toBeUndefined();
    // Imported status is still ignored; rescheduling only removes the overdue overlay.
    await expect(admin.mutation(api.tasks.completeOneTime, { companyId, taskId })).resolves.toBeNull();
  });

  test("imports never change one-time task status or log status_changed", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const futureDueDate = Date.now() + 86_400_000;
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Future Task", dueDate: futureDueDate, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const statusDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Renamed Task", recurrence: null, dueDate: futureDueDate, priority: "medium" as const, status: "completed" as const, presentFields: ["reference", "title", "status"] as ("reference" | "title" | "status")[], rawAssigneeText: "", assigneeEmails: [] };

    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-ot-status", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: statusDraft }],
    });

    const updated = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(updated.task.title).toBe("Renamed Task");
    expect(updated.task.status).toBe("due");
    expect(updated.task.completedAt).toBeUndefined();
    const logs = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId)).collect());
    expect(logs.some((l) => l.event === "status_changed")).toBe(false);
  });

  test("evidenceRequired imports create, preserve, and clear the flag", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // New tasks default to not requiring evidence.
    const plainId = await admin.mutation(api.tasks.createJd, { companyId, title: "Plain", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: plainId })).task.evidenceRequired).toBeUndefined();

    // Create with Yes.
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "evidence-create", batchKey: "batch-1",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-002", title: "Evidence task", evidenceRequired: true, presentFields: ["reference", "title", "recurrence", "assignees", "evidenceRequired"] }),
      }],
    });
    const created = (await admin.query(api.tasks.listJdRows, { companyId, search: "Evidence task", paginationOpts: { numItems: 10, cursor: null } })).page[0];
    expect(created.evidenceRequired).toBe(true);

    // A blank column preserves the existing value on update.
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "evidence-blank", batchKey: "batch-1",
      rows: [{
        include: true,
        expectedUpdatedAt: created.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: "JD-002", title: "Renamed", presentFields: ["reference", "title"], rawAssigneeText: "", assigneeEmails: [] }),
      }],
    });
    const preserved = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    expect(preserved.task.title).toBe("Renamed");
    expect(preserved.task.evidenceRequired).toBe(true);

    // No clears the flag.
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "evidence-clear", batchKey: "batch-1",
      rows: [{
        include: true,
        expectedUpdatedAt: preserved.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: "JD-002", evidenceRequired: false, presentFields: ["reference", "evidenceRequired"], rawAssigneeText: "", assigneeEmails: [] }),
      }],
    });
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: created._id })).task.evidenceRequired).toBeUndefined();

    // The one-time branch applies the same create/clear semantics.
    const oneTimeDraft = {
      ...draft(),
      rowKey: "One-Time Tasks:2",
      sourceSheet: "One-Time Tasks",
      kind: "one_time" as const,
      reference: "TSK-002",
      title: "Evidence one-time",
      recurrence: null,
      dueDate: null,
      priority: "medium" as const,
      evidenceRequired: true,
      presentFields: ["reference", "title", "priority", "assignees", "evidenceRequired"] as ("reference" | "title" | "priority" | "assignees" | "evidenceRequired")[],
      rawAssigneeText: "",
      assigneeEmails: [],
    };
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "evidence-one-time-create", batchKey: "batch-1",
      rows: [{ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: oneTimeDraft }],
    });
    const oneTime = (await admin.query(api.tasks.listOneTimeRows, { companyId, search: "Evidence one-time", paginationOpts: { numItems: 10, cursor: null } })).page[0];
    expect(oneTime.evidenceRequired).toBe(true);
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "evidence-one-time-clear", batchKey: "batch-1",
      rows: [{
        include: true,
        expectedUpdatedAt: oneTime.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: { ...oneTimeDraft, evidenceRequired: false, presentFields: ["reference", "evidenceRequired"] as ("reference" | "evidenceRequired")[], title: null },
      }],
    });
    expect((await admin.query(api.tasks.getOneTime, { companyId, taskId: oneTime._id })).task.evidenceRequired).toBeUndefined();

    // A present cell that normalized to neither Yes nor No blocks the row.
    const blocked = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd",
      drafts: [draft({ reference: "JD-003", evidenceRequired: null, presentFields: ["reference", "title", "recurrence", "assignees", "evidenceRequired"] })],
    });
    expect(blocked.rows[0].operation).toBe("blocked");
    expect(blocked.rows[0].errors).toContain("Evidence required must be Yes or No.");
  });

  test("confirmation imports create, preserve, re-point, and clear the confirmer", async () => {
    const { t, companyId, adminMembershipId, managerMembershipId, employeeMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const employee = t.withIdentity(identity("employee"));

    // Yes plus a valid email creates a task with that confirmer.
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-create", batchKey: "batch-1",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [employeeMembershipId],
        draft: draft({ reference: "JD-010", title: "Signed off", confirmationRequired: true, confirmerEmail: "Manager@Example.com", presentFields: ["reference", "title", "recurrence", "assignees", "confirmationRequired", "confirmerEmail"] }),
      }],
    });
    const created = (await admin.query(api.tasks.listJdRows, { companyId, search: "Signed off", paginationOpts: { numItems: 10, cursor: null } })).page[0];
    expect(created.confirmerMembershipId).toBe(managerMembershipId);

    // The submission waits on the imported confirmer.
    await employee.mutation(api.tasks.completeJd, { companyId, taskId: created._id });
    const pending = async () => await t.run(async (ctx) => await ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", created._id)).first());
    expect((await pending())?.confirmerMembershipId).toBe(managerMembershipId);

    // A blank column preserves the confirmer on update.
    const submitted = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-blank", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: submitted.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: "JD-010", title: "Renamed", presentFields: ["reference", "title"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    expect((await pending())?.confirmerMembershipId).toBe(managerMembershipId);

    // Re-pointing follows the same path as a task edit.
    const renamed = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-repoint", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: renamed.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: "JD-010", confirmationRequired: true, confirmerEmail: "admin@example.com", presentFields: ["reference", "confirmationRequired", "confirmerEmail"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    expect((await pending())?.confirmerMembershipId).toBe(adminMembershipId);

    // Clearing while a submission is pending is refused; it must be resolved first.
    const repointed = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-clear", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: repointed.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: "JD-010", confirmationRequired: false, presentFields: ["reference", "confirmationRequired"], rawAssigneeText: "", assigneeEmails: [] }) }],
    })).rejects.toThrow("Confirm or send back the pending submissions before turning off confirmation.");

    // The re-pointed confirmer resolves it, then the clear is a plain edit.
    const request = (await admin.query(api.tasks.listAwaitingConfirmation, { companyId, taskType: "jd" })).rows[0];
    await admin.mutation(api.tasks.sendBackTaskCompletion, { companyId, requestId: request._id });
    expect(await pending()).toBeNull();
    const returned = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-clear-resolved", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: returned.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: "JD-010", confirmationRequired: false, presentFields: ["reference", "confirmationRequired"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    const cleared = await admin.query(api.tasks.getJd, { companyId, taskId: created._id });
    expect(cleared.task.confirmerMembershipId).toBeUndefined();
    expect(cleared.task.state.rawStatus).toBe("in_progress");
  });

  test("confirmation imports reject inconsistent or ineligible confirmers", async () => {
    const { t, companyId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const preview = async (overrides: Record<string, unknown>) => await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-020", title: "Needs a decision", ...overrides })],
    });

    const missingEmail = await preview({ confirmationRequired: true, presentFields: ["reference", "title", "recurrence", "assignees", "confirmationRequired"] });
    expect(missingEmail.rows[0].operation).toBe("blocked");
    expect(missingEmail.rows[0].errors).toContain("Confirmation required needs a confirmer email.");

    const emailWithoutConfirmation = await preview({ confirmationRequired: false, confirmerEmail: "admin@example.com", presentFields: ["reference", "title", "recurrence", "assignees", "confirmationRequired", "confirmerEmail"] });
    expect(emailWithoutConfirmation.rows[0].operation).toBe("blocked");
    expect(emailWithoutConfirmation.rows[0].errors).toContain("Confirmer email is only allowed when confirmation is required.");

    const ineligible = await preview({ confirmationRequired: true, confirmerEmail: "employee@example.com", presentFields: ["reference", "title", "recurrence", "assignees", "confirmationRequired", "confirmerEmail"] });
    expect(ineligible.rows[0].operation).toBe("blocked");
    expect(ineligible.rows[0].errors).toContain("The selected confirmer cannot confirm task completion.");
  });

  test("an import cannot change the confirmer with self-only update authority", async () => {
    const { t, companyId, managerMembershipId, employeeMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const employee = t.withIdentity(identity("employee"));
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", { companyId, name: "Employee", capabilities: [...defaultRoleCapabilities.Employee, "tasks:jd:import"], createdAt: Date.now(), updatedAt: Date.now() });
    });
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Self-appointed import", recurrence: "daily", assigneeMembershipIds: [employeeMembershipId], confirmerMembershipId: managerMembershipId });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });

    await expect(commitImport(employee, {
      companyId, kind: "jd", importKey: "confirm-self-only", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: task.task.reference, title: "Self-appointed import", confirmationRequired: true, confirmerEmail: "admin@example.com", presentFields: ["reference", "title", "confirmationRequired", "confirmerEmail"], rawAssigneeText: "", assigneeEmails: [] }) }],
    })).rejects.toThrow("You cannot change who confirms this task.");
    expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.confirmerMembershipId).toBe(managerMembershipId);
  });

  test("an import may keep an existing confirmer who no longer holds the capability", async () => {
    const { t, companyId, adminMembershipId, managerMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Keep the confirmer", recurrence: "daily", assigneeMembershipIds: [adminMembershipId], confirmerMembershipId: managerMembershipId });
    // The confirmer role loses the capability after the task was configured.
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", { companyId, name: "Manager", capabilities: defaultRoleCapabilities.Manager.filter((capability) => capability !== "tasks:confirm"), createdAt: Date.now(), updatedAt: Date.now() });
    });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-keep", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: task.task.reference, title: "Keep the confirmer renamed", confirmationRequired: true, confirmerEmail: "manager@example.com", presentFields: ["reference", "title", "confirmationRequired", "confirmerEmail"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("Keep the confirmer renamed");
    expect(updated.task.confirmerMembershipId).toBe(managerMembershipId);
  });

  test("exportRows writes confirmation columns and the exported confirmer re-imports unchanged", async () => {
    const { t, companyId, adminMembershipId, managerMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const jdId = await admin.mutation(api.tasks.createJd, { companyId, title: "Export JD", recurrence: "daily", assigneeMembershipIds: [adminMembershipId], confirmerMembershipId: managerMembershipId });
    await admin.mutation(api.tasks.createOneTime, { companyId, title: "Export OT", dueDate: Date.now() + 86_400_000, priority: "medium", assigneeMembershipIds: [adminMembershipId], confirmerMembershipId: managerMembershipId });

    const jdExport = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { numItems: 50, cursor: null } });
    expect(jdExport.page[0]).toMatchObject({ confirmationRequired: true, confirmerEmail: "manager@example.com" });
    const otExport = await admin.query(api.tasks.exportRows, { companyId, kind: "one_time", paginationOpts: { numItems: 50, cursor: null } });
    expect(otExport.page[0]).toMatchObject({ confirmationRequired: true, confirmerEmail: "manager@example.com" });

    const task = await admin.query(api.tasks.getJd, { companyId, taskId: jdId });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "confirm-export-roundtrip", batchKey: "batch-1",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: jdExport.page[0].reference, title: jdExport.page[0].title, confirmationRequired: jdExport.page[0].confirmationRequired, confirmerEmail: jdExport.page[0].confirmerEmail, presentFields: ["reference", "title", "confirmationRequired", "confirmerEmail"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: jdId })).task.confirmerMembershipId).toBe(managerMembershipId);
  });

  test("exportRows includes description and notes, and imports preserve them across create and update", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // 1. Create JD and One-time tasks with description and notes
    const jdId = await admin.mutation(api.tasks.createJd, { companyId, title: "JD with notes", description: "Initial JD description", notes: "Initial JD note", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const otId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "OT with notes", description: "Initial OT description", notes: "Initial OT note", priority: "high", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId] });

    // 2. Verify exportRows includes description and notes for both kinds
    const jdExport = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(jdExport.page).toContainEqual(expect.objectContaining({ title: "JD with notes", description: "Initial JD description", notes: "Initial JD note" }));
    expect(jdExport.page[0]).not.toHaveProperty("status");

    const otExport = await admin.query(api.tasks.exportRows, { companyId, kind: "one_time", paginationOpts: { cursor: null, numItems: 50 } });
    expect(otExport.page).toContainEqual(expect.objectContaining({ title: "OT with notes", description: "Initial OT description", notes: "Initial OT note" }));
    expect(otExport.page[0]).not.toHaveProperty("status");

    // 3. Create task via import with description and notes
    const importCreateRes = await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-notes-create", batchKey: "batch-1", 
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({
          reference: "JD-010",
          title: "Imported JD Task",
          description: "Created description via import",
          notes: "Created via import",
          presentFields: ["reference", "title", "description", "notes", "recurrence", "assignees"],
        }),
      }],
    });
    expect(importCreateRes.created).toBe(1);
    const createdTasks = await admin.query(api.tasks.listJdRows, { companyId, search: "Imported JD Task", paginationOpts: { numItems: 10, cursor: null } });
    expect(createdTasks.page[0].description).toBe("Created description via import");
    expect(createdTasks.page[0].notes).toBe("Created via import");

    // 4. Update existing task description and notes via import
    const existingJd = await admin.query(api.tasks.getJd, { companyId, taskId: jdId });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-notes-update", batchKey: "batch-1", 
      rows: [{
        include: true,
        expectedUpdatedAt: existingJd.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({
          reference: existingJd.task.reference,
          title: existingJd.task.title,
          description: "Updated JD description via import",
          notes: "Updated JD note via import",
          presentFields: ["reference", "description", "notes"],
          rawAssigneeText: "",
          assigneeEmails: [],
        }),
      }],
    });
    const updatedJd = await admin.query(api.tasks.getJd, { companyId, taskId: jdId });
    expect(updatedJd.task.description).toBe("Updated JD description via import");
    expect(updatedJd.task.notes).toBe("Updated JD note via import");

    // 5. One-time create and update via import also apply description
    const otCreateRes = await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-ot-desc-create", batchKey: "batch-1", 
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: "TSK-010", title: "Imported OT Task", description: "OT created description", recurrence: null, dueDate: Date.now() + 86_400_000, priority: "medium" as const, presentFields: ["reference", "title", "description", "dueDate", "priority", "assignees"] as ("reference" | "title" | "description" | "dueDate" | "priority" | "assignees")[] },
      }],
    });
    expect(otCreateRes.created).toBe(1);
    const createdOt = await admin.query(api.tasks.listOneTimeRows, { companyId, search: "Imported OT Task", paginationOpts: { numItems: 10, cursor: null } });
    expect(createdOt.page[0].description).toBe("OT created description");

    const existingOt = await admin.query(api.tasks.getOneTime, { companyId, taskId: otId });
    await commitImport(admin, {
      companyId, kind: "one_time", importKey: "import-ot-desc-update", batchKey: "batch-1", 
      rows: [{
        include: true,
        expectedUpdatedAt: existingOt.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: { ...draft(), rowKey: "One-Time Tasks:3", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: existingOt.task.reference, title: existingOt.task.title, description: "Updated OT description via import", recurrence: null, dueDate: null, priority: null, presentFields: ["reference", "description"] as ("reference" | "description")[], rawAssigneeText: "", assigneeEmails: [] },
      }],
    });
    const updatedOt = await admin.query(api.tasks.getOneTime, { companyId, taskId: otId });
    expect(updatedOt.task.description).toBe("Updated OT description via import");
  });

  test("a recurrence-changing import retires a coincident completion without deleting history", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Coincident", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const newCycleStart = currentJdCycle("weekly", Date.now(), defaultTimeZone).start;
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: taskId, cycleStart: newCycleStart, completedAt: Date.now() });
    });

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-recurrence-coincident", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: task.task.reference, recurrence: "weekly", presentFields: ["reference", "recurrence"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });

    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.recurrence).toBe("weekly");
    expect(updated.task.status).toBe("due");
    expect(updated.task.state.rawStatus).toBe("due");
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toMatchObject([{ retiredAt: expect.any(Number) }]);

    // The manual edit path resets the cycle the same way.
    const manualTaskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Manual coincident", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: manualTaskId, cycleStart: newCycleStart, completedAt: Date.now() });
    });
    await admin.mutation(api.tasks.updateJd, { companyId, taskId: manualTaskId, title: "Manual coincident", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const manualUpdated = await admin.query(api.tasks.getJd, { companyId, taskId: manualTaskId });
    expect(manualUpdated.task.state.rawStatus).toBe("due");

    // updateJdFields (inline/detail editors, AI update tool) resets the same way
    const fieldsTaskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Fields coincident", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: fieldsTaskId, cycleStart: newCycleStart, completedAt: Date.now() });
    });
    await admin.mutation(api.tasks.updateJdFields, { companyId, taskId: fieldsTaskId, recurrence: "weekly" });
    const fieldsUpdated = await admin.query(api.tasks.getJd, { companyId, taskId: fieldsTaskId });
    expect(fieldsUpdated.task.state.rawStatus).toBe("due");
  });

  test("creates new task using imported task code if it does not exist and syncs counter", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Preview import with non-existent code JD-050
    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-050", title: "Custom Code Task" })],
    });
    expect(preview.rows[0].operation).toBe("create");
    expect(preview.rows[0].reference).toBe("JD-050");

    // Commit import with non-existent code JD-050
    const commitRes = await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "custom-code-import",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-050", title: "Custom Code Task" }),
      }],
    });
    expect(commitRes.created).toBe(1);
    expect(commitRes.taskReferences).toEqual(["JD-050"]);

    // Verify task exists with exact code JD-050
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page[0].reference).toBe("JD-050");
    expect(tasks.page[0].title).toBe("Custom Code Task");

    // Verify that subsequent manual task creation via nextReference allocates JD-051, avoiding collision
    const nextManualId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Subsequent Manual Task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });
    const nextManual = await admin.query(api.tasks.getJd, { companyId, taskId: nextManualId });
    expect(nextManual.task.reference).toBe("JD-051");
  });

  test("updates existing task when imported task code already exists", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Create a task
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Initial Title",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });
    const created = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(created.task.reference).toBe("JD-001");

    // Preview import with existing code JD-001
    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", title: "Updated via Import" })],
    });
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[0].reference).toBe("JD-001");

    // Commit update
    const commitRes = await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "update-existing-code",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        expectedUpdatedAt: created.task.updatedAt,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-001", title: "Updated via Import" }),
      }],
    });
    expect(commitRes.updated).toBe(1);
    expect(commitRes.created).toBe(0);

    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("Updated via Import");
    expect(updated.task.reference).toBe("JD-001");
  });

  test("validates required task code format and returns clear errors", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Missing / empty task code
    const missingPreview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: null, presentFields: ["title", "recurrence", "assignees"] })],
    });
    expect(missingPreview.rows[0].operation).toBe("blocked");
    expect(missingPreview.rows[0].errors).toContain("Task code is required and must match JD-001.");

    // Wrong prefix for JD (e.g. TSK-001)
    const wrongPrefixPreview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "TSK-001" })],
    });
    expect(wrongPrefixPreview.rows[0].operation).toBe("blocked");
    expect(wrongPrefixPreview.rows[0].errors).toContain("Code must match JD-001.");

    // Wrong prefix for One-Time (e.g. JD-001)
    const oneTimeDraft = {
      ...draft(),
      rowKey: "One-Time Tasks:2",
      sourceSheet: "One-Time Tasks",
      kind: "one_time" as const,
      reference: "JD-001",
      recurrence: null,
      dueDate: Date.now() + 86400000,
      priority: "medium" as const,
      presentFields: ["reference", "title", "dueDate", "priority", "assignees"] as ("reference" | "title" | "dueDate" | "priority" | "assignees")[],
    };
    const wrongOneTimePrefix = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "one_time",
      drafts: [oneTimeDraft],
    });
    expect(wrongOneTimePrefix.rows[0].operation).toBe("blocked");
    expect(wrongOneTimePrefix.rows[0].errors).toContain("Code must match TSK-001.");

    // Invalid format (less than 3 digits, or non-numeric)
    const malformedPreview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-1" })],
    });
    expect(malformedPreview.rows[0].operation).toBe("blocked");
    expect(malformedPreview.rows[0].errors).toContain("Code must match JD-001.");

    // Direct commit with invalid format throws
    await expect(commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "invalid-code-commit",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "INVALID" }),
      }],
    })).rejects.toThrow(/Code must match JD-001/);
  });

  test("user without create permission cannot create task using new task code", async () => {
    const { t, companyId } = await seed();
    const { employeeMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const empUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|importer", email: "importer@example.com", firstName: "Importer", createdAt: now, updatedAt: now });
      const membershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empUserId, role: "Importer", active: true, createdAt: now, updatedAt: now });
      // Custom role grants tasks:jd:import but NOT tasks:jd:create
      await ctx.db.insert("roles", { companyId, name: "Importer", capabilities: [...defaultRoleCapabilities.Employee, "tasks:jd:import"], createdAt: now, updatedAt: now });
      return { employeeMembershipId: membershipId };
    });

    const importer = t.withIdentity(identity("importer"));

    // Preview non-existent code JD-999
    const preview = await importer.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-999", rawAssigneeText: "importer@example.com", assigneeEmails: ["importer@example.com"] })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("You do not have permission to create tasks for this task kind.");

    // Commit fails
    await expect(commitImport(importer, {
      companyId,
      kind: "jd",
      importKey: "no-create-perm",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [employeeMembershipId],
        draft: draft({ reference: "JD-999", rawAssigneeText: "importer@example.com", assigneeEmails: ["importer@example.com"] }),
      }],
    })).rejects.toThrow(/You do not have permission to create tasks for this task kind/);
  });

  test("user cannot update a task outside their permissions or use an existing task code outside their permissions", async () => {
    const t = convexTest(schema, modules);
    const { companyId, managerMembershipId, empAMembershipId, empBMembershipId, jdTaskBId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Branch Corp", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empa", email: "empa@example.com", firstName: "EmpA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empb", email: "empb@example.com", firstName: "EmpB", createdAt: now, updatedAt: now });

      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      // Create a task assigned to Branch B employee
      const jdTaskBId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-001",
        title: "Branch B Task",
        recurrence: "daily",
        cycleStartedAt: now,
        status: "due",
        statusCycleStart: now,
        assigneeMembershipIds: [empBMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });

      return { companyId, managerMembershipId, empAMembershipId, empBMembershipId, jdTaskBId };
    });

    const manager = t.withIdentity(identity("manager"));

    // Manager (who has create permission, but only update:managed) tries to import code JD-001
    // JD-001 already exists for Branch B (outside manager's managed branch)
    const preview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", title: "Hijack Task", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] })],
    });

    // Operation must be BLOCKED, not create, not update
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("Task code belongs to an existing task that you do not have permission to edit.");

    // Commit must fail
    await expect(commitImport(manager, {
      companyId,
      kind: "jd",
      importKey: "hijack-attempt",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [empAMembershipId],
        draft: draft({ reference: "JD-001", title: "Hijack Task", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] }),
      }],
    })).rejects.toThrow(/Task code belongs to an existing task that you do not have permission to edit/);

    // Verify task in Branch B is unchanged
    const originalTask = await t.run(async (ctx) => await ctx.db.get(jdTaskBId));
    expect(originalTask?.title).toBe("Branch B Task");
    expect(originalTask?.assigneeMembershipIds).toEqual([empBMembershipId]);
  });

  test("user cannot assign a task to someone outside their assignable scope", async () => {
    const t = convexTest(schema, modules);
    const { companyId, managerMembershipId, empAMembershipId, empBMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Branch Scope Corp", createdAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|mgr", email: "mgr@example.com", firstName: "Mgr", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|userA", email: "usera@example.com", firstName: "UserA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|userB", email: "userb@example.com", firstName: "UserB", createdAt: now, updatedAt: now });

      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      return { companyId, managerMembershipId, empAMembershipId, empBMembershipId };
    });

    const manager = t.withIdentity(identity("mgr"));

    // Manager assigns to userb (in Branch B, outside scope)
    const preview = await manager.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", rawAssigneeText: "userb@example.com", assigneeEmails: ["userb@example.com"] })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain('Assignee "userb@example.com" is outside your assignable scope.');

    // Direct commit must also fail
    await expect(commitImport(manager, {
      companyId,
      kind: "jd",
      importKey: "unassignable-attempt",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: "JD-001", rawAssigneeText: "userb@example.com", assigneeEmails: ["userb@example.com"] }),
      }],
    })).rejects.toThrow(/Assignee "userb@example.com" is outside your assignable scope/);
  });

  test("exported tasks preserve task codes and re-importing updates the existing tasks without creating duplicates", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Create 2 tasks
    await admin.mutation(api.tasks.createJd, { companyId, title: "Task 1", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.createJd, { companyId, title: "Task 2", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    // Export rows
    const exportResult = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(exportResult.page).toHaveLength(2);
    expect(exportResult.page.map((p) => p.reference)).toEqual(["JD-001", "JD-002"]);

    // Re-import the exported rows with modified titles
    const drafts = exportResult.page.map((row, index) => draft({
      rowKey: `JD Tasks:${index + 2}`,
      reference: row.reference,
      title: `${row.title} (Updated)`,
      recurrence: "recurrence" in row ? row.recurrence : "daily",
      presentFields: ["reference", "title", "recurrence", "assignees"],
    }));

    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[1].operation).toBe("update");

    await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "roundtrip-update",
      batchKey: "batch-1",
      
      rows: preview.rows.map((r) => ({
        include: true,
        expectedUpdatedAt: r.current?.updatedAt,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: r.draft,
      })),
    });

    // Verify still exactly 2 tasks, updated in place
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page).toHaveLength(2);
    const titles = tasks.page.map((p) => p.title);
    expect(titles).toContain("Task 1 (Updated)");
    expect(titles).toContain("Task 2 (Updated)");
  });

  test("rejects unsafe numeric reference suffixes during preview, commit, and counter sync", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Preview with unsafe numeric suffix
    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-9007199254740992" }), draft({ rowKey: "JD Tasks:3", reference: "JD-99999999999999999999" })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("Code must match JD-001.");
    expect(preview.rows[1].operation).toBe("blocked");
    expect(preview.rows[1].errors).toContain("Code must match JD-001.");

    // Commit with unsafe numeric suffix fails
    await expect(commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "unsafe-code-commit",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-9007199254740992" }),
      }],
    })).rejects.toThrow(/Code must match JD-001/);

    // Direct call to syncReferenceCounter ignores unsafe numbers without polluting counter
    await t.run(async (ctx) => {
      await syncReferenceCounter(ctx, companyId, "jd", "JD-9007199254740992");
      await syncReferenceCounter(ctx, companyId, "jd", "JD-99999999999999999999");
      const counter = await ctx.db
        .query("referenceCounters")
        .withIndex("by_companyId_and_kind", (q) => q.eq("companyId", companyId).eq("kind", "jd"))
        .unique();
      expect(counter).toBeNull();
    });
  });

  test("importing the largest accepted code advances counter and caps manual allocation before 16-digit overflow", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // 1. Preview and commit largest valid 15-digit code JD-999999999999999
    const maxRef = `JD-${MAX_REFERENCE_NUMBER}`;
    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: maxRef, title: "Max Code Task" })],
    });
    expect(preview.rows[0].operation).toBe("create");
    expect(preview.rows[0].errors).toEqual([]);

    const commitRes = await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "max-code-commit",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: maxRef, title: "Max Code Task" }),
      }],
    });
    expect(commitRes.taskReferences).toEqual([maxRef]);

    // Counter must have synced to MAX_REFERENCE_NUMBER
    const counter = await t.run(async (ctx) => {
      return await ctx.db
        .query("referenceCounters")
        .withIndex("by_companyId_and_kind", (q) => q.eq("companyId", companyId).eq("kind", "jd"))
        .unique();
    });
    expect(counter?.lastNumber).toBe(MAX_REFERENCE_NUMBER);

    // 2. Re-import of the max-code task succeeds (round trip invariant preserved)
    const reimportPreview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: maxRef, title: "Max Code Task" })],
    });
    expect(reimportPreview.rows[0].operation).toBe("update");
    expect(reimportPreview.rows[0].errors).toEqual([]);

    // 3. Attempting subsequent manual creation caps allocation and throws instead of generating invalid 16-digit code JD-1000000000000000
    await expect(admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Overflow Task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    })).rejects.toThrow(/Reference limit reached for jd/);

    // 4. Directly calling nextReference also throws when capped
    await expect(t.run(async (ctx) => {
      return await nextReference(ctx, companyId, "jd");
    })).rejects.toThrow(/Reference limit reached for jd/);

    // 5. Capping also applies to one_time and sop
    await expect(t.run(async (ctx) => {
      await ctx.db.insert("referenceCounters", { companyId, kind: "one_time", lastNumber: MAX_REFERENCE_NUMBER });
      return await nextReference(ctx, companyId, "one_time");
    })).rejects.toThrow(/Reference limit reached for one_time/);

    await expect(t.run(async (ctx) => {
      await ctx.db.insert("referenceCounters", { companyId, kind: "sop", lastNumber: MAX_REFERENCE_NUMBER });
      return await nextReference(ctx, companyId, "sop");
    })).rejects.toThrow(/Reference limit reached for sop/);

    // 6. When counter is at MAX_REFERENCE_NUMBER - 1, nextReference successfully allocates MAX_REFERENCE_NUMBER
    const atBoundary = await t.run(async (ctx) => {
      await ctx.db.patch(counter!._id, { lastNumber: MAX_REFERENCE_NUMBER - 1 });
      return await nextReference(ctx, companyId, "jd");
    });
    expect(atBoundary).toBe(maxRef);
  });

  test("importing an update syncs reference counter ahead of stale counter to prevent collision", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Insert task directly with JD-100 and counter at 10
    const { updatedAt } = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("referenceCounters", { companyId, kind: "jd", lastNumber: 10 });
      const taskId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-100",
        title: "Legacy Task",
        recurrence: "daily",
        cycleStartedAt: now,
        status: "due",
        statusCycleStart: now,
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
      return { taskId, updatedAt: now };
    });

    // Import an update for JD-100
    const result = await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "sync-on-update",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        expectedUpdatedAt: updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: "JD-100", title: "Updated Legacy Task", presentFields: ["reference", "title"], rawAssigneeText: "", assigneeEmails: [] }),
      }],
    });
    expect(result.updated).toBe(1);

    // Counter must have synced to 100
    const counter = await t.run(async (ctx) => {
      return await ctx.db
        .query("referenceCounters")
        .withIndex("by_companyId_and_kind", (q) => q.eq("companyId", companyId).eq("kind", "jd"))
        .unique();
    });
    expect(counter?.lastNumber).toBe(100);

    // Subsequent manual creation should allocate JD-101 without collision
    const nextManualId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "New Manual Task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });
    const nextManual = await admin.query(api.tasks.getJd, { companyId, taskId: nextManualId });
    expect(nextManual.task.reference).toBe("JD-101");
  });

  test("resolves assignees past the first 500 company memberships", async () => {
    const { t, companyId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Insert 505 memberships in the company
    const { member505Id } = await t.run(async (ctx) => {
      const now = Date.now();
      let targetId: any = null;
      for (let i = 3; i <= 505; i++) {
        const email = `user${i}@example.com`;
        const userId = await ctx.db.insert("appUsers", {
          clerkSubject: `clerk|user${i}`,
          email,
          firstName: `User${i}`,
          createdAt: now,
          updatedAt: now,
        });
        const mId = await ctx.db.insert("companyMemberships", {
          companyId,
          userId,
          role: "Employee",
          active: true,
          createdAt: now,
          updatedAt: now,
        });
        if (i === 505) targetId = mId;
      }
      return { member505Id: targetId };
    });

    const preview = await admin.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-505", rawAssigneeText: "user505@example.com", assigneeEmails: ["user505@example.com"] })],
    });

    expect(preview.rows[0].operation).toBe("create");
    expect(preview.rows[0].proposedAssigneeMembershipIds).toEqual([member505Id]);
    expect(preview.rows[0].errors).toEqual([]);

    const commitResult = await commitImport(admin, {
      companyId,
      kind: "jd",
      importKey: "commit-505",
      batchKey: "batch-1",
      
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [member505Id],
        draft: preview.rows[0].draft,
      }],
    });
    expect(commitResult.created).toBe(1);
    expect(commitResult.taskReferences).toEqual(["JD-505"]);
  });

  test("bounds assignee resolution and scopes properly when caller can only assign to self", async () => {
    const { t, companyId } = await seed();
    const { selfMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("appUsers", {
        clerkSubject: "clerk|selfonly",
        email: "selfonly@example.com",
        firstName: "SelfOnly",
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("companyMemberships", {
        companyId,
        userId,
        role: "Importer",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roles", {
        companyId,
        name: "Importer",
        capabilities: [...defaultRoleCapabilities.Employee, "tasks:jd:import", "tasks:jd:create", "tasks:jd:assign:self"],
        createdAt: now,
        updatedAt: now,
      });
      return { selfMembershipId: membershipId };
    });

    const selfUser = t.withIdentity(identity("selfonly"));

    // Preview with own email resolves to self
    const previewSelf = await selfUser.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", rawAssigneeText: "selfonly@example.com", assigneeEmails: ["selfonly@example.com"] })],
    });
    expect(previewSelf.rows[0].operation).toBe("create");
    expect(previewSelf.rows[0].proposedAssigneeMembershipIds).toEqual([selfMembershipId]);
    expect(previewSelf.rows[0].errors).toEqual([]);

    // Preview with someone else's email is blocked as outside assignable scope
    const previewOther = await selfUser.mutation(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-002", rawAssigneeText: "admin@example.com", assigneeEmails: ["admin@example.com"] })],
    });
    expect(previewOther.rows[0].operation).toBe("blocked");
    expect(previewOther.rows[0].errors).toContain('Assignee "admin@example.com" is outside your assignable scope.');

    // Commit with self assignee succeeds
    const commitRes = await selfUser.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "self-import",
      batchKey: "batch-1",
      source: "cendro",
      previewId: previewSelf.previewId,
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [selfMembershipId],
        draft: previewSelf.rows[0].draft,
      }],
    });
    expect(commitRes.created).toBe(1);
    expect(commitRes.taskReferences).toEqual(["JD-001"]);
  });

  test("the Is active column makes an imported JD task inactive and reactivates it, restoring scheduling", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily check", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const lifecycleDraft = (isActive: boolean) => draft({ reference: task.task.reference, isActive, presentFields: ["reference", "isActive"], rawAssigneeText: "", assigneeEmails: [] });

    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [lifecycleDraft(false)] });
    expect(preview.rows[0]).toMatchObject({ operation: "update", warnings: ["This task will be made inactive."] });

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-inactive", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: lifecycleDraft(false) }],
    });
    const paused = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(paused.task.pausedAt).toBeTypeOf("number");
    expect(paused.task.state.status).toBe("Inactive");
    // Inactive rows are hidden from the list and discovery, but exported with isActive: false.
    expect((await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
    expect((await admin.query(api.analytics.summary, { companyId })).jdTaskCount).toBe(0);
    expect((await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { numItems: 10, cursor: null } })).page).toMatchObject([{ reference: task.task.reference, isActive: false }]);

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-active", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: paused.task.updatedAt, selectedAssigneeMembershipIds: null, draft: lifecycleDraft(true) }],
    });
    const restored = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(restored.task.pausedAt).toBeUndefined();
    expect(restored.task.state.rawStatus).toBe("due");
    expect(restored.task.statusCycleStart).toBe(restored.task.cycleStartedAt);
    const events = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect());
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["paused", "resumed"]));
  });

  test("drafts without the isActive field from older clients still validate", async () => {
    const { t, companyId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const { isActive: _omitted, ...oldClientDraft } = draft({ reference: "JD-100" });
    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [oldClientDraft] });
    expect(preview.rows[0].operation).toBe("create");
  });

  test("a combined reassign + inactive row cannot escape a manager's scope", async () => {
    const t = convexTest(schema, modules);
    const { companyId, taskId, taskRef } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Scoped Corp", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empa", email: "empa@example.com", firstName: "EmpA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empb", email: "empb@example.com", firstName: "EmpB", createdAt: now, updatedAt: now });
      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });
      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });
      // The manager may assign anyone and update in-scope tasks, but lifecycle
      // grants never widen past the managed scope.
      await ctx.db.insert("roles", { companyId, name: "Manager", capabilities: ["tasks:jd:import", "tasks:jd:view:managed", "tasks:jd:update:managed", "tasks:jd:assign:any", "tasks:jd:pause", "tasks:jd:resume"], createdAt: now, updatedAt: now });
      const taskId = await ctx.db.insert("jdTasks", { companyId, reference: "JD-001", title: "Branch A Task", recurrence: "daily", assigneeMembershipIds: [empAMembershipId], createdByMembershipId: adminMembershipId, createdAt: now, updatedAt: now, cycleStartedAt: now, status: "due", statusCycleStart: now });
      return { companyId, taskId, taskRef: "JD-001" };
    });
    const manager = t.withIdentity(identity("manager"));
    const admin = t.withIdentity(identity("admin"));
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });

    // In-scope task stays in-scope on lifecycle alone.
    const inScopeDraft = draft({ reference: taskRef, isActive: false, presentFields: ["reference", "isActive"], rawAssigneeText: "", assigneeEmails: [] });
    const okPreview = await manager.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [inScopeDraft] });
    expect(okPreview.rows[0].errors).toEqual([]);

    // Reassigning the same task out of scope in the same row must fail the
    // lifecycle check — the check has to look at the proposed assignees.
    const escapeDraft = draft({ reference: taskRef, isActive: false, presentFields: ["reference", "assignees", "isActive"], rawAssigneeText: "empb@example.com", assigneeEmails: ["empb@example.com"] });
    const preview = await manager.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [escapeDraft] });
    expect(preview.rows[0].errors).toContain("You do not have permission to make this task inactive.");
    await expect(commitImport(manager, {
      companyId, kind: "jd", importKey: "scope-escape", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: escapeDraft }],
    })).rejects.toThrow(/permission to make this task inactive/);
    expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.pausedAt).toBeUndefined();
  });

  test("a combined frequency + inactive row preserves an in-cycle completion", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily check", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "completed" });
    const completed = await admin.query(api.tasks.getJd, { companyId, taskId });
    const stampedStart = completed.task.statusCycleStart!;

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-combined", batchKey: "batch-1", 
      rows: [{
        include: true,
        expectedUpdatedAt: completed.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: completed.task.reference, recurrence: "weekly", isActive: false, presentFields: ["reference", "recurrence", "isActive"], rawAssigneeText: "", assigneeEmails: [] }),
      }],
    });

    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(task.task.pausedAt).toBeTypeOf("number");
    expect(task.task.recurrence).toBe("weekly");
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", stampedStart)).collect());
    expect(completions.filter((row) => row.retiredAt === undefined)).toHaveLength(1);
  });

  test("creating and editing inactive state via import requires the matching lifecycle capability", async () => {
    const { t, companyId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    // Creating an already-inactive task needs the same permission as making one inactive.
    const inactiveDraft = draft({ reference: "JD-050", isActive: false, presentFields: ["reference", "title", "recurrence", "assignees", "isActive"] });
    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-create-inactive", batchKey: "batch-1", 
      rows: [{ include: true, selectedAssigneeMembershipIds: null, draft: inactiveDraft }],
    });
    expect((await admin.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts: { numItems: 10, cursor: null } })).page).toMatchObject([{ reference: "JD-050", state: { status: "Inactive" } }]);

    // An importer with update:any + resume but no pause can reactivate yet cannot inactivate.
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|importer", email: "importer@example.com", firstName: "Importer", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId, role: "Importer", active: true, createdAt: now, updatedAt: now });
      await ctx.db.insert("roles", { companyId, name: "Importer", capabilities: [...defaultRoleCapabilities.Employee, "tasks:jd:import", "tasks:jd:create", "tasks:jd:update:any", "tasks:jd:view:any", "tasks:jd:assign:any", "tasks:jd:resume"], createdAt: now, updatedAt: now });
    });
    const importer = t.withIdentity(identity("importer"));
    const createPreview = await importer.mutation(api.taskImports.previewTaskImport, {
      companyId, kind: "jd",
      drafts: [draft({ reference: "JD-051", isActive: false, presentFields: ["reference", "title", "recurrence", "assignees", "isActive"], rawAssigneeText: "importer@example.com", assigneeEmails: ["importer@example.com"] })],
    });
    expect(createPreview.rows[0].errors).toContain("You do not have permission to make tasks inactive.");

    const existing = await admin.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts: { numItems: 10, cursor: null } });
    const pausedTask = await admin.query(api.tasks.getJd, { companyId, taskId: existing.page[0]._id });
    const activateDraft = draft({ reference: "JD-050", isActive: true, presentFields: ["reference", "isActive"], rawAssigneeText: "", assigneeEmails: [] });
    const resumePreview = await importer.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [activateDraft] });
    expect(resumePreview.rows[0]).toMatchObject({ operation: "update", errors: [] });
    await commitImport(importer, {
      companyId, kind: "jd", importKey: "import-resume", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: pausedTask.task.updatedAt, selectedAssigneeMembershipIds: null, draft: activateDraft }],
    });
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: pausedTask.task._id })).task.pausedAt).toBeUndefined();

    const deactivateDraft = draft({ reference: "JD-050", isActive: false, presentFields: ["reference", "isActive"], rawAssigneeText: "", assigneeEmails: [] });
    const pausePreview = await importer.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [deactivateDraft] });
    expect(pausePreview.rows[0].errors).toContain("You do not have permission to make this task inactive.");
    const activeTask = await admin.query(api.tasks.getJd, { companyId, taskId: pausedTask.task._id });
    await expect(commitImport(importer, {
      companyId, kind: "jd", importKey: "import-pause-denied", batchKey: "batch-1", 
      rows: [{ include: true, expectedUpdatedAt: activeTask.task.updatedAt, selectedAssigneeMembershipIds: null, draft: deactivateDraft }],
    })).rejects.toThrow(/permission to make this task inactive/);
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: pausedTask.task._id })).task.pausedAt).toBeUndefined();
  });
});

describe("all-or-nothing imports", () => {
  async function countJdTasks(t: ConvexTestEnv, companyId: Id<"companies">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect()).length
    );
  }
  async function countReceipts(t: ConvexTestEnv, companyId: Id<"companies">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("taskImportBatches").withIndex("by_companyId_and_importKey_and_batchKey", (q) => q.eq("companyId", companyId)).collect()).length
    );
  }
  async function countPreviews(t: ConvexTestEnv, companyId: Id<"companies">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("taskImportPreviews").collect()).filter((row) => row.companyId === companyId).length
    );
  }

  test("a mixed valid/invalid file blocks in preview and commits nothing", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const good = draft({ reference: "JD-001", title: "Good row" });
    const bad = draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "BROKEN", title: "Bad row" });

    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [good, bad] });
    expect(preview.rows[0]).toMatchObject({ operation: "create", sourceRow: 2 });
    expect(preview.rows[1]).toMatchObject({ operation: "blocked", sourceRow: 3 });
    expect(preview.rows[1].errors).toContain("Code must match JD-001.");

    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-mixed", batchKey: "batch-1", 
      rows: [
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: good },
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: bad },
      ],
    })).rejects.toThrow(/Code must match JD-001/);

    expect(await countJdTasks(t, companyId)).toBe(0);
    expect(await countReceipts(t, companyId)).toBe(0);
  });

  test("a fully invalid file commits nothing", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const badRef = draft({ reference: "XX-001" });
    const noTitle = draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002", title: null });

    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [badRef, noTitle] });
    expect(preview.rows.map((r) => r.operation)).toEqual(["blocked", "blocked"]);
    expect(preview.rows[0].errors).toContain("Code must match JD-001.");
    expect(preview.rows[1].errors).toContain("Task title is required.");

    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-all-bad", batchKey: "batch-1", 
      rows: [
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: badRef },
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: noTitle },
      ],
    })).rejects.toThrow();

    expect(await countJdTasks(t, companyId)).toBe(0);
    expect(await countReceipts(t, companyId)).toBe(0);
  });

  test("a fully valid file commits every row in one batch", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const drafts = [
      draft({ reference: "JD-001", title: "First" }),
      draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002", title: "Second" }),
      draft({ rowKey: "JD Tasks:4", sourceRow: 4, reference: "JD-003", title: "Third" }),
    ];

    const result = await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-all-good", batchKey: "batch-1", 
      rows: drafts.map((d) => ({ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: d })),
    });

    expect(result).toMatchObject({ created: 3, updated: 0, skipped: 0, failed: 0 });
    expect(result.taskReferences).toEqual(["JD-001", "JD-002", "JD-003"]);
    expect(await countJdTasks(t, companyId)).toBe(3);
    // The staged preview is consumed by the commit.
    expect(await countPreviews(t, companyId)).toBe(0);
  });

  test("rejects commits that omit or alter rows from the previewed file", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const good = draft({ reference: "JD-001" });
    const other = draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002", title: "Second" });

    const preview = await admin.mutation(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [good, other] });

    // A subset of the file cannot commit: the row count diverges.
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-subset", batchKey: "batch-1", source: "cendro", previewId: preview.previewId,
      rows: [{ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: good }],
    })).rejects.toThrow(/do not match the previewed file/);

    // An altered draft cannot commit either: the fingerprint diverges.
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-altered", batchKey: "batch-1", source: "cendro", previewId: preview.previewId,
      rows: [
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: good },
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002", title: "Edited" }) },
      ],
    })).rejects.toThrow(/do not match the previewed file/);

    // A preview issued to another member cannot be reused either.
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin2", email: "admin2@example.com", firstName: "Admin2", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    });
    const otherAdmin = t.withIdentity(identity("admin2"));
    await expect(otherAdmin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-stolen-preview", batchKey: "batch-1", source: "cendro", previewId: preview.previewId,
      rows: [
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: good },
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: other },
      ],
    })).rejects.toThrow(/preview is not available/);

    expect(await countJdTasks(t, companyId)).toBe(0);
    expect(await countReceipts(t, companyId)).toBe(0);
  });

  test("a larger file with creates and elapsed-cycle updates commits in one batch", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Ten existing daily tasks a few cycles behind exercise recordMissedJdCycles
    // inside the same single commit.
    const updateRows = [];
    let firstTaskId: Id<"jdTasks"> | null = null;
    for (let i = 0; i < 10; i += 1) {
      const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: `Existing ${i}`, recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
      firstTaskId ??= taskId;
      await t.run(async (ctx) => {
        await ctx.db.patch(taskId, { cycleStartedAt: Date.now() - 3 * 86_400_000 });
      });
      const task = await admin.query(api.tasks.getJd, { companyId, taskId });
      updateRows.push({
        include: true,
        expectedUpdatedAt: task.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ rowKey: `JD Tasks:${i + 2}`, sourceRow: i + 2, reference: task.task.reference, title: `Renamed ${i}`, presentFields: ["reference", "title"], rawAssigneeText: "", assigneeEmails: [] }),
      });
    }
    const createRows = Array.from({ length: 50 }, (_, i) => ({
      include: true,
      selectedAssigneeMembershipIds: [adminMembershipId],
      draft: draft({ rowKey: `JD Tasks:${i + 20}`, sourceRow: i + 20, reference: `JD-${String(i + 100)}`, title: `Created ${i}` }),
    }));

    const result = await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-large", batchKey: "batch-1",
      rows: [...updateRows, ...createRows],
    });

    expect(result).toMatchObject({ created: 50, updated: 10, skipped: 0, failed: 0 });
    expect(await countJdTasks(t, companyId)).toBe(60);
    expect(await countPreviews(t, companyId)).toBe(0);
    const renamed = await admin.query(api.tasks.getJd, { companyId, taskId: firstTaskId! });
    expect(renamed.task.title).toBe("Renamed 0");
  });

  test("a file needing more catch-up than a transaction holds is rejected before writing", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Ten tasks ~400 days behind on a daily recurrence each hit the 200-cycle
    // catch-up cap: 10 x 400 + 40 fixed estimated lookups exceeds the bound.
    const rows = [];
    for (let i = 0; i < 10; i += 1) {
      const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: `Stale ${i}`, recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
      await t.run(async (ctx) => {
        await ctx.db.patch(taskId, { cycleStartedAt: Date.now() - 400 * 86_400_000 });
      });
      const task = await admin.query(api.tasks.getJd, { companyId, taskId });
      rows.push({
        include: true,
        expectedUpdatedAt: task.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({ rowKey: `JD Tasks:${i + 2}`, sourceRow: i + 2, reference: task.task.reference, title: `Renamed ${i}`, presentFields: ["reference", "title"], rawAssigneeText: "", assigneeEmails: [] }),
      });
    }

    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-too-big", batchKey: "batch-1",
      rows,
    })).rejects.toThrow(/more work than one import can process/);

    // Nothing was written: titles are unchanged and there is no receipt.
    const firstTaskId = await t.run(async (ctx) =>
      (await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", companyId)).first())!._id
    );
    const stale = await admin.query(api.tasks.getJd, { companyId, taskId: firstTaskId });
    expect(stale.task.title).toBe("Stale 0");
    expect(await countReceipts(t, companyId)).toBe(0);
  });

  test("rejects a commit that excludes reviewed rows", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-partial-include", batchKey: "batch-1", 
      rows: [
        { include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ reference: "JD-001" }) },
        { include: false, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002" }) },
      ],
    })).rejects.toThrow(/must include every reviewed row/);

    expect(await countJdTasks(t, companyId)).toBe(0);
    expect(await countReceipts(t, companyId)).toBe(0);
  });

  test("a second batch under a committed import key is rejected", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-once", batchKey: "import-once:0", 
      rows: [{ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ reference: "JD-001" }) }],
    });

    // Same batchKey replays the receipt idempotently.
    const replay = await commitImport(admin, {
      companyId, kind: "jd", importKey: "import-once", batchKey: "import-once:0", 
      rows: [{ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ reference: "JD-001" }) }],
    });
    expect(replay.created).toBe(1);

    // A different batch under the same key can never double-apply rows.
    await expect(commitImport(admin, {
      companyId, kind: "jd", importKey: "import-once", batchKey: "import-once:1", 
      rows: [{ include: true, selectedAssigneeMembershipIds: [adminMembershipId], draft: draft({ rowKey: "JD Tasks:3", sourceRow: 3, reference: "JD-002" }) }],
    })).rejects.toThrow(/already committed/);

    expect(await countJdTasks(t, companyId)).toBe(1);
    expect(await countReceipts(t, companyId)).toBe(1);
  });
});

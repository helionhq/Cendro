/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { localDateField } from "./taskCycles";
import { dashboardTaskLimit } from "./analytics";

const modules = import.meta.glob("./**/*.ts");
// Pinned so the dashboard period and seeded createdAt values never straddle a
// day boundary while the suite runs.
const pinnedNow = Date.UTC(2026, 8, 16, 12);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(pinnedNow);
});
afterEach(() => { vi.useRealTimers(); });
const yearPeriod = () => ({ unit: "year" as const, date: localDateField(Date.now()) });

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seedOneTimeTasks(count: number) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const { companyId, adminM } = await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", { name: "Budget Corp", createdAt: now });
    const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
    const adminM = await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminM };
  });
  const addTasks = (from: number, to: number) => t.run(async (ctx) => {
    for (let i = from; i <= to; i++) {
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: `TASK-${i}`,
        title: `Task ${i}`,
        priority: "medium",
        status: "due",
        assigneeMembershipIds: [adminM],
        createdByMembershipId: adminM,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }
  });
  await addTasks(1, count);
  return { t, companyId, addOneMore: () => addTasks(count + 1, count + 1) };
}

describe("WP-07: Query budgets and silent incompleteness prevention", () => {
  test("the dashboard counts tasks up to its ceiling and flags the overflow", { timeout: 60_000 }, async () => {
    const { t, companyId, addOneMore } = await seedOneTimeTasks(dashboardTaskLimit);
    const admin = t.withIdentity(identity("admin"));

    // Exactly at the cap is still a complete report.
    const complete = await admin.query(api.analytics.dashboard, { companyId, now: Date.now(), period: yearPeriod() });
    expect(complete.isTruncated).toBe(false);
    expect(complete.tasks.assigned).toBe(dashboardTaskLimit);

    await addOneMore();
    const overflow = await admin.query(api.analytics.dashboard, { companyId, now: Date.now(), period: yearPeriod() });
    expect(overflow.isTruncated).toBe(true);
  });

  test("501 tasks detect overflow via limit + 1 and mark metrics as truncated/incomplete", { timeout: 15_000 }, async () => {
    const { t, companyId } = await seedOneTimeTasks(501);

    // aiSummary query MUST report incomplete/truncated state
    const aiSum = await t.withIdentity(identity("admin")).query(api.analytics.aiSummary, { companyId });
    expect(aiSum.isTruncated).toBe(true);
    expect(aiSum.isComplete).toBe(false);

    const performance = await t.withIdentity(identity("admin")).query(api.aiWorkspace.performanceSummary, { companyId });
    expect(performance.isTruncated).toBe(true);
    expect(performance.isComplete).toBe(false);
  });

  test("user beyond the first 500 is discoverable by authorized picker when searched", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId, targetUserM } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Big Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

      // An inactive member inside the first 500 must not hide the overflow flag.
      for (let i = 1; i <= 500; i++) {
        const u = await ctx.db.insert("appUsers", { clerkSubject: `clerk|user${i}`, email: `user${i}@example.com`, firstName: `User${i}`, createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId, userId: u, role: "Employee", active: i !== 499, createdAt: now, updatedAt: now });
      }

      // Member 501: special unique name
      const targetUser = await ctx.db.insert("appUsers", {
        clerkSubject: "clerk|target501",
        email: "zoebeyond@example.com",
        firstName: "Zoe",
        secondName: "Beyond",
        createdAt: now,
        updatedAt: now,
      });
      const targetUserM = await ctx.db.insert("companyMemberships", { companyId, userId: targetUser, role: "Employee", active: true, createdAt: now, updatedAt: now });

      return { companyId, targetUserM };
    });

    const initial = await t.withIdentity(identity("admin")).query(api.tasks.assignableUsers, {
      companyId,
      kind: "one_time",
    });
    expect(initial.users).toHaveLength(499);
    expect(initial.isTruncated).toBe(true);

    // Admin searches for "Zoe" in assignableUsers.
    const results = await t.withIdentity(identity("admin")).query(api.tasks.assignableUsers, {
      companyId,
      kind: "one_time",
      search: "Zoe",
    });

    expect(results.isTruncated).toBe(false);
    expect(results.users.length).toBeGreaterThanOrEqual(1);
    expect(results.users.some((r) => r.membership._id === targetUserM)).toBe(true);
    expect(results.users.find((r) => r.membership._id === targetUserM)?.user.fullName).toBe("Zoe Beyond");
  });

  test("companyManagement.overview detects truncated membership list when >500 members", { timeout: 15_000 }, async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Mega Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

      for (let i = 1; i <= 501; i++) {
        const u = await ctx.db.insert("appUsers", { clerkSubject: `clerk|emp${i}`, email: `emp${i}@example.com`, firstName: `Emp${i}`, createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId, userId: u, role: "Employee", active: true, createdAt: now, updatedAt: now });
      }

      return { companyId };
    });

    const ov = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    expect(ov.isTruncated).toBe(true);
    expect(ov.truncated?.users).toBe(true);
  });

  test("manager operations reach members beyond the initial scope cache", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId, adminMembershipId, targetMembershipId } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Scoped Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUser, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const branchId = await ctx.db.insert("branches", { companyId, name: "Operations", order: 0, createdAt: now, updatedAt: now });
      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId, updatedAt: now });

      let targetMembershipId;
      for (let i = 1; i <= 501; i++) {
        const target = i === 501;
        const userId = await ctx.db.insert("appUsers", { clerkSubject: `clerk|scoped${i}`, email: target ? "zoescoped@example.com" : `scoped${i}@example.com`, firstName: target ? "Zoe" : `Scoped${i}`, createdAt: now, updatedAt: now });
        const membershipId = await ctx.db.insert("companyMemberships", { companyId, userId, role: "Employee", active: true, createdAt: now, updatedAt: now });
        await ctx.db.insert("userBranchAssignments", { companyId, membershipId, branchId });
        if (target) targetMembershipId = membershipId;
      }

      return { companyId, adminMembershipId, targetMembershipId };
    });

    const summary = await t.withIdentity(identity("manager")).query(api.analytics.summary, { companyId });
    expect(summary.isTruncated).toBe(true);
    expect(summary.isComplete).toBe(false);

    const initial = await t.withIdentity(identity("manager")).query(api.tasks.assignableUsers, { companyId, kind: "one_time" });
    expect(initial.isTruncated).toBe(true);

    const broadSearch = await t.withIdentity(identity("manager")).query(api.tasks.assignableUsers, { companyId, kind: "one_time", search: "Scoped" });
    expect(broadSearch.users).toHaveLength(50);
    expect(broadSearch.isTruncated).toBe(true);

    const searched = await t.withIdentity(identity("manager")).query(api.tasks.assignableUsers, { companyId, kind: "one_time", search: "Zoe" });
    expect(searched.isTruncated).toBe(false);
    expect(searched.users.some((row) => row.membership._id === targetMembershipId)).toBe(true);

    await expect(t.withIdentity(identity("manager")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Scoped task",
      assigneeMembershipIds: [targetMembershipId!],
      priority: "medium",
    })).resolves.toEqual(expect.any(String));

    const taskId = await t.run(async (ctx) => await ctx.db.insert("oneTimeTasks", {
      companyId,
      reference: "TSK-MANAGED-501",
      title: "Managed task",
      priority: "medium",
      status: "due",
      assigneeMembershipIds: [targetMembershipId!],
      createdByMembershipId: adminMembershipId,
      createdAt: now,
      updatedAt: now,
    }));
    const manager = t.withIdentity(identity("manager"));
    await expect(manager.query(api.tasks.getOneTime, { companyId, taskId })).resolves.toMatchObject({
      canUpdate: true,
      canDelete: true,
    });
    await expect(manager.mutation(api.tasks.updateOneTime, {
      companyId,
      taskId,
      title: "Managed task updated",
      assigneeMembershipIds: [targetMembershipId!],
      priority: "medium",
    })).resolves.toBeNull();
    await expect(manager.mutation(api.tasks.deleteOneTime, { companyId, taskId })).resolves.toBeNull();
  });

  test("assignable search flags scans beyond 1,000 memberships", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Search Cap Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });
      for (let i = 0; i < 1_000; i++) {
        const overflowUser = await ctx.db.insert("appUsers", { clerkSubject: `clerk|overflow${i}`, email: `overflow${i}@example.com`, firstName: "Overflow", createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId, userId: overflowUser, role: "Employee", active: true, createdAt: now, updatedAt: now });
      }
      return { companyId };
    });

    const result = await t.withIdentity(identity("admin")).query(api.tasks.assignableUsers, {
      companyId,
      kind: "one_time",
      search: "Needle",
    });
    expect(result.users).toEqual([]);
    expect(result.isTruncated).toBe(true);
  });
});

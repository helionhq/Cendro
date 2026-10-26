/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { createAiPersistencePayload, signAiPersistencePayload } from "../src/lib/ai-chat-hmac";
import { defaultRoleCapabilities } from "../src/lib/permissions";

const modules = import.meta.glob("./**/*.ts");
const MESSAGE_HISTORY_LIMIT = 100;

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const otherCompanyId = await ctx.db.insert("companies", { name: "Other", createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", secondName: "", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const employee2UserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee2", email: "employee2@example.com", firstName: "Employee 2", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const otherAdminMembershipId = await ctx.db.insert("companyMemberships", { companyId: otherCompanyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    const employee2MembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employee2UserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("managerUserScopes", { companyId, managerMembershipId, userMembershipId: employeeMembershipId, updatedAt: now });
    return { companyId, otherCompanyId, adminMembershipId, otherAdminMembershipId, managerMembershipId, employeeMembershipId, employee2MembershipId };
  });
  return { t, ...ids };
}

describe("AI agent Convex boundaries", () => {
  test("AI analytics are scoped by role", async () => {
    const seeded = await seed();
    const { t, companyId, adminMembershipId, employeeMembershipId, employee2MembershipId } = seeded;
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Employee task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Hidden employee task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employee2MembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Admin task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await expect(t.withIdentity(identity("admin")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ oneTimeTaskCount: 3 });
    await expect(t.withIdentity(identity("manager")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ scopeSize: 2, oneTimeTaskCount: 1 });
    await expect(t.withIdentity(identity("employee")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ scopeSize: 1, oneTimeTaskCount: 1 });
  });

  test("AI task and SOP reads stay in visible scope", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId, employee2MembershipId } = await seed();
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Visible task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Hidden task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employee2MembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Visible SOP", content: "Shared procedure", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Hidden SOP", content: "Private procedure", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [adminMembershipId] });

    const tasks = await t.withIdentity(identity("employee")).query(api.tasks.aiListVisible, { companyId, status: "all", limit: 10 });
    expect(tasks.rows.map((task) => task.title)).toEqual(["Visible task"]);
    expect(tasks.truncated).toBe(false);
    const sops = await t.withIdentity(identity("employee")).query(api.sops.aiListSops, { companyId, query: "procedure" });
    expect(sops.map((sop) => sop.title)).toEqual(["Visible SOP"]);
  });

  test("AI SOP search reaches content matches beyond the scan ceiling", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("sops", { companyId, reference: "SOP-OLD", title: "Legacy guide", content: "unique-needle-phrase", scopeType: "company", creatorMembershipId: adminMembershipId, updatedByMembershipId: adminMembershipId, createdAt: now, updatedAt: now });
    });
    for (let batch = 0; batch < 5; batch += 1) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 220; i += 1) {
          const seq = batch * 220 + i;
          await ctx.db.insert("sops", { companyId, reference: `SOP-${seq}`, title: `Filler ${seq}`, content: "routine filler text", scopeType: "company", creatorMembershipId: adminMembershipId, updatedByMembershipId: adminMembershipId, createdAt: now + seq, updatedAt: now + seq });
        }
      });
    }

    const sops = await t.withIdentity(identity("admin")).query(api.sops.aiListSops, { companyId, query: "unique-needle-phrase" });
    expect(sops.map((sop) => sop.reference)).toEqual(["SOP-OLD"]);
  });

  test("AI status changes follow the assignee rule and deny others", async () => {
    const { t, companyId, employeeMembershipId } = await seed();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Owned task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });

    const updated = await t.withIdentity(identity("employee")).mutation(api.tasks.aiSetStatus, { companyId, kind: "one_time", taskId, status: "completed" });
    expect(updated.status).toBe("Completed");

    await expect(t.withIdentity(identity("employee2")).mutation(api.tasks.aiSetStatus, { companyId, kind: "one_time", taskId, status: "due" })).rejects.toThrow();
  });

  test("AI cannot complete a task that requires evidence", async () => {
    const { t, companyId, employeeMembershipId } = await seed();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Evidence task",
      description: "",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [employeeMembershipId],
      priority: "medium",
      evidenceRequired: true,
    });

    await expect(
      t.withIdentity(identity("employee")).mutation(api.tasks.aiSetStatus, { companyId, kind: "one_time", taskId, status: "completed" }),
    ).rejects.toThrow("This task requires evidence to complete. Complete it from the task's completion dialog.");

    const detail = await t.withIdentity(identity("employee")).query(api.tasks.getOneTime, { companyId, taskId });
    expect(detail.task.status).toBe("due");
  });

  test("AI SOP updates and deletes follow scope permissions", async () => {
    const { t, companyId } = await seed();
    const sopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Company SOP", content: "Body", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    const detail = await t.withIdentity(identity("employee")).query(api.sops.aiGet, { companyId, sopId });
    expect(detail.title).toBe("Company SOP");
    expect(detail.canUpdate).toBe(false);
    expect(detail.canDelete).toBe(false);

    await expect(t.withIdentity(identity("employee")).mutation(api.sops.update, { companyId, sopId, title: "Renamed" })).rejects.toThrow();
    await expect(t.withIdentity(identity("employee")).mutation(api.sops.remove, { companyId, sopId })).rejects.toThrow();
  });

  test("cross-company AI sessions and unauthorized writes fail", async () => {
    const { t, companyId, otherCompanyId, employeeMembershipId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });

    await expect(t.withIdentity(identity("admin")).query(api.aiChat.authorizeSessionForAgent, { companyId: otherCompanyId, sessionId })).rejects.toThrow("Chat session not found");
    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.createOneTime, { companyId, title: "Nope", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" })).rejects.toThrow();
    await expect(t.withIdentity(identity("employee")).mutation(api.sops.create, { companyId, title: "Nope", content: "Body", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] })).rejects.toThrow();
  });

  test("AI session list excludes drafts until they have messages", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });

    await expect(t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId })).resolves.toEqual([]);

    await t.withIdentity(identity("admin")).mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content: "Hello" });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.map((session) => session._id)).toEqual([sessionId]);
  });

  test("AI session list includes legacy sessions without hasMessages", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const sessionId = await t.run(async (ctx) => {
      const now = Date.now();
      const sessionId = await ctx.db.insert("aiChatSessions", { companyId, membershipId: adminMembershipId, createdAt: now, updatedAt: now });
      await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: "Legacy message", createdAt: now });
      return sessionId;
    });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.map((session) => session._id)).toContain(sessionId);
  });

  test("AI message history returns the newest bounded window", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });
    await t.run(async (ctx) => {
      const now = Date.now() - 10_000;
      for (let i = 0; i < MESSAGE_HISTORY_LIMIT; i += 1) await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: `Old ${i}`, createdAt: now + i });
      await ctx.db.patch(sessionId, { hasMessages: true, updatedAt: now });
    });

    await t.withIdentity(identity("admin")).mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content: "Latest prompt" });

    const messages = await t.withIdentity(identity("admin")).query(api.aiChat.listMessages, { companyId, sessionId });
    expect(messages).toHaveLength(MESSAGE_HISTORY_LIMIT);
    expect(messages.map((message) => message.content)).toContain("Latest prompt");
    expect(messages.at(-1)?.content).toBe("Latest prompt");
  });

  test("AI session list returns recently updated sessions beyond the first 50 created", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const ids = [];
      for (let i = 0; i < 60; i += 1) ids.push(await ctx.db.insert("aiChatSessions", { companyId, membershipId: adminMembershipId, hasMessages: true, createdAt: now + i, updatedAt: now + i }));
      await ctx.db.patch(ids[0], { updatedAt: now + 10_000 });
      return ids;
    });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions).toHaveLength(50);
    expect(sessions[0]?._id).toBe(ids[0]);
    expect(sessions.map((session) => session._id)).toContain(ids[59]);
  });

  test("deleting an AI session removes all of its messages", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 101; i += 1) await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: `Message ${i}`, createdAt: now + i });
      await ctx.db.patch(sessionId, { hasMessages: true, updatedAt: now });
    });

    vi.useFakeTimers();
    try {
      await t.withIdentity(identity("admin")).mutation(api.aiChat.deleteSession, { companyId, sessionId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const remaining = await t.run(async (ctx) => await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(200));
    expect(remaining).toHaveLength(0);
    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.some((session) => session._id === sessionId)).toBe(false);
    await expect(t.withIdentity(identity("admin")).query(api.aiChat.listMessages, { companyId, sessionId })).rejects.toThrow("Chat session not found");
  });

  test("appendMessage only allows user role and rejects assistant or tool roles from browser", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });

    // Calling appendMessage with role "assistant" fails at validator level
    await expect(
      t.withIdentity(identity("admin")).mutation(api.aiChat.appendMessage, {
        companyId,
        sessionId,
        role: "assistant" as any,
        content: "I am a rogue assistant",
      })
    ).rejects.toThrow();
  });

  test("ai:use capability removal blocks appendMessage and aiWorkspace.context", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("employee")).mutation(api.aiChat.createSession, { companyId });

    // Remove ai:use from the Employee role
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("roles", {
        companyId,
        name: "Employee",
        capabilities: defaultRoleCapabilities.Employee.filter((capability) => capability !== "ai:use"),
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.withIdentity(identity("employee")).mutation(api.aiChat.appendMessage, {
        companyId,
        sessionId,
        role: "user",
        content: "Hello?",
      })
    ).rejects.toThrow("You do not have permission to use AI.");

    await expect(
      t.withIdentity(identity("employee")).query(api.aiWorkspace.context, { companyId })
    ).rejects.toThrow("You do not have access to AI capabilities.");
  });

  test("persistServerMessage enforces HMAC verification, expiry, replay prevention, and saves message", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });
    const secret = "super-secret-hmac-key-for-test-32b";
    process.env.AI_CHAT_PERSISTENCE_SECRET = secret;

    const timestamp = Date.now();
    const requestId = "req_test_12345";
    const content = "This is a verified assistant response.";

    const payload = createAiPersistencePayload({
      companyId,
      sessionId,
      role: "assistant",
      timestamp,
      requestId,
      content,
    });
    const validSignature = await signAiPersistencePayload(secret, payload);

    // Rejects invalid signature
    await expect(
      t.withIdentity(identity("admin")).mutation(api.aiChat.persistServerMessage, {
        companyId,
        sessionId,
        role: "assistant",
        content,
        timestamp,
        requestId: "req_bad_sig",
        signature: "0000000000000000000000000000000000000000000000000000000000000000",
      })
    ).rejects.toThrow("Invalid persistence signature.");

    // Rejects expired timestamp (> 5 min)
    const expiredTimestamp = timestamp - 10 * 60 * 1000;
    const expiredPayload = createAiPersistencePayload({
      companyId,
      sessionId,
      role: "assistant",
      timestamp: expiredTimestamp,
      requestId: "req_expired",
      content,
    });
    const expiredSignature = await signAiPersistencePayload(secret, expiredPayload);
    await expect(
      t.withIdentity(identity("admin")).mutation(api.aiChat.persistServerMessage, {
        companyId,
        sessionId,
        role: "assistant",
        content,
        timestamp: expiredTimestamp,
        requestId: "req_expired",
        signature: expiredSignature,
      })
    ).rejects.toThrow("Persistence request expired.");

    // Successfully persists with valid signature
    const msgId = await t.withIdentity(identity("admin")).mutation(api.aiChat.persistServerMessage, {
      companyId,
      sessionId,
      role: "assistant",
      content,
      timestamp,
      requestId,
      signature: validSignature,
    });
    expect(msgId).toBeDefined();

    // Rejects replay of the same requestId
    await expect(
      t.withIdentity(identity("admin")).mutation(api.aiChat.persistServerMessage, {
        companyId,
        sessionId,
        role: "assistant",
        content,
        timestamp,
        requestId,
        signature: validSignature,
      })
    ).rejects.toThrow("Replay detected: request ID already used.");

    // Message appears in listMessages
    const messages = await t.withIdentity(identity("admin")).query(api.aiChat.listMessages, { companyId, sessionId });
    expect(messages.some((m) => m.content === content && m.role === "assistant")).toBe(true);
  });

  test("enforces ai:use capability when reading individual sessions after revocation", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("employee")).mutation(api.aiChat.createSession, { companyId });
    await t.withIdentity(identity("employee")).mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content: "Hello AI" });

    // Both getSession and listMessages work before revocation
    await expect(t.withIdentity(identity("employee")).query(api.aiChat.getSession, { companyId, sessionId })).resolves.toMatchObject({ _id: sessionId });
    const msgsBefore = await t.withIdentity(identity("employee")).query(api.aiChat.listMessages, { companyId, sessionId });
    expect(msgsBefore).toHaveLength(1);

    // Revoke ai:use by removing it from the Employee role
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("roles", {
        companyId,
        name: "Employee",
        capabilities: defaultRoleCapabilities.Employee.filter((capability) => capability !== "ai:use"),
        createdAt: now,
        updatedAt: now,
      });
    });

    // listSessions returns empty array
    const sessions = await t.withIdentity(identity("employee")).query(api.aiChat.listSessions, { companyId });
    expect(sessions).toEqual([]);

    // getSession and listMessages now reject with permission error
    await expect(
      t.withIdentity(identity("employee")).query(api.aiChat.getSession, { companyId, sessionId })
    ).rejects.toThrow("You do not have permission to use AI.");

    await expect(
      t.withIdentity(identity("employee")).query(api.aiChat.listMessages, { companyId, sessionId })
    ).rejects.toThrow("You do not have permission to use AI.");
  });
});


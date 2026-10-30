import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { assertPlatformAdmin, ensureDefaultRoles, isPlatformAdminSubject } from "./permissions";
import { nonEmpty, normalizeEmail } from "./validation";

async function requirePlatformAdmin(ctx: { auth: { getUserIdentity: () => Promise<any> } }) {
  const identity = await ctx.auth.getUserIdentity();
  assertPlatformAdmin(identity);
  return identity!;
}

export const access = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return { isAdmin: Boolean(identity && isPlatformAdminSubject(identity.subject)), email: identity?.email ?? null };
  },
});

const MAX_ADMIN_COMPANIES = 500;

export const adminDashboard = query({
  args: { companyLimit: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const access = { isAdmin: Boolean(identity && isPlatformAdminSubject(identity?.subject)), email: identity?.email ?? null };
    if (!access.isAdmin) return { access, companies: [], hasMore: false };

    const limit = Math.min(Math.max(Math.floor(args.companyLimit), 1), MAX_ADMIN_COMPANIES);
    const page = await ctx.db.query("companies").order("desc").take(limit + 1);
    const companies = await Promise.all(
      page.slice(0, limit).map(async (company) => ({
        company,
        memberCount: (await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", company._id)).take(500)).length,
      })),
    );
    return { access, companies, hasMore: page.length > limit && limit < MAX_ADMIN_COMPANIES };
  },
});

export const listCompanies = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requirePlatformAdmin(ctx);
    const page = await ctx.db.query("companies").order("desc").paginate(args.paginationOpts);
    const rows = await Promise.all(
      page.page.map(async (company) => ({
        company,
        memberCount: (await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", company._id)).take(500)).length,
      })),
    );
    return { ...page, page: rows };
  },
});

export const createCompanyRecord = internalMutation({
  args: { name: v.string(), adminEmail: v.string() },
  handler: async (ctx, args) => {
    const identity = await requirePlatformAdmin(ctx);
    const actorEmail = identity.email || identity.subject;
    const now = Date.now();
    const name = nonEmpty(args.name, "Company name");
    const adminEmail = normalizeEmail(args.adminEmail);
    const pendingInvitations = await ctx.db.query("invitations").withIndex("by_email", (q) => q.eq("email", adminEmail)).take(100);
    for (const invitation of pendingInvitations) {
      if (invitation.role !== "Admin" || invitation.status !== "pending" || invitation.expiresAt <= now) continue;
      const company = await ctx.db.get(invitation.companyId);
      if (company && !company.deletedAt && company.name === name) return { companyId: company._id, invitationId: invitation._id, token: invitation.token };
    }
    const companyId = await ctx.db.insert("companies", { name, createdAt: now });
    await ensureDefaultRoles(ctx, companyId);
    const token = crypto.randomUUID();
    const invitationId = await ctx.db.insert("invitations", {
      companyId,
      email: adminEmail,
      role: "Admin",
      token,
      status: "pending",
      createdAt: now,
      expiresAt: now + 1_209_600_000,
      authVersion: 1,
      issuedAt: now,
    });
    await ctx.db.insert("auditEvents", { companyId, actorEmail, action: "platform.company_create", targetType: "company", targetId: companyId, createdAt: now });
    return { companyId, invitationId, token };
  },
});

export const createCompany = action({
  args: { name: v.string(), adminEmail: v.string() },
  handler: async (ctx, args): Promise<{ companyId: string }> => {
    await requirePlatformAdmin(ctx);
    const created = await ctx.runMutation(internal.platform.createCompanyRecord, args);
    await ctx.runAction(internal.email.sendInvitation, { companyId: created.companyId, invitationId: created.invitationId, email: args.adminEmail, role: "Admin", token: created.token });
    return { companyId: created.companyId };
  },
});

export const deleteCompany = mutation({
  args: { companyId: v.id("companies"), confirmation: v.string() },
  handler: async (ctx, args) => {
    const identity = await requirePlatformAdmin(ctx);
    const actorEmail = identity.email || identity.subject;
    const company = await ctx.db.get(args.companyId);
    if (!company) throw new ConvexError("Company not found.");
    if (args.confirmation !== company.name) throw new ConvexError("Type the company name to confirm deletion.");
    await ctx.db.patch(args.companyId, { deletedAt: Date.now() });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorEmail, action: "platform.company_delete", targetType: "company", targetId: args.companyId, metadata: { behavior: "Soft delete: child records are retained for audit and the company becomes inaccessible." }, createdAt: Date.now() });
  },
});

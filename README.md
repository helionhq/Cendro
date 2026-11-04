# Cendro

Cendro is a Notion-like internal operations workspace for company-scoped tasks, SOPs, employee/company management, analytics, and a permission-aware AI panel.

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in Clerk, Convex, Resend, Fireworks, and platform admin values.
3. Configure Clerk Google OAuth and a Clerk JWT template named `convex` with audience/application ID `convex` and the `email_verified` claim (`email_verified: {{user.email_verified}}`) so invitation acceptance can verify email status.
4. Create/connect a Convex deployment: `npx convex dev`.
5. Before deploying/generating Convex functions, configure runtime environment variables:
   - `CLERK_JWT_ISSUER_DOMAIN` is required by `convex/auth.config.ts`.
   - Set `PLATFORM_ADMIN_CLERK_USER_IDS` and `AI_CHAT_PERSISTENCE_SECRET` with identical effective values in both the Convex deployment environment and the Next.js host environment (`.env.local`): the same administrator user-ID set for `PLATFORM_ADMIN_CLERK_USER_IDS` (comma-separated Clerk user IDs, e.g. `user_2...`) and the same value for `AI_CHAT_PERSISTENCE_SECRET`.
   - Also set `RESEND_API_KEY`, `RESEND_FROM`, and `APP_URL` in Convex.
6. Run the app: `npm run dev`.

## Validation

- `npm run audit:authz`
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm audit --audit-level=high`
- `npm run convex:codegen` after Convex env vars are configured

## JD active/inactive rollout

Inactive JD tasks retain their activity, comments, attachments, completions, and missed-cycle history. The “Inactive tasks” filter replaces the active list in every non-Custom JD view without changing visibility scope. Bulk make-inactive/make-active is atomic for up to 100 selected tasks. Reactivation rejoins the current working-calendar cycle; suspended cycles are not replayed, and same-cycle completions remain completed. JD import/export sheets carry an optional “Is Active” column (Yes/No); exports always include inactive tasks, and older sheets without the column remain compatible. There is currently no task reminder sender in this repository.

### Two-phase index deployment (existing deployments)

**Do not deploy the feature revision directly to an established deployment.** Its active indexes are the second phase of rollout.

1. Deploy the schema-only preparation revision [`2d4c7ab`](https://github.com/arham-saigol/Cendro/commit/2d4c7abc2637d77ceb13772c96cd6b86516f3ed0) on branch `feat/jd-task-pause-resume-indexes` to the explicitly chosen deployment. It adds optional `pausedAt` and stages four indexes: `jdTasks.by_companyId_and_pausedAt`, `jdTasks.by_companyId_and_pausedAt_and_reference`, `jdTasks.search_active_title`, and `taskActivityLogs.by_taskType_and_taskId_and_event_and_createdAt`. It retains the old functions and old title search index; no old caller queries any staged index.
2. Wait until **all four** index backfills are complete in the Convex dashboard. Validate this phase in development/staging first; production deployment requires explicit approval.
3. Deploy this feature revision. It activates the already-backfilled indexes and enables their callers together, replacing the old JD title search index. Empty/new deployments can deploy this revision directly.
4. Run `npx convex run roles:enableJdLifecycleDefaults '{}'` against the explicitly chosen deployment **once during rollout** to upgrade existing untouched default Admin roles.

New default Admin roles include independent `tasks:jd:pause` and `tasks:jd:resume` grants; Manager and Employee defaults do not. Customized roles are left unchanged and can be granted either permission in Roles. Do not rerun the release backfill after administrators deliberately revoke both grants.

Company deletion in `/admin` is a soft delete: the company becomes inaccessible and hidden from normal company selection, while child records are retained for audit.

## Fleet rollout

Fleet adds `fleet:view`, `fleet:log`, and `fleet:manage`. New companies' default Admin and Manager roles include them. Existing deployments must run `npx convex run roles:enableFleetDefaults '{}'` once during rollout; it upgrades only untouched default Admin/Manager roles and leaves customized roles alone.

Each company connects its own TrackWorld key in Fleet settings. The key is stored per company and is never returned by a query. Tracker sync runs every 10 minutes, "Sync now" is rate-limited to once per minute, and Fleet photos use the same short-lived upload-claim pattern as task uploads.

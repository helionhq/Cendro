/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";

describe("task evidence", () => {
  test("evidence-required tasks reject completion without evidence and store submitted evidence", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");

    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Opening checklist",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      evidenceRequired: true,
    });
    await expect(employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId }))
      .rejects.toThrow("Evidence is required to complete this task.");

    await employee.mutation(api.tasks.updateJdStatus, {
      companyId: f.companyA,
      taskId: jdId,
      status: "completed",
      evidence: { text: "Checked the closing list." },
    });
    const jd = await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId: jdId });
    expect(jd.task.state.rawStatus).toBe("completed");
    const jdEvidence = await admin.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: jdId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(jdEvidence.evidenceRequired).toBe(true);
    expect(jdEvidence.page).toHaveLength(1);
    expect(jdEvidence.page[0]).toMatchObject({
      text: "Checked the closing list.",
      cycleStart: jd.task.state.currentCycleStart,
      retiredAt: null,
      createdBy: { membership: { _id: f.employee1M } },
    });

    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "File the receipt",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
      evidenceRequired: true,
    });
    await expect(admin.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeId }))
      .rejects.toThrow("Evidence is required to complete this task.");
    await admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId: oneTimeId,
      evidence: { text: "Receipt filed." },
    });
    const oneTimeEvidence = await admin.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId: oneTimeId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(oneTimeEvidence.page).toHaveLength(1);
    expect(oneTimeEvidence.page[0]).toMatchObject({ text: "Receipt filed.", cycleStart: null });
  });

  test("a different evidence submission against an already-completed task is rejected, while the recorded one retries safely", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");
    const evidenceFor = async (taskType: "jd" | "one_time", taskId: string) => (await admin.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType,
      taskId,
      paginationOpts: { numItems: 10, cursor: null },
    })).page;

    // Both members opened the completion dialog; the employee submitted first.
    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Two reviewers",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M, f.adminM],
      evidenceRequired: true,
    });
    await employee.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId: oneTimeId,
      evidence: { text: "Employee proof." },
    });
    // The admin's later dialog is told its evidence was not saved.
    await expect(admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId: oneTimeId,
      evidence: { text: "Admin proof." },
    })).rejects.toThrow("This task was already completed with different evidence.");
    // Replaying the submission that was recorded stays idempotent.
    await expect(employee.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId: oneTimeId,
      evidence: { text: "Employee proof." },
    })).resolves.toBeNull();
    // A retry must not move the completion stamp or reassign it.
    const completedAt = Date.now() - 60_000;
    await f.t.run(async (ctx) => ctx.db.patch(oneTimeId, { completedAt }));
    await admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId: oneTimeId,
      evidence: { text: "Employee proof." },
    });
    expect(await f.t.run(async (ctx) => ctx.db.get(oneTimeId))).toMatchObject({
      completedAt,
      completedByMembershipId: f.employee1M,
    });
    const oneTimeEvidence = await evidenceFor("one_time", oneTimeId);
    expect(oneTimeEvidence).toHaveLength(1);
    expect(oneTimeEvidence[0].text).toBe("Employee proof.");

    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Two reviewers",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M, f.adminM],
      evidenceRequired: true,
    });
    await employee.mutation(api.tasks.completeJd, {
      companyId: f.companyA,
      taskId: jdId,
      evidence: { text: "Employee proof." },
    });
    await expect(admin.mutation(api.tasks.completeJd, {
      companyId: f.companyA,
      taskId: jdId,
      evidence: { text: "Admin proof." },
    })).rejects.toThrow("This task was already completed with different evidence.");
    await expect(employee.mutation(api.tasks.completeJd, {
      companyId: f.companyA,
      taskId: jdId,
      evidence: { text: "Employee proof." },
    })).resolves.toBeNull();
    const jdEvidence = await evidenceFor("jd", jdId);
    expect(jdEvidence).toHaveLength(1);
    expect(jdEvidence[0].text).toBe("Employee proof.");
  });

  test("a duplicate-file replay of recorded evidence is rejected as a different submission", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Duplicate replay",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
      evidenceRequired: true,
    });
    const upload = async (fileName: string, contents: string) => {
      const { claimId } = await admin.mutation(api.tasks.generateEvidenceUploadUrl, { companyId: f.companyA, taskType: "one_time", taskId });
      const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob([contents], { type: "text/plain" })));
      await admin.mutation(api.tasks.bindEvidenceUploadClaim, { companyId: f.companyA, taskType: "one_time", taskId, claimId, storageId });
      return { storageId, fileName, claimId };
    };
    const first = await upload("first.txt", "first");
    const second = await upload("second.txt", "second");
    await admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [first, second] },
    });

    // The recorded set still replays idempotently.
    await expect(admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [first, second] },
    })).resolves.toBeNull();
    // Repeating one stored id while omitting the other is not the recorded set.
    await expect(admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [first, first] },
    })).rejects.toThrow("This task was already completed with different evidence.");
  });

  test("reopening a task deletes its evidence row and unreferenced blob", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Proof task",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
      evidenceRequired: true,
    });
    const { claimId } = await admin.mutation(api.tasks.generateEvidenceUploadUrl, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
    });
    const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["evidence"], { type: "text/plain" })));
    await admin.mutation(api.tasks.bindEvidenceUploadClaim, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      claimId,
      storageId,
    });

    await admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [{ storageId, fileName: "proof.txt", claimId }] },
    });

    const evidence = await admin.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(evidence.page[0].files).toHaveLength(1);
    expect(evidence.page[0].files[0]).toMatchObject({ fileName: "proof.txt", size: 8, contentType: expect.any(String) });
    expect(evidence.page[0].files[0]).not.toHaveProperty("storageId");
    // The claim is consumed by the completion, not by reopening.
    expect(await f.t.run(async (ctx) => ctx.db.get(claimId))).toBeNull();

    await admin.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId, status: "due" });

    const reopened = await admin.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(reopened.page).toEqual([]);
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
  });

  test("completion requires the acting member's claim to be bound to the submitted file", async () => {
    const f = await createAuthzFixture();
    // Evidence submission follows completion rights; the attachment capability
    // is neither required nor sufficient.
    await f.setRoleCapabilities(f.companyA, "Employee", ["tasks:jd:view:self", "tasks:jd:update:self"]);
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Bound upload",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      evidenceRequired: true,
    });
    const { claimId } = await employee.mutation(api.tasks.generateEvidenceUploadUrl, {
      companyId: f.companyA,
      taskType: "jd",
      taskId,
    });
    const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["proof"], { type: "text/plain" })));

    // An unbound claim cannot name a blob.
    await expect(employee.mutation(api.tasks.updateJdStatus, {
      companyId: f.companyA,
      taskId,
      status: "completed",
      evidence: { files: [{ storageId, fileName: "proof.txt", claimId }] },
    })).rejects.toThrow("Evidence upload claim is bound to a different file.");

    // The employee can bind without tasks:attachment:add.
    await employee.mutation(api.tasks.bindEvidenceUploadClaim, { companyId: f.companyA, taskType: "jd", taskId, claimId, storageId });

    // A bound claim cannot vouch for some other blob.
    const otherStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["other"], { type: "text/plain" })));
    await expect(employee.mutation(api.tasks.updateJdStatus, {
      companyId: f.companyA,
      taskId,
      status: "completed",
      evidence: { files: [{ storageId: otherStorageId, fileName: "other.txt", claimId }] },
    })).rejects.toThrow("Evidence upload claim is bound to a different file.");

    // Another member cannot spend someone else's claim.
    await expect(admin.mutation(api.tasks.completeJd, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [{ storageId, fileName: "proof.txt", claimId }] },
    })).rejects.toThrow("Evidence upload claim not found.");

    await employee.mutation(api.tasks.updateJdStatus, {
      companyId: f.companyA,
      taskId,
      status: "completed",
      evidence: { files: [{ storageId, fileName: "proof.txt", claimId }] },
    });

    // A blob task data already owns cannot become an evidence upload.
    const attachedStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["attached"], { type: "text/plain" })));
    await admin.mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "jd",
      taskId,
      storageId: attachedStorageId,
      fileName: "attached.txt",
      contentType: "text/plain",
      size: 8,
    });
    const { claimId: attachedClaimId } = await admin.mutation(api.tasks.generateEvidenceUploadUrl, {
      companyId: f.companyA,
      taskType: "jd",
      taskId,
    });
    await expect(admin.mutation(api.tasks.bindEvidenceUploadClaim, {
      companyId: f.companyA,
      taskType: "jd",
      taskId,
      claimId: attachedClaimId,
      storageId: attachedStorageId,
    })).rejects.toThrow("This file is already attached.");
  });

  test("cleanup never deletes a blob another claim or evidence row still references", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Shared blob",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
      evidenceRequired: true,
    });
    const { claimId } = await admin.mutation(api.tasks.generateEvidenceUploadUrl, { companyId: f.companyA, taskType: "one_time", taskId });
    const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["shared"], { type: "text/plain" })));
    await admin.mutation(api.tasks.bindEvidenceUploadClaim, { companyId: f.companyA, taskType: "one_time", taskId, claimId, storageId });
    await admin.mutation(api.tasks.completeOneTime, {
      companyId: f.companyA,
      taskId,
      evidence: { files: [{ storageId, fileName: "shared.txt", claimId }] },
    });

    // A stale bound claim naming an evidence blob must not let cleanup delete it.
    const staleClaimId = await f.t.run(async (ctx) => ctx.db.insert("taskUploadClaims", {
      companyId: f.companyA,
      membershipId: f.adminM,
      storageId,
      createdAt: Date.now(),
    }));
    await admin.mutation(api.tasks.discardEvidenceUpload, { companyId: f.companyA, claimId: staleClaimId });
    expect(await f.t.run(async (ctx) => ctx.db.get(staleClaimId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();

    // Legacy duplicate evidence rows must not delete a blob the other still shows.
    await f.t.run(async (ctx) => {
      const duplicateId = await ctx.db.insert("taskEvidence", {
        companyId: f.companyA,
        taskType: "one_time",
        taskId: "legacy-task",
        files: [{ storageId, fileName: "shared.txt", contentType: "text/plain", size: 6 }],
        createdByMembershipId: f.adminM,
        createdAt: Date.now(),
      });
      await ctx.db.insert("taskEvidenceBlobs", { evidenceId: duplicateId, storageId });
    });

    await admin.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId, status: "due" });

    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
  });

  test("reaffirming Completed succeeds after the evidence flag is enabled", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Already done",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    await admin.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId });
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId: jdId, evidenceRequired: true });
    await expect(admin.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId })).resolves.toBeNull();

    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Already done",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
    });
    await admin.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeId });
    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId: oneTimeId, evidenceRequired: true });
    await expect(admin.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId: oneTimeId, status: "completed" })).resolves.toBeNull();
  });
});

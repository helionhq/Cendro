import { describe, expect, it } from "vitest";
import {
  capabilities,
  defaultRoleCapabilities,
  isKnownCapability,
  legacyRoleCapabilities,
  getHighestScope,
  type Capability,
} from "./permissions";

describe("permissions catalog and defaults", () => {
  it("defines explicit defaults for Admin containing all capabilities", () => {
    const adminCaps = new Set(defaultRoleCapabilities.Admin);
    expect(adminCaps.size).toBe(capabilities.length);
    for (const cap of capabilities) {
      expect(adminCaps.has(cap)).toBe(true);
    }
  });

  it("defines explicit independent defaults for Manager", () => {
    // Independent expected set (do not derive from implementation)
    const expectedManagerCaps = new Set<Capability>([
      "analytics:view:managed_scope",
      "analytics:view:self",
      "tasks:jd:view:managed",
      "tasks:jd:view:self",
      "tasks:jd:create",
      "tasks:jd:assign:managed",
      "tasks:jd:assign:self",
      "tasks:jd:update:managed",
      "tasks:jd:update:self",
      "tasks:jd:delete:managed",
      "tasks:jd:delete:self",
      "tasks:jd:import",
      "tasks:jd:export",
      "tasks:one_time:view:managed",
      "tasks:one_time:view:self",
      "tasks:one_time:create",
      "tasks:one_time:assign:managed",
      "tasks:one_time:assign:self",
      "tasks:one_time:update:managed",
      "tasks:one_time:update:self",
      "tasks:one_time:delete:managed",
      "tasks:one_time:delete:self",
      "tasks:one_time:import",
      "tasks:one_time:export",
      "tasks:confirm",
      "tasks:comment",
      "tasks:attachment:add",
      "tasks:attachment:delete:own",
      "tasks:attachment:delete:any",
      "sops:view:managed",
      "sops:view:self",
      "sops:create",
      "sops:manage:branch",
      "sops:manage:department",
      "sops:delete:branch",
      "sops:delete:department",
      "ai:use",
    ]);

    const actual = new Set(defaultRoleCapabilities.Manager);
    expect(actual).toEqual(expectedManagerCaps);
  });

  it("defines explicit independent defaults for Employee", () => {
    const expectedEmployeeCaps = new Set<Capability>([
      "analytics:view:self",
      "tasks:jd:view:self",
      "tasks:jd:update:self",
      "tasks:one_time:view:self",
      "tasks:one_time:update:self",
      "tasks:comment",
      "tasks:attachment:add",
      "sops:view:self",
      "ai:use",
    ]);

    const actual = new Set(defaultRoleCapabilities.Employee);
    expect(actual).toEqual(expectedEmployeeCaps);
    expect(actual.has("tasks:attachment:delete:own")).toBe(false);
    expect(actual.has("tasks:attachment:delete:any")).toBe(false);
  });
});

describe("legacyRoleCapabilities", () => {
  it("preserves the built-in defaults for legacy role names", () => {
    expect(new Set(legacyRoleCapabilities("Admin"))).toEqual(new Set(defaultRoleCapabilities.Admin));
    expect(new Set(legacyRoleCapabilities("Manager"))).toEqual(new Set(defaultRoleCapabilities.Manager));
    expect(new Set(legacyRoleCapabilities("Employee"))).toEqual(new Set(defaultRoleCapabilities.Employee));
  });

  it("grants nothing for unknown role names", () => {
    expect(legacyRoleCapabilities("Superadmin")).toEqual([]);
    expect(legacyRoleCapabilities("")).toEqual([]);
  });
});

describe("isKnownCapability", () => {
  it("accepts catalog capabilities and rejects arbitrary strings", () => {
    expect(isKnownCapability("company:manage_roles")).toBe(true);
    expect(isKnownCapability("unknown:super:admin")).toBe(false);
    expect(isKnownCapability("arbitrary_garbage")).toBe(false);
  });
});

describe("scope precedence helper", () => {
  it("determines highest scope correctly in any > managed > self order", () => {
    expect(getHighestScope(["any", "managed", "self"])).toBe("any");
    expect(getHighestScope(["company", "managed"])).toBe("company");
    expect(getHighestScope(["managed", "self"])).toBe("managed");
    expect(getHighestScope(["self"])).toBe("self");
    expect(getHighestScope([])).toBe(null);
  });
});

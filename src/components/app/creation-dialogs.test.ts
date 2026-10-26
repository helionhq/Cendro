import { afterEach, expect, test, vi } from "vitest";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { createMockElement } from "./test-dom";
import { TaskDeadlineProvider, TaskList } from "./task-pages";
import { SopList } from "./sop-pages";

const active = vi.hoisted(() => ({
  membership: { _id: "member" },
  company: { name: "Company" },
  capabilities: ["tasks:jd:create", "tasks:one_time:create", "tasks:attachment:add", "sops:create", ...["company", "branch", "department", "user"].map((scope) => `sops:manage:${scope}`)],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./company-context", () => ({ useCompany: () => ({ activeCompanyId: "company", active }) }));
vi.mock("convex/react", () => {
  const preference = { sort: { mode: "default" }, customOrder: null, revision: 0 };
  const assignees = { users: [], isTruncated: false };
  const scopes = { branches: [], departments: [], users: [] };
  const empty: never[] = [];
  const page = { status: "Exhausted", loadMore: vi.fn(), results: empty };
  const mutate = vi.fn();
  Object.assign(mutate, { withOptimisticUpdate: () => mutate });
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
      switch (getFunctionName(ref)) {
        case "tasks:getListPreference":
        case "sops:getListPreference": return preference;
        case "tasks:assignableUsers": return assignees;
        case "sops:scopeOptions": return scopes;
        default: return empty;
      }
    },
    useQuery_experimental: () => ({ status: "success", data: undefined }),
    usePaginatedQuery: () => page,
    useMutation: () => mutate,
  };
});
// Only replace third-party portal/geometry behavior; render the actual forms.
vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  Portal: ({ children }: { children: ReactNode }) => children,
  Overlay: () => null,
  Content: ({ children }: { children: ReactNode }) => React.createElement("div", { role: "dialog" }, children),
  Title: ({ children }: { children: ReactNode }) => React.createElement("h2", null, children),
  Description: ({ children }: { children: ReactNode }) => React.createElement("p", null, children),
  Close: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@radix-ui/react-dropdown-menu", () => {
  const childrenOnly = ({ children }: { children: ReactNode }) => children;
  return {
    Root: childrenOnly, Trigger: childrenOnly, Portal: childrenOnly, Content: childrenOnly,
    Sub: childrenOnly, SubTrigger: childrenOnly, SubContent: childrenOnly, Separator: () => null,
    CheckboxItem: childrenOnly,
    Item: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => React.createElement("button", { onClick: onSelect }, children),
  };
});
vi.mock("./list-dnd", () => ({
  useListDrag: () => ({ active: false }),
  ListDragOverlay: () => null, ListDragRailRow: () => null, ListSortableRow: () => null,
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/use-is-coarse-pointer", () => ({ useIsCoarsePointer: () => false }));

let root: Root | undefined;
let container: ReturnType<typeof createMockElement>;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });

// Query rendered labels/buttons and dispatch clicks through the shared DOM host.
function nodes(node: any): any[] { return [node, ...(node.children ?? []).flatMap(nodes)]; }
function text(node: any): string { return node.nodeValue ?? node.textContent ?? (node.children ?? []).map(text).join(""); }
async function click(label: string) {
  const button = nodes(container).find((node) => node.tagName === "BUTTON" && text(node) === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
}
async function mount(element: ReactNode, button: string) {
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(element));
  await click(button);
}
function dialog() { return nodes(container).find((node) => node.getAttribute?.("role") === "dialog"); }
function requiredLabels(): string[] {
  return nodes(dialog()).filter((node) =>
    (node.tagName === "LABEL" || node.tagName === "SPAN") &&
    node.children?.some((child: any) => child.getAttribute?.("aria-hidden") === "true" && text(child) === "*")
  ).map((node) => text(node).replace("* (required)", ""));
}
function expectAccessibleIndicators(title: string) {
  const all = nodes(dialog());
  for (const star of all.filter((node) => node.getAttribute?.("aria-hidden") === "true" && text(node) === "*")) {
    expect(star.getAttribute("class")).toContain("text-[var(--danger)]");
    expect(star.parentNode.children.some((node: any) => node.getAttribute?.("class") === "sr-only" && text(node) === " (required)")).toBe(true);
  }
  const input = all.find((node) => node.getAttribute?.("aria-label") === title);
  expect(input.getAttribute("aria-required")).toBe("true");
  expect(all.find((node) => node.tagName === "LABEL").getAttribute("for")).toBe(input.getAttribute("id"));
}

test("the shared DOM host stops bubbling cancelled dialog clicks", () => {
  const parent = createMockElement();
  const button = createMockElement("button");
  parent.appendChild(button);
  const onParentClick = vi.fn();
  parent.addEventListener("click", onParentClick);
  button.addEventListener("click", (event: Event) => event.stopPropagation());
  button.dispatchEvent(new Event("click", { bubbles: true }));
  expect(onParentClick).not.toHaveBeenCalled();
});

test.each(["jd", "one"] as const)("%s task creation marks only fields required by its mutation", async (kind) => {
  const list = React.createElement(TaskList, { kind });
  await mount(kind === "one" ? React.createElement(TaskDeadlineProvider, null, list) : list, "New task");
  expect(requiredLabels()).toEqual(["Title", "Assigned To", kind === "jd" ? "Frequency" : "Priority"]);
  expectAccessibleIndicators("Task title");
  const evidenceToggle = nodes(dialog()).find((node) => node.getAttribute?.("role") === "switch" && node.getAttribute?.("aria-label") === "Require evidence to complete");
  expect(evidenceToggle?.getAttribute("aria-checked")).toBe("false");
  expect(text(evidenceToggle)).toBe("Require evidence to complete");
  const labels = nodes(dialog()).map((node) => node.getAttribute?.("aria-label"));
  expect(labels).toContain("Assigned To (required): Select assignee");
  expect(labels).toContain(kind === "jd" ? "Frequency (required): Daily" : "Priority (required): Medium");
});

test("SOP creation requires assignment only for non-company scopes and leaves body optional", async () => {
  await mount(React.createElement(SopList), "New SOP");
  expect(requiredLabels()).toEqual(["Title", "Type"]);
  expectAccessibleIndicators("SOP title");
  for (const scope of ["Branch", "Department", "User"]) {
    await click(scope);
    expect(requiredLabels()).toEqual(["Title", "Type", "Assigned to"]);
    expect(nodes(dialog()).some((node) => node.getAttribute?.("aria-label")?.startsWith(`Assign SOP to ${scope.toLowerCase()} (required):`))).toBe(true);
  }
  await click("Company");
  expect(requiredLabels()).toEqual(["Title", "Type"]);
});

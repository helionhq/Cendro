import type { Id } from "../../../../../../convex/_generated/dataModel";
import { EmployeeDashboardPage } from "@/components/app/dashboard-pages";
import { parseEmployeeSearchParams } from "@/components/app/dashboard-format";

export default async function EmployeeDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ membershipId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { membershipId } = await params;
  return (
    <EmployeeDashboardPage
      membershipId={membershipId as Id<"companyMemberships">}
      initial={parseEmployeeSearchParams(await searchParams)}
    />
  );
}

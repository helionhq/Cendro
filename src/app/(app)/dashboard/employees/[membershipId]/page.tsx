import type { Id } from "../../../../../../convex/_generated/dataModel";
import { Suspense } from "react";
import { DashboardSkeleton, EmployeeDashboardPage } from "@/components/app/dashboard-pages";

export default async function EmployeeDashboard({ params }: { params: Promise<{ membershipId: string }> }) {
  const { membershipId } = await params;
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <EmployeeDashboardPage membershipId={membershipId as Id<"companyMemberships">} />
    </Suspense>
  );
}

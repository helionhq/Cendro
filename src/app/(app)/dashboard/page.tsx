import { Suspense } from "react";
import { DashboardPage, DashboardSkeleton } from "@/components/app/dashboard-pages";

export default function Dashboard() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardPage />
    </Suspense>
  );
}

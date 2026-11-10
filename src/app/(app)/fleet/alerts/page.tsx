import { Suspense } from "react";
import { AlertsPage } from "@/components/app/fleet-alerts";
import { FleetPageSkeleton } from "@/components/app/fleet-shell";

export default function Page() {
  return (
    <Suspense fallback={<FleetPageSkeleton />}>
      <AlertsPage />
    </Suspense>
  );
}

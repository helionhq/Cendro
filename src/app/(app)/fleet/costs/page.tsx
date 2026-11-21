import { Suspense } from "react";
import { CostsPage } from "@/components/app/fleet-costs";
import { FleetPageSkeleton } from "@/components/app/fleet-shell";

export default function Page() {
  return (
    <Suspense fallback={<FleetPageSkeleton />}>
      <CostsPage />
    </Suspense>
  );
}

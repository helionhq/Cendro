import { Suspense } from "react";
import { FleetPageSkeleton } from "@/components/app/fleet-shell";
import { TripsPage } from "@/components/app/fleet-trips";

export default function Page() {
  return (
    <Suspense fallback={<FleetPageSkeleton />}>
      <TripsPage />
    </Suspense>
  );
}

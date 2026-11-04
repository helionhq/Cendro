"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { DetailDrawerLayout } from "@/components/app/detail-drawer-layout";
import { FleetList, type FleetTab } from "@/components/app/fleet-pages";

export default function FleetLayout({ children }: { children: React.ReactNode }) {
  const vehicleId = useParams<{ id?: string }>()?.id;
  // Held here, above the list/detail switch, so opening a vehicle on a phone
  // (which unmounts the list) does not lose the tab the user was on.
  const [tab, setTab] = useState<FleetTab>("vehicles");
  return (
    <DetailDrawerLayout
      base="/fleet"
      detailId={vehicleId}
      drawerKey="fleet-vehicle-drawer"
      label="vehicle"
      list={
        <FleetList
          selectedVehicleId={vehicleId}
          tab={tab}
          onTabChange={setTab}
        />
      }
    >
      {children}
    </DetailDrawerLayout>
  );
}

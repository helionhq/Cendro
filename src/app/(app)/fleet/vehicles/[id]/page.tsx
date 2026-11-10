import { VehiclePage } from "@/components/app/fleet-vehicle";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VehiclePage id={id} />;
}

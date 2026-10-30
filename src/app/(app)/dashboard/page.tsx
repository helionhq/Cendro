import { DashboardPage } from "@/components/app/dashboard-pages";
import { parseDashboardSearchParams } from "@/components/app/dashboard-format";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <DashboardPage initial={parseDashboardSearchParams(await searchParams)} />;
}

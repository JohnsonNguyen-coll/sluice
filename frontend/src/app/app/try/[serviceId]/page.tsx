import { TryApi } from "@/web/components/try-api";

export const metadata = { title: "Try API · Sluice" };

export default async function Page({ params }: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await params;
  return <TryApi serviceId={serviceId} />;
}

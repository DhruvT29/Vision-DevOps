import { InsightsView } from '@/components/InsightsView';

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <InsightsView snapshotId={snapshotId} />;
}

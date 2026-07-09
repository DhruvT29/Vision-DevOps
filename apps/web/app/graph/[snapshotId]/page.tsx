import { GraphView } from '@/components/GraphView';

export default async function GraphPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <GraphView snapshotId={snapshotId} />;
}

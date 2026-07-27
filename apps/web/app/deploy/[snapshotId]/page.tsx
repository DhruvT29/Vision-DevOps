import { DeployView } from '@/components/DeployView';

export default async function DeployPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <DeployView snapshotId={snapshotId} />;
}

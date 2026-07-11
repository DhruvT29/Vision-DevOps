import { DependencyView } from '@/components/DependencyView';

export default async function DependenciesPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <DependencyView snapshotId={snapshotId} />;
}

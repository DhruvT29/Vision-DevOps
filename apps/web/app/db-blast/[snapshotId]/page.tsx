import { DbBlastView } from '@/components/DbBlastView';

export default async function DbBlastPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <DbBlastView snapshotId={snapshotId} />;
}

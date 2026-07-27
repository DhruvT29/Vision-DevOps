import { DbSchemaView } from '@/components/DbSchemaView';

export default async function DbSchemaPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <DbSchemaView snapshotId={snapshotId} />;
}

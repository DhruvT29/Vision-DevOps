import { ProjectHome } from '@/components/ProjectHome';

export default async function ProjectHomePage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const { snapshotId } = await params;
  return <ProjectHome snapshotId={snapshotId} />;
}

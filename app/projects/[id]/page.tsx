import { redirect, notFound } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getProject, getIterations } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import WorkspaceView from '@/components/WorkspaceView';

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const project = await getProject(id);
  if (!project) notFound();

  const iterations = await getIterations(id);

  return (
    <AppShell activeProjectId={id} viewingProjectName={project.name}>
      <WorkspaceView project={project} iterations={iterations} />
    </AppShell>
  );
}

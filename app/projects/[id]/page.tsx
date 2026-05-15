import { redirect, notFound } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getProject, getIterations, getTrainingRuns } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import WorkspaceView from '@/components/WorkspaceView';

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const project = await getProject(id);
  if (!project) notFound();
  // Archived projects don't render their workspace — they live as
  // history accessible from the archive view, not the active sidebar.
  if (project.is_archived === 1) redirect('/');

  const [iterations, trainingRuns] = await Promise.all([
    getIterations(id),
    getTrainingRuns(id),
  ]);

  return (
    <AppShell activeProjectId={id} viewingProjectName={project.name}>
      <WorkspaceView
        project={project}
        iterations={iterations}
        trainingRuns={trainingRuns}
      />
    </AppShell>
  );
}

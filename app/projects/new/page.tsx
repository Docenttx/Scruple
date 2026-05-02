import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';
import NewProjectForm from './NewProjectForm';

export default async function NewProjectPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <AppShell>
      <div className="mx-auto mt-12 max-w-md px-8">
        <h2 className="text-xl font-light">New project</h2>
        <p className="mt-1 text-xs text-scruple-muted">
          A project groups iterations into a single Merkle chain.
        </p>
        <div className="mt-8">
          <NewProjectForm />
        </div>
      </div>
    </AppShell>
  );
}

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <AppShell>
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h2 className="text-xl font-light">No project selected</h2>
          <p className="mt-2 text-sm text-scruple-muted">
            Select a project from the sidebar, or create a new one to start
            capturing iterations.
          </p>
        </div>
      </div>
    </AppShell>
  );
}

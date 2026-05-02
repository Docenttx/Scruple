import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import AppShell from '@/components/AppShell';

export default async function HomePage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string };
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const search = searchParams?.q;
  const page = searchParams?.page ? Math.max(0, Number(searchParams.page)) : 0;

  return (
    <AppShell search={search} page={page}>
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

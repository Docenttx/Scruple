import Link from 'next/link';
import clsx from 'clsx';
import { LOCK_STATE_LABELS, type ProjectRow } from '@/lib/types';
import ProjectRowActions from './ProjectRowActions';

export default function SidebarList({
  projects,
  activeId,
  page,
  hasMore,
  total,
  search,
}: {
  projects: ProjectRow[];
  activeId?: number;
  page: number;
  hasMore: boolean;
  total: number;
  search: string;
}) {
  return (
    <div className="flex-1 overflow-auto">
      {projects.length === 0 ? (
        <p className="p-4 text-xs text-scruple-muted">
          {search
            ? `No projects match "${search}".`
            : 'No projects yet. Click + New to create one.'}
        </p>
      ) : (
        <ul className="divide-y divide-scruple-border">
          {projects.map((p) => (
            <li
              key={p.id}
              className={clsx(
                'group relative px-4 py-2 transition hover:bg-scruple-bg',
                activeId === p.id && 'bg-scruple-bg',
              )}
            >
              <Link href={`/projects/${p.id}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="truncate text-sm">{p.name}</span>
                  {p.is_active === 1 && (
                    <span
                      className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-scruple-success"
                      title="Tracking"
                    />
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-scruple-muted">
                  <StatusBadge status={p.status} />
                  <span>·</span>
                  <span>{p.iteration_count} iter</span>
                  {p.scr_id && (
                    <>
                      <span>·</span>
                      <span className="font-mono">{p.scr_id}</span>
                    </>
                  )}
                </div>
              </Link>
              <div className="absolute right-2 top-1 hidden group-hover:block">
                <ProjectRowActions projectId={p.id} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {(hasMore || page > 0) && (
        <div className="flex items-center justify-between border-t border-scruple-border px-4 py-2 text-[10px] text-scruple-muted">
          <span>
            {page * 50 + 1}–{page * 50 + projects.length} of {total}
          </span>
          <div className="flex gap-1">
            {page > 0 && (
              <PageLink page={page - 1} search={search}>
                ← prev
              </PageLink>
            )}
            {hasMore && (
              <PageLink page={page + 1} search={search}>
                next →
              </PageLink>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PageLink({ page, search, children }: { page: number; search: string; children: React.ReactNode }) {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (page > 0) params.set('page', String(page));
  return (
    <Link
      href={`/?${params.toString()}`}
      className="rounded border border-scruple-border bg-scruple-bg px-1.5 py-0.5 hover:border-scruple-accent"
    >
      {children}
    </Link>
  );
}

function StatusBadge({ status }: { status: keyof typeof LOCK_STATE_LABELS }) {
  const tone = clsx(
    'rounded px-1 py-0.5 text-[9px]',
    status === 'unlocked' && 'border border-scruple-border text-scruple-muted',
    status === 'checkpointed' && 'border border-scruple-warn/40 text-scruple-warn',
    status === 'local_locked' && 'border border-scruple-success/40 text-scruple-success',
    status === 'chain_locked' && 'border border-scruple-accent/40 text-scruple-accent',
    (status === 'persistent_locked' || status === 'permanent_locked') &&
      'border border-scruple-accent text-scruple-accent',
  );
  return <span className={tone}>{LOCK_STATE_LABELS[status]}</span>;
}

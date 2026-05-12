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
        // Desktop catalog §3 "Project List Rows":
        // .project-item — 12px padding, bg tertiary, border 1px, 8px
        // radius, cursor pointer, hover: accent-primary border.
        // .project-item.selected — left border 2px accent + name color
        // accent. .project-item.active — accent border + bg tint.
        <ul className="flex flex-col gap-1 px-2 py-2">
          {projects.map((p) => (
            <li
              key={p.id}
              className={clsx(
                'group relative rounded-lg border bg-scruple-bg-tertiary transition-colors duration-fast',
                activeId === p.id
                  // Selected: left accent stripe + name turns cyan
                  ? 'border-scruple-accent-primary/40 bg-scruple-accent-primary/10'
                  : 'border-scruple-border-color hover:border-scruple-accent-primary',
              )}
            >
              <Link
                href={`/projects/${p.id}`}
                className="flex flex-col gap-1 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      'truncate text-sm font-medium',
                      activeId === p.id ? 'text-scruple-accent-primary' : 'text-scruple-text-primary',
                    )}
                  >
                    {p.name}
                  </span>
                  {p.is_active === 1 && (
                    <span
                      className="ml-2 inline-block h-2 w-2 shrink-0 rounded-full bg-scruple-danger"
                      style={{ boxShadow: '0 0 6px currentColor' }}
                      title="Tracking"
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-2xs text-scruple-text-deep-muted">
                  <StatusBadge status={p.status} />
                  <span>·</span>
                  <span>{p.iteration_count} iter</span>
                  {p.scr_id && (
                    <>
                      <span>·</span>
                      <span className="font-mono text-scruple-accent-primary">{p.scr_id}</span>
                    </>
                  )}
                </div>
              </Link>
              <div className="absolute right-2 top-2 hidden group-hover:block">
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

import Link from 'next/link';
import clsx from 'clsx';
import { LOCK_STATE_LABELS, type ProjectRow } from '@/lib/types';
import ProjectRowActions from './ProjectRowActions';
import SidebarTrackingButton from './SidebarTrackingButton';

// Status dot colors — match desktop render-main.js statusColors:
//   unlocked            → #4caf50 (green)
//   local_locked        → #ff9800 (orange)
//   chain_locked        → #2196f3 (blue)
//   persistent_locked   → #9c27b0 (purple)
//   permanent_locked    → #9c27b0 (purple)
//   checkpointed        → web addition (yellow)
function statusDotColor(status: ProjectRow['status']): string {
  switch (status) {
    case 'unlocked':           return '#4caf50';
    case 'checkpointed':       return '#ffc107';
    case 'local_locked':       return '#ff9800';
    case 'chain_locked':       return '#2196f3';
    case 'persistent_locked':
    case 'permanent_locked':   return '#9c27b0';
    default:                   return '#4caf50';
  }
}

// Type prefix per desktop convention. Note: 'cad' (Fusion) has no desktop
// convention yet — falls through to a generic bracket to stay non-empty.
function typePrefix(type: ProjectRow['type']): string {
  switch (type) {
    case 'training': return '[T]';
    case 'video':    return '[V]';
    case 'image':    return '[I]';
    case 'cad':      return '[C]';
    default:         return '[·]';
  }
}

function countAndLabel(p: ProjectRow): string {
  if (p.type === 'training') return '— runs'; // training count not on ProjectRow yet
  if (p.type === 'video')    return `${p.iteration_count} clips`;
  return `${p.iteration_count} iterations`;
}

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
    <div className="flex-1 overflow-hidden">
      {projects.length === 0 ? (
        <p className="p-4 text-xs text-scruple-muted">
          {search
            ? `No projects match "${search}".`
            : 'No projects yet. Click + New to create one.'}
        </p>
      ) : (
        // Fusion palette pattern: fixed 6-row visible height + inline
        // scroll for the rest. Keeps the whole sidebar chrome (brand,
        // banner, status, search) fixed above the list.
        // ~62px per row × 6 = ~372px.
        <ul className="flex max-h-[380px] flex-col gap-2 overflow-y-auto px-2 py-2">
          {projects.map((p) => {
            const isSelected = activeId === p.id;
            const isTracking = p.is_active === 1;
            return (
              <li
                key={p.id}
                className={clsx(
                  'rounded-lg border bg-scruple-bg-tertiary transition-colors duration-fast',
                  isSelected
                    ? 'border-scruple-accent-primary'
                    : isTracking
                      ? 'border-scruple-success/40'
                      : 'border-scruple-border-color hover:border-scruple-accent-primary/60',
                )}
              >
                {/* .project-main — clickable name/meta block */}
                <Link
                  href={`/projects/${p.id}`}
                  className="block px-3 pt-2 pb-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={clsx(
                        'truncate text-sm font-medium',
                        isSelected ? 'text-scruple-accent-primary' : 'text-scruple-text-primary',
                      )}
                    >
                      <span className="mr-1 font-mono text-2xs text-scruple-text-deep-muted">
                        {typePrefix(p.type)}
                      </span>
                      {p.name}
                    </span>
                    {/* Status dot — solid colored circle per desktop */}
                    <span
                      className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: statusDotColor(p.status),
                        boxShadow: isTracking ? `0 0 6px ${statusDotColor(p.status)}` : undefined,
                      }}
                      title={LOCK_STATE_LABELS[p.status]}
                    />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-scruple-text-deep-muted">
                    <span>{countAndLabel(p)}</span>
                    {p.scr_id && (
                      <>
                        <span>·</span>
                        <span className="font-mono text-scruple-accent-primary">{p.scr_id}</span>
                      </>
                    )}
                  </div>
                </Link>

                {/* .project-footer — Archive + Start/Stop Tracking */}
                <div className="flex items-center justify-between border-t border-scruple-border-color/50 px-3 py-1.5">
                  <ProjectRowActions projectId={p.id} />
                  <SidebarTrackingButton projectId={p.id} isActive={isTracking} />
                </div>
              </li>
            );
          })}
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

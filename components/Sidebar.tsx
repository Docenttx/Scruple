import Link from 'next/link';
import {
  getProjects,
  countProjects,
  getActiveProject,
  getIterations,
} from '@/lib/projects/actions';
import SidebarSearch from './SidebarSearch';
import SidebarList from './SidebarList';
import ActiveProjectBanner from './ActiveProjectBanner';
import StatusPills from './StatusPills';
import ProvenanceTerminal from './ProvenanceTerminal';

export default async function Sidebar({
  activeId,
  search = '',
  page = 0,
}: {
  activeId?: number;
  search?: string;
  page?: number;
}) {
  const PAGE = 50;
  const offset = page * PAGE;

  const [projects, total, active] = await Promise.all([
    getProjects({ search, limit: PAGE + 1, offset }),
    countProjects({ search }),
    getActiveProject(),
  ]);
  const hasMore = projects.length > PAGE;
  const visible = hasMore ? projects.slice(0, PAGE) : projects;

  // Most-recent 4 iterations for the banner thumbnail strip.
  const recentIterations = active
    ? (await getIterations(active.id)).slice(-4).reverse()
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* .sidebar-header — desktop main.css §117: 16px padding + bottom
          border. Logo cyan + bold + 2px tracking. */}
      <div className="flex items-end justify-between border-b border-scruple-border-color px-4 py-3">
        <Link href="/" className="flex flex-col">
          <span className="text-[20px] font-bold leading-none tracking-widest2 text-scruple-accent-primary">
            SCRUPLE
          </span>
          <span className="mt-1 text-[11px] text-scruple-text-deep-muted">
            Studio Web
          </span>
        </Link>
      </div>
      <StatusPills />
      {active && (
        <ActiveProjectBanner project={active} recentIterations={recentIterations} />
      )}
      {active && <ProvenanceTerminal />}
      <SidebarSearch initial={search} />
      <SidebarList
        projects={visible}
        activeId={activeId}
        page={page}
        hasMore={hasMore}
        total={total}
        search={search}
      />
    </div>
  );
}

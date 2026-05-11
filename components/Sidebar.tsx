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
      <StatusPills />
      {active && (
        <ActiveProjectBanner project={active} recentIterations={recentIterations} />
      )}
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

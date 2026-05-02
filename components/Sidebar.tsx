import { getProjects, countProjects } from '@/lib/projects/actions';
import SidebarSearch from './SidebarSearch';
import SidebarList from './SidebarList';

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
  const [projects, total] = await Promise.all([
    getProjects({ search, limit: PAGE + 1, offset }),
    countProjects({ search }),
  ]);
  const hasMore = projects.length > PAGE;
  const visible = hasMore ? projects.slice(0, PAGE) : projects;

  return (
    <div className="flex h-full flex-col">
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

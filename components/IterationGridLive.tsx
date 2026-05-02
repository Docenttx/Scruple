'use client';

// Wraps IterationGrid with an SSE subscription so newly-captured
// iterations appear without a page refresh. Only subscribes when the
// project is active.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { IterationRow } from '@/lib/types';
import IterationGrid from './IterationGrid';

export default function IterationGridLive({
  initial,
  projectId,
  isActive,
}: {
  initial: IterationRow[];
  projectId: number;
  isActive: boolean;
}) {
  const router = useRouter();
  const [iterations, setIterations] = useState<IterationRow[]>(initial);

  useEffect(() => {
    setIterations(initial);
  }, [initial]);

  useEffect(() => {
    if (!isActive) return;
    const es = new EventSource(`/api/iterations/stream?projectId=${projectId}`);
    es.addEventListener('iter', (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as IterationRow;
      setIterations((curr) => {
        // De-dup by id
        if (curr.some((c) => c.id === row.id)) return curr;
        return [...curr, row].sort((a, b) => a.run_sequence - b.run_sequence);
      });
      // Refresh server-rendered project header (iteration_count)
      router.refresh();
    });
    es.addEventListener('error', () => {
      // EventSource auto-reconnects; nothing to do
    });
    return () => es.close();
  }, [isActive, projectId, router]);

  return <IterationGrid iterations={iterations} />;
}

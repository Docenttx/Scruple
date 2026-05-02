'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { auth } from '@/lib/auth/auth';
import type { ProjectRow, ProjectType, IterationRow, MerkleNodeRow } from '@/lib/types';

async function userId(): Promise<string> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) throw new Error('Unauthorized');
  return id;
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getProjects(opts?: {
  includeArchived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ProjectRow[]> {
  const uid = await userId();
  const where = opts?.includeArchived ? '' : ' AND is_archived = 0';
  const search = opts?.search?.trim() ?? '';
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
  const offset = Math.max(0, opts?.offset ?? 0);

  if (search) {
    return conn()
      .prepare(
        `SELECT * FROM projects WHERE user_id = ?${where} AND name LIKE ?
         ORDER BY is_active DESC, updated_at DESC, created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(uid, `%${search}%`, limit, offset) as ProjectRow[];
  }
  return conn()
    .prepare(
      `SELECT * FROM projects WHERE user_id = ?${where}
       ORDER BY is_active DESC, updated_at DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(uid, limit, offset) as ProjectRow[];
}

export async function countProjects(opts?: { includeArchived?: boolean; search?: string }): Promise<number> {
  const uid = await userId();
  const where = opts?.includeArchived ? '' : ' AND is_archived = 0';
  const search = opts?.search?.trim() ?? '';
  if (search) {
    const r = conn()
      .prepare(`SELECT COUNT(*) AS n FROM projects WHERE user_id = ?${where} AND name LIKE ?`)
      .get(uid, `%${search}%`) as { n: number };
    return r.n;
  }
  const r = conn()
    .prepare(`SELECT COUNT(*) AS n FROM projects WHERE user_id = ?${where}`)
    .get(uid) as { n: number };
  return r.n;
}

export async function getProject(id: number): Promise<ProjectRow | null> {
  const uid = await userId();
  const row = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(id, uid) as ProjectRow | undefined;
  return row ?? null;
}

export async function getActiveProject(): Promise<ProjectRow | null> {
  const uid = await userId();
  const row = conn()
    .prepare(`SELECT * FROM projects WHERE user_id = ? AND is_active = 1 LIMIT 1`)
    .get(uid) as ProjectRow | undefined;
  return row ?? null;
}

export async function getIterations(projectId: number): Promise<IterationRow[]> {
  const uid = await userId();
  // Verify ownership in one shot
  const project = conn()
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, uid);
  if (!project) return [];
  return conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(projectId) as IterationRow[];
}

export async function getMerkleNodes(projectId: number): Promise<MerkleNodeRow[]> {
  const uid = await userId();
  const project = conn()
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, uid);
  if (!project) return [];
  return conn()
    .prepare(`SELECT * FROM merkle_nodes WHERE project_id = ? ORDER BY level ASC, position ASC`)
    .all(projectId) as MerkleNodeRow[];
}

// ── Writes ─────────────────────────────────────────────────────────────────

const NewProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['txt2img', 'training']),
});

export async function createProject(input: { name: string; type: ProjectType }): Promise<ProjectRow> {
  const uid = await userId();
  const parsed = NewProjectSchema.parse(input);

  const now = new Date().toISOString();
  const result = conn()
    .prepare(
      `INSERT INTO projects (user_id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(uid, parsed.name, parsed.type, now, now);

  const row = conn()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(result.lastInsertRowid) as ProjectRow;
  revalidatePath('/');
  return row;
}

export async function archiveProject(id: number): Promise<void> {
  const uid = await userId();
  const tx = conn().transaction(() => {
    // Cannot archive the active project — deactivate first
    conn().prepare(`UPDATE projects SET is_active = 0 WHERE id = ? AND user_id = ?`).run(id, uid);
    conn().prepare(`UPDATE projects SET is_archived = 1, updated_at = ? WHERE id = ? AND user_id = ?`).run(
      new Date().toISOString(),
      id,
      uid,
    );
  });
  tx();
  revalidatePath('/');
}

export async function unarchiveProject(id: number): Promise<void> {
  const uid = await userId();
  conn()
    .prepare(`UPDATE projects SET is_archived = 0, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(new Date().toISOString(), id, uid);
  revalidatePath('/');
}

export async function activateProject(id: number): Promise<void> {
  const uid = await userId();
  const tx = conn().transaction(() => {
    // Server-enforced single-active
    conn().prepare(`UPDATE projects SET is_active = 0 WHERE user_id = ?`).run(uid);
    conn()
      .prepare(`UPDATE projects SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(new Date().toISOString(), id, uid);
  });
  tx();
  revalidatePath('/');
}

export async function deactivateProject(): Promise<void> {
  const uid = await userId();
  conn().prepare(`UPDATE projects SET is_active = 0, updated_at = ? WHERE user_id = ?`).run(
    new Date().toISOString(),
    uid,
  );
  revalidatePath('/');
}

export async function deleteProject(id: number): Promise<void> {
  const uid = await userId();
  // Delete cascades to iterations + merkle_nodes via FK ON DELETE CASCADE
  conn().prepare(`DELETE FROM projects WHERE id = ? AND user_id = ?`).run(id, uid);
  revalidatePath('/');
}

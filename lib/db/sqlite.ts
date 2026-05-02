import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(DB_DIR, 'scruple.db');

let _db: Database.Database | null = null;

export function conn(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeConn(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Storage provider interface (Pivot S1).
//
// One per-user storage provider, chosen in /settings. All artifact
// writes go through the active provider. Scruple-web stores only
// hashes + pointers — never the bytes long-term.

export type ProviderKind = 'gdrive' | 'onedrive' | 'github' | 'local-dev';

export interface StoragePointer {
  provider: ProviderKind;
  /** Provider-native file id (Drive fileId, OneDrive itemId, GitHub blob sha). */
  fileId: string;
  /** Human-readable path within the provider (e.g. "Scruple Projects/Foo/iterations/SCR_X.png"). */
  path: string;
  /** Optional public URL for direct display (e.g. webViewLink). */
  url?: string;
  /** Size in bytes at upload time. */
  size?: number;
}

export interface UploadResult {
  pointer: StoragePointer;
}

export interface FolderEntry {
  fileId: string;
  name: string;
  size?: number;
  modifiedAt?: string;
  url?: string;
}

export interface StorageProvider {
  readonly kind: ProviderKind;

  /** True if the user has authenticated and the provider can be used. */
  isConnected(userId: string): Promise<boolean>;

  /** Push bytes to user storage. Returns a pointer to read it back. */
  uploadFile(
    userId: string,
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<UploadResult>;

  /** Stream bytes back. */
  readFile(userId: string, pointer: StoragePointer): Promise<Buffer>;

  /** Remove bytes (e.g. after lock-package retention). */
  deleteFile(userId: string, pointer: StoragePointer): Promise<void>;

  /** Optional: time-limited readable URL the browser can hit directly. */
  signedUrl?(userId: string, pointer: StoragePointer, ttlSeconds?: number): Promise<string>;

  /** Optional: enumerate a folder. */
  listFolder?(userId: string, path: string): Promise<FolderEntry[]>;
}

export class StorageError extends Error {
  constructor(
    public readonly provider: ProviderKind,
    public readonly code: 'not_connected' | 'auth' | 'not_found' | 'transport' | 'rate_limit' | 'unknown',
    message: string,
  ) {
    super(`[${provider}:${code}] ${message}`);
  }
}

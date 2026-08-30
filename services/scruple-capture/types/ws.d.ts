// Minimal ambient types for `ws`.
//
// WHY THIS FILE EXISTS. `ws` is a root dependency (package.json), but
// `@types/ws` is not installed and the only existing consumer —
// scripts/canvas-ws-proxy.mjs — is JavaScript, so nothing ever needed them.
// This component is TypeScript and `npx tsc --noEmit` must stay clean.
//
// WHY IT IS NOT `declare module 'ws';`. That form types the whole module as
// `any`, which would silently disable checking on the one surface where a
// mistake means an artifact reaching a tenant unwitnessed. What is declared
// below is exactly the subset this component uses, typed properly, so a
// wrong argument is still an error.
//
// PROPER FIX, deliberately not taken here: `npm i -D @types/ws` at the repo
// root. That edits root package.json and package-lock.json, which three other
// agents are working in this round, and a lockfile conflict is a worse
// outcome than a scoped declaration. Delete this file when the dev dependency
// lands.

declare module 'ws' {
  import type { IncomingMessage, Server as HttpServer } from 'node:http';
  import type { EventEmitter } from 'node:events';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    constructor(address: string | URL, options?: ClientOptions);

    readonly readyState: 0 | 1 | 2 | 3;

    send(data: string | Buffer | ArrayBuffer, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string | Buffer): void;
    terminate(): void;
    ping(data?: unknown): void;

    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
  }

  export interface ServerOptions {
    server?: HttpServer;
    port?: number;
    path?: string;
    noServer?: boolean;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: ServerOptions);
    close(cb?: (err?: Error) => void): void;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close' | 'listening', listener: () => void): this;
  }

  export default WebSocket;
}

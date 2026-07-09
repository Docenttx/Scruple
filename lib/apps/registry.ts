// Studio app catalog — WO-KOHYA Phase 2.
//
// The left nav in Studio + the app-router pages are driven from this
// registry. Adding a new app is a matter of:
//   1) A row here
//   2) An adapter under lib/apps/backends/ (or reuse an existing one)
//   3) A page at app/apps/<id>/page.tsx
//   4) A proxy route at app/<id>-proxy/[sessionId]/[[...path]]/route.ts
//      (unless the app is local-only, like Fusion)

import type { SessionBackendId, AppId } from './session-backends';

export interface AppRegistryEntry {
  id: AppId | 'fusion';
  name: string;
  /** One-line tagline for the left nav. */
  tagline: string;
  /** Href for the left-nav link. */
  href: string;
  /** Icon glyph (emoji or short string). Swap for SVG later. */
  icon: string;
  /** Backend that spawns the endpoint. `local` = user's own machine,
   *  no session mint (Fusion pattern). */
  backend: SessionBackendId;
  /** HTTP proxy route base. null for local apps. */
  proxyRoute: string | null;
  /** WS proxy hostname (Cloudflare tunnel target). null for local. */
  wsOrigin: string | null;
  /** Whether the app is enabled — used to hide un-ready apps until the
   *  backend is configured. */
  enabled: boolean;
}

/** RunPod-hosted apps become enabled once RUNPOD_API_KEY is set. */
const runpodReady = !!process.env.RUNPOD_API_KEY;

export const APPS: readonly AppRegistryEntry[] = [
  {
    id: 'canvas',
    name: 'ComfyUI',
    tagline: 'Interactive generation canvas',
    href: '/canvas',
    icon: '🎨',
    backend: 'modal',
    proxyRoute: '/canvas-proxy',
    wsOrigin: process.env.NEXT_PUBLIC_CANVAS_WS_ORIGIN ?? 'wss://scruple-canvas-ws.stooges.ai',
    enabled: true,
  },
  {
    id: 'kohya',
    name: 'Kohya',
    tagline: 'LoRA + Dreambooth training',
    href: '/apps/kohya',
    icon: '🧬',
    backend: 'runpod',
    proxyRoute: '/kohya-proxy',
    wsOrigin: process.env.NEXT_PUBLIC_KOHYA_WS_ORIGIN ?? 'wss://scruple-kohya-ws.stooges.ai',
    enabled: runpodReady,
  },
  {
    id: 'fusion',
    name: 'Fusion',
    tagline: 'Autodesk Fusion 360 add-in',
    href: '/embed/fusion',
    icon: '📐',
    backend: 'local',
    proxyRoute: null,
    wsOrigin: null,
    enabled: true,
  },
] as const;

export function getApp(id: string): AppRegistryEntry | null {
  return APPS.find((a) => a.id === id) ?? null;
}

export function enabledApps(): readonly AppRegistryEntry[] {
  return APPS.filter((a) => a.enabled);
}

export type HttpMethod = "GET" | "POST";
export type CaptureMode = "automatic" | "manual";

export interface ManualCapture {
  // ponytail: embedded data keeps JSON imports portable; move to a bundled asset format if libraries outgrow the 12 MiB-per-image ceiling.
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataUrl: string;
  addedAt: string;
}

export interface HeaderEntry {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
  sensitive: boolean;
}

export interface RouteDefinition {
  id: string;
  label: string;
  path: string;
  method: HttpMethod;
  body: string;
  notes: string;
  enabled: boolean;
  captureMode: CaptureMode;
  manualCapture: ManualCapture | null;
  lastStatusCode?: number | null;
  lastCapturedAt?: string | null;
  lastError?: string | null;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ProjectConfig {
  name: string;
  baseUrl: string;
  outputDir: string;
  viewport: Viewport;
  waitMs: number;
  headers: HeaderEntry[];
  routes: RouteDefinition[];
}

export interface SiteProject extends ProjectConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastCapturedAt: string | null;
  lastCaptureDir: string | null;
  lastCaptureStatus: "never" | "success" | "partial";
}

export interface ProjectLibrary {
  version: 1;
  activeSiteId: string;
  sites: SiteProject[];
}

export interface RouteCaptureResult {
  id: string;
  label: string;
  url: string;
  method: HttpMethod;
  captureMode: CaptureMode;
  statusCode: number | null;
  durationMs: number;
  contentType: string | null;
  folder: string;
  screenshotPath: string | null;
  responsePath: string | null;
  markdownPath: string;
  error: string | null;
}

export interface CaptureResult {
  sessionDir: string;
  capturedAt: string;
  successful: number;
  failed: number;
  browser: string | null;
  routes: RouteCaptureResult[];
}

export type CaptureState = "idle" | "running" | "done" | "error";

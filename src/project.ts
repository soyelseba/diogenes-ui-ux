import type { CaptureResult, ProjectConfig, ProjectLibrary, RouteDefinition, SiteProject } from "./types";

const STORAGE_KEY = "diogenes.project.v1";
const SENSITIVE_HEADER_MARKERS = ["authorization", "authenticate", "cookie", "api-key", "api_key", "token", "secret"];

export const viewportPresets = [
  { label: "Desktop", width: 1440, height: 1000 },
  { label: "Laptop", width: 1280, height: 800 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Móvil", width: 390, height: 844 },
] as const;

export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function createRoute(path = "/", label = "Página principal"): RouteDefinition {
  return {
    id: createId(),
    label,
    path,
    method: "GET",
    body: "",
    notes: "",
    enabled: true,
    captureMode: "automatic",
    manualCapture: null,
  };
}

export function defaultProject(): ProjectConfig {
  return {
    name: "Nuevo sitio",
    baseUrl: "",
    outputDir: "",
    viewport: { width: 1440, height: 1000 },
    waitMs: 1500,
    headers: [],
    routes: [createRoute()],
  };
}

export function createSiteProject(name = "Nuevo sitio"): SiteProject {
  const now = new Date().toISOString();
  return {
    id: createId(),
    createdAt: now,
    updatedAt: now,
    lastCapturedAt: null,
    lastCaptureDir: null,
    lastCaptureStatus: "never",
    ...defaultProject(),
    name,
  };
}

export function siteFromProject(project: ProjectConfig): SiteProject {
  return { ...createSiteProject(project.name || "Sitio importado"), ...project };
}

export function defaultLibrary(): ProjectLibrary {
  const site = createSiteProject();
  return { version: 1, activeSiteId: site.id, sites: [site] };
}

export function applyCaptureResult(site: SiteProject, result: CaptureResult): SiteProject {
  const byId = new Map(result.routes.map((route) => [route.id, route]));
  return {
    ...site,
    updatedAt: result.capturedAt,
    lastCapturedAt: result.capturedAt,
    lastCaptureDir: result.sessionDir,
    lastCaptureStatus: result.failed ? "partial" : "success",
    routes: site.routes.map((route) => {
      const captured = byId.get(route.id);
      return captured ? {
        ...route,
        lastStatusCode: captured.statusCode,
        lastCapturedAt: result.capturedAt,
        lastError: captured.error,
      } : route;
    }),
  };
}

export function normalizeUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.trim();
  const trimmedPath = path.trim();

  if (/^https?:\/\//i.test(trimmedPath)) return trimmedPath;
  if (!trimmedBase) return trimmedPath;

  const base = trimmedBase.endsWith("/") ? trimmedBase : `${trimmedBase}/`;
  try {
    return new URL(trimmedPath.replace(/^\//, ""), base).toString();
  } catch {
    return `${trimmedBase}${trimmedPath.startsWith("/") ? "" : "/"}${trimmedPath}`;
  }
}

export function validateProject(project: ProjectConfig): string[] {
  const errors: string[] = [];
  const activeRoutes = project.routes.filter((route) => route.enabled);
  const needsBaseUrl = activeRoutes.some((route) => route.captureMode === "automatic");

  if (needsBaseUrl) {
    try {
      const url = new URL(project.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) errors.push("La URL base debe usar HTTP o HTTPS.");
    } catch {
      errors.push("Ingresa una URL base válida.");
    }
  }

  if (!project.name.trim()) errors.push("El proyecto necesita un nombre.");
  if (!project.outputDir.trim()) errors.push("Selecciona una carpeta de exportación.");
  if (!activeRoutes.length) errors.push("Activa al menos una ruta.");
  if (activeRoutes.some((route) => route.captureMode === "manual" && !route.manualCapture)) {
    errors.push("Adjunta una imagen a cada ruta configurada como captura manual.");
  }
  if (project.viewport.width < 320 || project.viewport.height < 320 || project.viewport.width > 7680 || project.viewport.height > 7680) {
    errors.push("El viewport debe estar entre 320 y 7680 px por lado.");
  }

  return errors;
}

export function sanitizeLibraryForStorage(library: ProjectLibrary): ProjectLibrary {
  return {
    ...library,
    sites: library.sites.map((site) => ({ ...site, ...sanitizeProjectForStorage(site) })),
  };
}

export function loadProject(): ProjectConfig {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultProject();

  try {
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    if (!parsed || typeof parsed !== "object") return defaultProject();
    const fallback = defaultProject();
    const headers = Array.isArray(parsed.headers) ? parsed.headers
      .filter((header) => header && typeof header === "object")
      .map((header) => ({
        id: typeof header.id === "string" && header.id ? header.id : createId(),
        name: typeof header.name === "string" ? header.name : "",
        value: typeof header.value === "string" ? header.value : "",
        enabled: typeof header.enabled === "boolean" ? header.enabled : true,
        sensitive: typeof header.sensitive === "boolean" ? header.sensitive : isSensitiveHeaderName(String(header.name ?? "")),
      })) : [];
    const routes = Array.isArray(parsed.routes) ? parsed.routes
      .filter((route) => route && typeof route === "object" && typeof route.path === "string")
      .map((route) => ({
        ...createRoute(route.path, typeof route.label === "string" ? route.label : "Ruta"),
        id: typeof route.id === "string" && route.id ? route.id : createId(),
        method: route.method === "POST" ? "POST" as const : "GET" as const,
        body: typeof route.body === "string" ? route.body : "",
        notes: typeof route.notes === "string" ? route.notes : "",
        enabled: typeof route.enabled === "boolean" ? route.enabled : true,
        captureMode: route.captureMode === "manual" ? "manual" as const : "automatic" as const,
        manualCapture: route.manualCapture && typeof route.manualCapture === "object"
          && typeof route.manualCapture.dataUrl === "string"
          && typeof route.manualCapture.fileName === "string"
          && ["image/png", "image/jpeg", "image/webp"].includes(route.manualCapture.mimeType)
          ? route.manualCapture
          : null,
        lastStatusCode: typeof route.lastStatusCode === "number" ? route.lastStatusCode : null,
        lastCapturedAt: typeof route.lastCapturedAt === "string" ? route.lastCapturedAt : null,
        lastError: typeof route.lastError === "string" ? route.lastError : null,
      })) : fallback.routes;
    const width = Number(parsed.viewport?.width);
    const height = Number(parsed.viewport?.height);
    const waitMs = Number(parsed.waitMs);
    return {
      name: typeof parsed.name === "string" ? parsed.name : fallback.name,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      outputDir: typeof parsed.outputDir === "string" ? parsed.outputDir : "",
      viewport: {
        width: Number.isFinite(width) ? width : fallback.viewport.width,
        height: Number.isFinite(height) ? height : fallback.viewport.height,
      },
      waitMs: Number.isFinite(waitMs) ? waitMs : fallback.waitMs,
      headers,
      routes,
    };
  } catch {
    return defaultProject();
  }
}

export function saveProject(project: ProjectConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeProjectForStorage(project)));
}

export function sanitizeProjectForStorage(project: ProjectConfig): ProjectConfig {
  return {
    ...project,
    headers: project.headers.map((header) => ({
      ...header,
      value: header.sensitive || isSensitiveHeaderName(header.name) ? "" : header.value,
    })),
  };
}

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_MARKERS.some((marker) => normalized.includes(marker));
}

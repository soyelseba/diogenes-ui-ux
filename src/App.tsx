import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { applyCaptureResult, createId, createRoute, createSiteProject, defaultLibrary, isSensitiveHeaderName, loadProject, normalizeUrl, sanitizeLibraryForStorage, sanitizeProjectForStorage, siteFromProject, validateProject, viewportPresets } from "./project";
import type { CaptureResult, CaptureState, ProjectConfig, ProjectLibrary, RouteDefinition, SiteProject } from "./types";
import "./App.css";

type Section = "sites" | "routes" | "headers" | "settings" | "results";
const MANUAL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_MANUAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_LIBRARY_MANUAL_IMAGE_BYTES = 128 * 1024 * 1024;
type BrowserStatus = { available: boolean; name: string | null; path: string | null };

function manualCaptureBytes(dataUrl?: string): number {
  const payload = dataUrl?.split(",", 2)[1];
  return payload ? Math.floor(payload.length * 3 / 4) : 0;
}

function projectManualBytes(project: ProjectConfig): number {
  return project.routes.reduce((total, route) => total + manualCaptureBytes(route.manualCapture?.dataUrl), 0);
}

function libraryManualBytes(library: ProjectLibrary): number {
  return library.sites.reduce((total, site) => total + projectManualBytes(site), 0);
}

function Icon(props: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    archive: "M4 7.5h16M6 7.5v12h12v-12M3 4h18v3.5H3zM9 12h6",
    route: "M6 5a2 2 0 1 0 0 .01M18 19a2 2 0 1 0 0-.01M6 7v3c0 2 2 3 4 3h4c2 0 4 1 4 3v1",
    key: "M15.5 7.5a4 4 0 1 1-7.8 1.2L3 13.4V17h3v-2h2v-2h2.4",
    tune: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6",
    check: "m5 12 4 4L19 6",
    plus: "M12 5v14M5 12h14",
    folder: "M3 6h7l2 2h9v11H3z",
    upload: "M12 16V4m-4 4 4-4 4 4M5 20h14",
    download: "M12 4v12m-4-4 4 4 4-4M5 20h14",
    play: "m8 5 11 7-11 7z",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-18c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21m0-18C9.8 5.4 8.7 8.4 8.7 12S9.8 18.6 12 21M3 12h18",
    trash: "M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7m3 4v5m4-5v5",
    copy: "M8 8h11v12H8zM5 16H4V4h11v1",
    external: "M14 4h6v6m0-6-9 9M19 13v7H4V5h7",
    image: "M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M8 9h.01",
    file: "M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    chevron: "m9 18 6-6-6-6",
    close: "m6 6 12 12M18 6 6 18",
  };

  return (
    <svg width={props.size ?? 20} height={props.size ?? 20} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={paths[props.name]} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function App() {
  const [library, setLibrary] = createSignal<ProjectLibrary>(defaultLibrary());
  const project = createMemo(() => library().sites.find((site) => site.id === library().activeSiteId) ?? library().sites[0]);
  const [activeSection, setActiveSection] = createSignal<Section>("sites");
  const [selectedRouteId, setSelectedRouteId] = createSignal(project().routes[0]?.id ?? "");
  const [captureState, setCaptureState] = createSignal<CaptureState>("idle");
  const [captureResult, setCaptureResult] = createSignal<CaptureResult | null>(null);
  const [error, setError] = createSignal("");
  const [browser, setBrowser] = createSignal<BrowserStatus | null>(null);
  const [savedPulse, setSavedPulse] = createSignal(false);
  const [hydrated, setHydrated] = createSignal(false);
  const [libraryPath, setLibraryPath] = createSignal("");
  const [manualDragActive, setManualDragActive] = createSignal(false);
  let manualImageInput: HTMLInputElement | undefined;
  let saveQueue = Promise.resolve();
  const manualImageVersions = new Map<string, number>();

  const selectedRoute = createMemo(() => project().routes.find((route) => route.id === selectedRouteId()));
  const activeRoutes = createMemo(() => project().routes.filter((route) => route.enabled).length);
  const needsBrowser = createMemo(() => project().routes.some((route) => route.enabled && route.captureMode === "automatic" && route.method === "GET"));
  const captureReady = createMemo(() => !needsBrowser() || !!browser()?.available);
  const projectErrors = createMemo(() => validateProject(project()));

  createEffect(() => {
    const snapshot = sanitizeLibraryForStorage(library());
    if (!hydrated()) return;
    saveQueue = saveQueue.then(async () => {
      if (isTauri()) setLibraryPath(await invoke<string>("save_library", { library: snapshot }));
      setSavedPulse(true);
      window.setTimeout(() => setSavedPulse(false), 900);
    }).catch((reason) => {
      setError(`No se pudo respaldar la biblioteca local: ${String(reason)}`);
    });
  });

  onMount(async () => {
    if (!isTauri()) {
      setBrowser({ available: false, name: "Vista web", path: null });
      const legacy = loadProject();
      if (legacy.baseUrl.includes("example.com")) legacy.baseUrl = "";
      const site = siteFromProject(legacy);
      setLibrary({ version: 1, activeSiteId: site.id, sites: [site] });
      setSelectedRouteId(site.routes[0]?.id ?? "");
      setHydrated(true);
      return;
    }
    try {
      const stored = await invoke<ProjectLibrary | null>("load_library");
      if (stored) {
        setLibrary(stored);
        const active = stored.sites.find((site) => site.id === stored.activeSiteId) ?? stored.sites[0];
        setSelectedRouteId(active.routes[0]?.id ?? "");
      } else {
        const legacy = loadProject();
        if (legacy.baseUrl.includes("example.com")) legacy.baseUrl = "";
        const site = siteFromProject(legacy);
        setLibrary({ version: 1, activeSiteId: site.id, sites: [site] });
        setSelectedRouteId(site.routes[0]?.id ?? "");
      }
      setHydrated(true);
    } catch (reason) {
      setError(`No se pudo cargar la biblioteca local. El archivo original se preservó para recuperación: ${String(reason)}`);
      return;
    }
    try {
      setBrowser(await invoke<BrowserStatus>("browser_status"));
    } catch {
      setBrowser({ available: false, name: null, path: null });
    }
  });

  function setProject(next: ProjectConfig | ((current: SiteProject) => ProjectConfig)) {
    setLibrary((current) => ({
      ...current,
      sites: current.sites.map((site) => {
        if (site.id !== current.activeSiteId) return site;
        const updated = typeof next === "function" ? next(site) : next;
        return { ...site, ...updated, updatedAt: new Date().toISOString() };
      }),
    }));
  }

  function patchProject(patch: Partial<ProjectConfig>) {
    setProject((current) => ({ ...current, ...patch }));
  }

  function selectSite(id: string) {
    const site = library().sites.find((item) => item.id === id);
    if (!site) return;
    setLibrary((current) => ({ ...current, activeSiteId: id }));
    setSelectedRouteId(site.routes[0]?.id ?? "");
    setCaptureResult(null);
    setCaptureState("idle");
  }

  function addSite() {
    if (library().sites.length >= 100) return setError("La biblioteca admite hasta 100 sitios.");
    const site = createSiteProject(`Sitio ${library().sites.length + 1}`);
    setLibrary((current) => ({ ...current, activeSiteId: site.id, sites: [...current.sites, site] }));
    setSelectedRouteId(site.routes[0]?.id ?? "");
    setActiveSection("routes");
  }

  function duplicateSite(source: SiteProject) {
    if (library().sites.length >= 100) return setError("La biblioteca admite hasta 100 sitios.");
    if (libraryManualBytes(library()) + projectManualBytes(source) > MAX_LIBRARY_MANUAL_IMAGE_BYTES) return setError("Duplicar el sitio superaría el límite de 128 MiB para capturas manuales.");
    const now = new Date().toISOString();
    const copy: SiteProject = {
      ...source,
      id: createId(),
      name: `${source.name} — copia`,
      createdAt: now,
      updatedAt: now,
      lastCapturedAt: null,
      lastCaptureDir: null,
      lastCaptureStatus: "never",
      routes: source.routes.map((route) => ({ ...route, id: createId(), lastStatusCode: null, lastCapturedAt: null, lastError: null })),
    };
    setLibrary((current) => ({ ...current, activeSiteId: copy.id, sites: [...current.sites, copy] }));
    setSelectedRouteId(copy.routes[0]?.id ?? "");
  }

  function removeSite(id: string) {
    if (library().sites.length === 1) return setError("Diógenes necesita conservar al menos un sitio.");
    const sites = library().sites.filter((site) => site.id !== id);
    const nextId = library().activeSiteId === id ? sites[0].id : library().activeSiteId;
    setLibrary((current) => ({ ...current, activeSiteId: nextId, sites }));
    const next = sites.find((site) => site.id === nextId) ?? sites[0];
    setSelectedRouteId(next.routes[0]?.id ?? "");
  }

  function patchRouteForSite(siteId: string, routeId: string, patch: Partial<RouteDefinition>) {
    setLibrary((current) => ({
      ...current,
      sites: current.sites.map((site) => site.id === siteId ? {
        ...site,
        updatedAt: new Date().toISOString(),
        routes: site.routes.map((route) => route.id === routeId ? { ...route, ...patch } : route),
      } : site),
    }));
  }

  function patchRoute(id: string, patch: Partial<RouteDefinition>) {
    patchRouteForSite(library().activeSiteId, id, patch);
  }

  function cancelManualImageWork(siteId: string, routeId: string) {
    const key = `${siteId}:${routeId}`;
    manualImageVersions.set(key, (manualImageVersions.get(key) ?? 0) + 1);
  }

  function addRoute() {
    if (project().routes.length >= 500) return setError("Cada sitio admite hasta 500 rutas.");
    const route = createRoute(`/ruta-${project().routes.length + 1}`, "Nueva ruta");
    patchProject({ routes: [...project().routes, route] });
    setSelectedRouteId(route.id);
    setActiveSection("routes");
  }

  function removeRoute(id: string) {
    cancelManualImageWork(library().activeSiteId, id);
    const routes = project().routes.filter((route) => route.id !== id);
    patchProject({ routes });
    if (selectedRouteId() === id) setSelectedRouteId(routes[0]?.id ?? "");
  }

  async function attachManualImage(siteId: string, routeId: string, file: File | null | undefined) {
    if (!file) return;
    if (!isTauri()) return setError("La validación segura de imágenes manuales requiere abrir Diógenes con Tauri.");
    if (!MANUAL_IMAGE_TYPES.includes(file.type as typeof MANUAL_IMAGE_TYPES[number])) {
      return setError("Usa una imagen PNG, JPEG o WebP.");
    }
    if (file.size > MAX_MANUAL_IMAGE_BYTES) {
      return setError("La captura manual no puede superar 12 MiB.");
    }
    const storedBytes = libraryManualBytes(library());
    const previous = library().sites.find((site) => site.id === siteId)?.routes.find((route) => route.id === routeId)?.manualCapture?.dataUrl;
    const previousBytes = manualCaptureBytes(previous);
    if (storedBytes - previousBytes + file.size > MAX_LIBRARY_MANUAL_IMAGE_BYTES) {
      return setError("La biblioteca admite hasta 128 MiB de capturas manuales.");
    }
    const operationKey = `${siteId}:${routeId}`;
    const operationVersion = (manualImageVersions.get(operationKey) ?? 0) + 1;
    manualImageVersions.set(operationKey, operationVersion);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("La imagen no se pudo leer."));
        reader.onerror = () => reject(reader.error ?? new Error("La imagen no se pudo leer."));
        reader.readAsDataURL(file);
      });
      const capture = {
        fileName: file.name || `captura-${Date.now()}.png`,
        mimeType: file.type as "image/png" | "image/jpeg" | "image/webp",
        dataUrl,
        addedAt: new Date().toISOString(),
      };
      await invoke("validate_manual_image", { capture });
      if (manualImageVersions.get(operationKey) !== operationVersion) return;
      const currentPrevious = library().sites.find((site) => site.id === siteId)?.routes.find((route) => route.id === routeId)?.manualCapture?.dataUrl;
      if (libraryManualBytes(library()) - manualCaptureBytes(currentPrevious) + file.size > MAX_LIBRARY_MANUAL_IMAGE_BYTES) {
        return setError("La biblioteca admite hasta 128 MiB de capturas manuales.");
      }
      patchRouteForSite(siteId, routeId, {
        captureMode: "manual",
        manualCapture: capture,
      });
      setError("");
    } catch (reason) {
      setError(`No se pudo adjuntar la imagen: ${String(reason)}`);
    }
  }

  function pastedImage(event: ClipboardEvent): File | null {
    return Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.type.startsWith("image/"))?.getAsFile() ?? null;
  }

  async function chooseOutputDirectory() {
    if (!isTauri()) {
      setError("La selección de carpetas está disponible al ejecutar la aplicación con Tauri.");
      return;
    }
    const selected = await open({ directory: true, multiple: false, title: "Selecciona dónde exportar el contexto" });
    if (typeof selected === "string") patchProject({ outputDir: selected });
  }

  async function exportProjectFile() {
    if (!isTauri()) return setError("Abre la aplicación con Tauri para guardar el proyecto.");
    const path = await save({ defaultPath: `${project().name}.diogenes.json`, filters: [{ name: "Proyecto Diógenes", extensions: ["json"] }] });
    if (path) await invoke("save_project_file", { path, site: { ...project(), ...sanitizeProjectForStorage(project()) } });
  }

  async function exportLibraryBackup() {
    if (!isTauri()) return setError("Abre la aplicación con Tauri para respaldar la colección.");
    const path = await save({ defaultPath: "diogenes-library.backup.json", filters: [{ name: "Biblioteca Diógenes", extensions: ["json"] }] });
    if (path) await invoke("export_library_file", { path, library: sanitizeLibraryForStorage(library()) });
  }

  async function importLibraryBackup() {
    if (!isTauri()) return setError("Abre la aplicación con Tauri para restaurar una colección.");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Biblioteca Diógenes", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    const approved = await confirm("La colección importada reemplazará la biblioteca activa. Se conservará una copia local .bak del estado actual.", { title: "Restaurar biblioteca", kind: "warning" });
    if (!approved) return;
    try {
      const restored = await invoke<ProjectLibrary>("import_library_file", { path });
      const storedPath = await invoke<string>("save_library", { library: sanitizeLibraryForStorage(restored) });
      setLibrary(restored);
      setLibraryPath(storedPath);
      setHydrated(true);
      const active = restored.sites.find((site) => site.id === restored.activeSiteId) ?? restored.sites[0];
      setSelectedRouteId(active.routes[0]?.id ?? "");
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function importProjectFile() {
    if (!isTauri()) return setError("Abre la aplicación con Tauri para importar un proyecto.");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Proyecto Diógenes", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const loaded = await invoke<ProjectConfig | SiteProject>("load_project_file", { path });
      if (library().sites.length >= 100) return setError("La biblioteca admite hasta 100 sitios.");
      if (libraryManualBytes(library()) + projectManualBytes(loaded) > MAX_LIBRARY_MANUAL_IMAGE_BYTES) return setError("Importar el sitio superaría el límite de 128 MiB para capturas manuales.");
      const site = "id" in loaded ? { ...loaded, id: createId(), name: `${loaded.name} — importado` } : siteFromProject(loaded);
      setLibrary((current) => ({ ...current, activeSiteId: site.id, sites: [...current.sites, site] }));
      setSelectedRouteId(site.routes[0]?.id ?? "");
      setActiveSection("routes");
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function startCapture() {
    const errors = projectErrors();
    if (errors.length) return setError(errors.join(" "));
    if (!isTauri()) return setError("La captura real requiere ejecutar `npm run tauri dev`.");

    setCaptureState("running");
    setError("");
    setCaptureResult(null);
    try {
      const result = await invoke<CaptureResult>("collect_project", { project: project() });
      setCaptureResult(result);
      setLibrary((current) => ({
        ...current,
        sites: current.sites.map((site) => site.id === current.activeSiteId ? applyCaptureResult(site, result) : site),
      }));
      setCaptureState("done");
      setActiveSection("results");
    } catch (reason) {
      setCaptureState("error");
      setError(String(reason));
    }
  }

  async function revealOutput() {
    const path = captureResult()?.sessionDir;
    if (path) await openPath(path);
  }

  const sectionLabels: Record<Section, string> = {
    sites: "Sitios",
    routes: "Rutas",
    headers: "Headers",
    settings: "Ajustes",
    results: "Resultados",
  };

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-mark" title="Diógenes"><span>D</span></div>
        <nav class="side-nav" aria-label="Secciones">
          <button classList={{ active: activeSection() === "sites" }} onClick={() => setActiveSection("sites")} title="Sitios"><Icon name="archive" /></button>
          <button classList={{ active: activeSection() === "routes" }} onClick={() => setActiveSection("routes")} title="Rutas"><Icon name="route" /></button>
          <button classList={{ active: activeSection() === "headers" }} onClick={() => setActiveSection("headers")} title="Headers"><Icon name="key" /></button>
          <button classList={{ active: activeSection() === "settings" }} onClick={() => setActiveSection("settings")} title="Ajustes"><Icon name="tune" /></button>
          <button classList={{ active: activeSection() === "results" }} onClick={() => setActiveSection("results")} title="Resultados"><Icon name="check" /></button>
        </nav>
        <div class="sidebar-status" classList={{ ready: captureReady() }} title={needsBrowser() ? (browser()?.path ?? "Navegador no detectado") : "Las rutas manuales no necesitan navegador"}>
          <span />
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div class="project-identity">
            <div class="project-switch-row">
              <span class="eyebrow">SITIO ACTIVO</span>
              <select aria-label="Cambiar sitio activo" value={library().activeSiteId} onChange={(event) => selectSite(event.currentTarget.value)}>
                <For each={library().sites}>{(site) => <option value={site.id}>{site.name}</option>}</For>
              </select>
            </div>
            <div class="project-title-row">
              <input aria-label="Nombre del proyecto" value={project().name} onInput={(event) => patchProject({ name: event.currentTarget.value })} />
              <span class="save-state"><Icon name="check" size={14} /> {savedPulse() ? "Guardando" : "Guardado"}</span>
            </div>
          </div>
          <div class="topbar-actions">
            <button class="quiet-button" onClick={importProjectFile}><Icon name="upload" size={17} /> Importar sitio</button>
            <button class="quiet-button" onClick={exportProjectFile}><Icon name="download" size={17} /> Exportar sitio</button>
            <button class="capture-button" disabled={captureState() === "running"} onClick={startCapture}>
              <Show when={captureState() !== "running"} fallback={<span class="spinner" />}><Icon name="play" size={17} /></Show>
              {captureState() === "running" ? "Capturando…" : `Capturar ${activeRoutes()} rutas`}
            </button>
          </div>
        </header>

        <Show when={error()}>
          <div class="error-banner"><span>{error()}</span><button aria-label="Cerrar error" onClick={() => setError("")}><Icon name="close" size={16} /></button></div>
        </Show>

        <div class="content-area">
          <Show when={activeSection() === "sites"}>
            <section class="panel-section narrow-section">
              <div class="section-heading">
                <div><div class="eyebrow">00 · BIBLIOTECA</div><h1>Sitios recopilados</h1><p>Organiza cada web con sus rutas, configuración e historial de análisis.</p></div>
                <button class="outline-button" onClick={addSite}><Icon name="plus" size={17} /> Nuevo sitio</button>
              </div>
              <div class="library-toolbar">
                <div><Icon name="archive" /><span><b>Respaldo JSON local</b><small>{libraryPath() || "Se guardará en los datos locales de Diógenes"}</small></span></div>
                <button class="quiet-button" onClick={importLibraryBackup}><Icon name="upload" size={16} /> Restaurar colección</button>
                <button class="quiet-button" onClick={exportLibraryBackup}><Icon name="download" size={16} /> Exportar respaldo</button>
              </div>
              <div class="site-grid">
                <For each={library().sites}>{(site) => {
                  const analyzed = () => site.routes.filter((route) => route.lastCapturedAt).length;
                  return <article class="site-card" classList={{ active: site.id === library().activeSiteId }}>
                    <button class="site-card-main" onClick={() => { selectSite(site.id); setActiveSection("routes"); }}>
                      <div class="site-card-top"><span class={`capture-state ${site.lastCaptureStatus}`}><i />{site.lastCaptureStatus === "never" ? "Sin analizar" : site.lastCaptureStatus === "success" ? "Última captura correcta" : "Captura con alertas"}</span><Icon name="chevron" size={16} /></div>
                      <h2>{site.name}</h2>
                      <code>{site.baseUrl || "URL pendiente"}</code>
                      <div class="site-metrics"><span><b>{site.routes.length}</b> rutas</span><span><b>{analyzed()}</b> analizadas</span><span><b>{site.routes.filter((route) => route.enabled).length}</b> activas</span></div>
                      <div class="site-last-capture">{site.lastCapturedAt ? `Última captura · ${new Date(site.lastCapturedAt).toLocaleString("es-CL")}` : "Todavía no hay capturas"}</div>
                    </button>
                    <div class="site-card-actions"><button onClick={() => duplicateSite(site)}><Icon name="copy" size={15} /> Duplicar</button><button class="danger" onClick={() => removeSite(site.id)}><Icon name="trash" size={15} /> Eliminar</button></div>
                  </article>;
                }}</For>
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "routes"}>
            <section class="route-workspace">
              <div class="section-heading">
                <div>
                  <div class="eyebrow">01 · COBERTURA</div>
                  <h1>Rutas a recopilar</h1>
                  <p>Recopila cada ruta automáticamente o adjunta un pantallazo manual pegándolo, arrastrándolo o seleccionándolo.</p>
                </div>
                <button class="outline-button" onClick={addRoute}><Icon name="plus" size={17} /> Añadir ruta</button>
              </div>

              <div class="base-url-card">
                <div class="url-icon"><Icon name="globe" /></div>
                <label>
                  <span>URL BASE</span>
                  <input value={project().baseUrl} placeholder="https://tu-sitio.cl" onInput={(event) => patchProject({ baseUrl: event.currentTarget.value })} spellcheck={false} />
                </label>
                <div class="protocol-chip">{project().baseUrl ? (project().baseUrl.startsWith("https://") ? "HTTPS" : "HTTP") : "SIN URL"}</div>
              </div>

              <div class="route-layout">
                <div class="route-list">
                  <div class="list-header"><span>{project().routes.length} rutas</span><span>{activeRoutes()} activas</span></div>
                  <Show when={project().routes.length} fallback={<div class="empty-state"><Icon name="route" size={28} /><b>Sin rutas todavía</b><span>Añade la primera ruta para comenzar.</span></div>}>
                    <For each={project().routes}>{(route, index) => (
                      <button class="route-row" classList={{ selected: selectedRouteId() === route.id, disabled: !route.enabled }} onClick={() => setSelectedRouteId(route.id)}>
                        <span class="route-index">{String(index() + 1).padStart(2, "0")}</span>
                        <span class="route-main"><b>{route.label || "Ruta sin nombre"}</b><code>{normalizeUrl(project().baseUrl, route.path)}</code><Show when={route.lastCapturedAt}><small classList={{ failed: !!route.lastError }}>{route.captureMode === "manual" ? "Manual · recopilada" : `HTTP ${route.lastStatusCode ?? "—"} · analizada`}</small></Show></span>
                        <span class={`method method-${route.captureMode === "manual" ? "manual" : route.method.toLowerCase()}`}>{route.captureMode === "manual" ? "MANUAL" : route.method}</span>
                        <span class="route-enabled" classList={{ on: route.enabled }} />
                        <Icon name="chevron" size={16} />
                      </button>
                    )}</For>
                  </Show>
                </div>

                <Show when={selectedRoute()} fallback={<aside class="route-editor empty-editor"><Icon name="route" size={30} /><p>Selecciona una ruta para editarla.</p></aside>}>
                  {(route) => <aside class="route-editor">
                    <div class="editor-header"><div><span>EDITANDO</span><b>{route().label}</b></div><button class="icon-button" title="Eliminar ruta" onClick={() => removeRoute(route().id)}><Icon name="trash" size={18} /></button></div>
                    <label class="field"><span>NOMBRE DE REFERENCIA</span><input value={route().label} onInput={(event) => patchRoute(route().id, { label: event.currentTarget.value })} /></label>
                    <div class="capture-mode" role="group" aria-label="Modo de captura">
                      <button classList={{ active: route().captureMode === "automatic" }} onClick={() => { cancelManualImageWork(library().activeSiteId, route().id); patchRoute(route().id, { captureMode: "automatic" }); }}><Icon name="globe" size={15} /> Automática</button>
                      <button classList={{ active: route().captureMode === "manual" }} onClick={() => patchRoute(route().id, { captureMode: "manual" })}><Icon name="image" size={15} /> Manual</button>
                    </div>
                    <div class="field-row">
                      <Show when={route().captureMode === "automatic"}><label class="field method-field"><span>MÉTODO</span><select value={route().method} onChange={(event) => patchRoute(route().id, { method: event.currentTarget.value as "GET" | "POST" })}><option>GET</option><option>POST</option></select></label></Show>
                      <label class="field grow"><span>RUTA O URL DE REFERENCIA</span><input value={route().path} onInput={(event) => patchRoute(route().id, { path: event.currentTarget.value })} spellcheck={false} /></label>
                    </div>
                    <Show when={route().captureMode === "automatic" && route().method === "POST"}><label class="field"><span>CUERPO DE LA SOLICITUD</span><textarea rows="4" value={route().body} onInput={(event) => patchRoute(route().id, { body: event.currentTarget.value })} placeholder='{"query":"..."}' spellcheck={false} /></label></Show>
                    <Show when={route().captureMode === "manual"}>
                      <div
                        class="manual-capture"
                        classList={{ dragging: manualDragActive(), attached: !!route().manualCapture }}
                        role="button"
                        tabIndex={0}
                        aria-label="Adjuntar pantallazo manual"
                        onClick={() => manualImageInput?.click()}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); manualImageInput?.click(); } }}
                        onPaste={(event) => { const file = pastedImage(event); if (file) { event.preventDefault(); void attachManualImage(library().activeSiteId, route().id, file); } }}
                        onDragOver={(event) => { event.preventDefault(); setManualDragActive(true); }}
                        onDragLeave={() => setManualDragActive(false)}
                        onDrop={(event) => { event.preventDefault(); setManualDragActive(false); void attachManualImage(library().activeSiteId, route().id, Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith("image/"))); }}
                      >
                        <input ref={manualImageInput} class="manual-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void attachManualImage(library().activeSiteId, route().id, event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
                        <Show when={route().manualCapture} fallback={<><Icon name="image" size={27} /><b>Pega, arrastra o selecciona una imagen</b><span>PNG, JPEG o WebP · máximo 12 MiB</span></>}>
                          {(capture) => <div class="manual-preview">
                            <img src={capture().dataUrl} alt={`Pantallazo manual de ${route().label}`} />
                            <div><b>{capture().fileName}</b><span>Adjuntada · haz clic para reemplazarla</span></div>
                            <button class="icon-button" title="Quitar imagen" onClick={(event) => { event.stopPropagation(); cancelManualImageWork(library().activeSiteId, route().id); patchRoute(route().id, { manualCapture: null }); }}><Icon name="trash" size={17} /></button>
                          </div>}
                        </Show>
                      </div>
                    </Show>
                    <label class="field"><span>NOTAS PARA EL AGENTE</span><textarea rows="5" value={route().notes} onInput={(event) => patchRoute(route().id, { notes: event.currentTarget.value })} placeholder="¿Qué debe comprender un agente al revisar esta pantalla?" /></label>
                    <label class="switch-row"><span><b>Incluir en la próxima captura</b><small>Las rutas inactivas se conservan en el proyecto.</small></span><input type="checkbox" checked={route().enabled} onChange={(event) => patchRoute(route().id, { enabled: event.currentTarget.checked })} /><i /></label>
                  </aside>}
                </Show>
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "headers"}>
            <section class="panel-section narrow-section">
              <div class="section-heading">
                <div><div class="eyebrow">02 · ACCESO</div><h1>Headers HTTP</h1><p>Se aplican a la descarga de respuestas. Los secretos se mantienen sólo durante esta sesión.</p></div>
                <button class="outline-button" onClick={() => patchProject({ headers: [...project().headers, { id: createId(), name: "", value: "", enabled: true, sensitive: false }] })}><Icon name="plus" size={17} /> Añadir header</button>
              </div>
              <div class="notice"><Icon name="key" /><span>Los headers personalizados no se inyectan en el pantallazo del navegador. Para sitios autenticados usa una URL de sesión accesible o captura su respuesta HTTP.</span></div>
              <div class="header-table">
                <div class="header-table-head"><span>Activo</span><span>Nombre</span><span>Valor</span><span>Secreto</span><span /></div>
                <Show when={project().headers.length} fallback={<div class="empty-state"><Icon name="key" size={28} /><b>No hay headers configurados</b><span>Las rutas públicas no necesitan ninguno.</span></div>}>
                  <For each={project().headers}>{(header) => <div class="header-row">
                    <input type="checkbox" checked={header.enabled} onChange={(event) => patchProject({ headers: project().headers.map((item) => item.id === header.id ? { ...item, enabled: event.currentTarget.checked } : item) })} />
                    <input aria-label="Nombre del header" value={header.name} placeholder="Authorization" onInput={(event) => patchProject({ headers: project().headers.map((item) => item.id === header.id ? { ...item, name: event.currentTarget.value, sensitive: item.sensitive || isSensitiveHeaderName(event.currentTarget.value) } : item) })} />
                    <input aria-label="Valor del header" value={header.value} placeholder="Bearer …" type={header.sensitive || isSensitiveHeaderName(header.name) ? "password" : "text"} onInput={(event) => patchProject({ headers: project().headers.map((item) => item.id === header.id ? { ...item, value: event.currentTarget.value } : item) })} />
                    <input aria-label="Tratar como secreto" title="No guardar este valor en disco ni en exportaciones" type="checkbox" checked={header.sensitive || isSensitiveHeaderName(header.name)} disabled={isSensitiveHeaderName(header.name)} onChange={(event) => patchProject({ headers: project().headers.map((item) => item.id === header.id ? { ...item, sensitive: event.currentTarget.checked } : item) })} />
                    <button class="icon-button" onClick={() => patchProject({ headers: project().headers.filter((item) => item.id !== header.id) })}><Icon name="trash" size={17} /></button>
                  </div>}</For>
                </Show>
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "settings"}>
            <section class="panel-section narrow-section">
              <div class="section-heading"><div><div class="eyebrow">03 · SALIDA</div><h1>Formato de captura</h1><p>Define el viewport, la espera de render y el destino del paquete.</p></div></div>
              <div class="settings-grid">
                <div class="settings-card span-two"><div class="card-label">VIEWPORT DEL NAVEGADOR</div><div class="preset-grid"><For each={viewportPresets}>{(preset) => <button classList={{ active: project().viewport.width === preset.width && project().viewport.height === preset.height }} onClick={() => patchProject({ viewport: { width: preset.width, height: preset.height } })}><Icon name={preset.width < 500 ? "file" : "image"} /><b>{preset.label}</b><span>{preset.width} × {preset.height}</span></button>}</For></div><div class="custom-size"><label><span>ANCHO</span><input type="number" min="320" value={project().viewport.width} onInput={(event) => patchProject({ viewport: { ...project().viewport, width: Number(event.currentTarget.value) } })} /></label><span>×</span><label><span>ALTO</span><input type="number" min="320" value={project().viewport.height} onInput={(event) => patchProject({ viewport: { ...project().viewport, height: Number(event.currentTarget.value) } })} /></label><span>px</span></div></div>
                <div class="settings-card"><div class="card-label">ESPERA DE RENDER</div><div class="range-value">{project().waitMs}<small> ms</small></div><input class="range" type="range" min="100" max="10000" step="100" value={project().waitMs} onInput={(event) => patchProject({ waitMs: Number(event.currentTarget.value) })} /><p>Tiempo disponible para JavaScript, fuentes y animaciones antes del pantallazo.</p></div>
                <div class="settings-card"><div class="card-label">NAVEGADOR</div><div class="browser-card-status"><span classList={{ online: captureReady() }} /><div><b>{needsBrowser() ? (browser()?.name ?? "Detectando…") : "No requerido"}</b><small>{captureReady() ? "Listo para capturar" : "No disponible"}</small></div></div><p>Las rutas manuales no requieren navegador. Para rutas automáticas busca Chrome, Edge o Chromium; puedes definir <code>DIOGENES_BROWSER_PATH</code>.</p></div>
                <div class="settings-card span-two"><div class="card-label">CARPETA DE EXPORTACIÓN</div><div class="folder-picker"><Icon name="folder" /><div><b>{project().outputDir ? "Destino seleccionado" : "Selecciona una carpeta"}</b><span>{project().outputDir || "El paquete de contexto se creará aquí"}</span></div><button class="outline-button" onClick={chooseOutputDirectory}>Examinar</button></div></div>
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "results"}>
            <section class="panel-section narrow-section">
              <div class="section-heading"><div><div class="eyebrow">04 · ENTREGA</div><h1>Resultado de la captura</h1><p>Un paquete legible por personas, scripts y agentes.</p></div><Show when={captureResult()}><button class="outline-button" onClick={revealOutput}><Icon name="external" size={17} /> Abrir carpeta</button></Show></div>
              <Show when={captureState() === "running"}><div class="capture-progress"><div class="radar"><span /><i /></div><b>Recopilando {activeRoutes()} rutas</b><p>Preparando respuestas automáticas, imágenes manuales y fichas Markdown…</p></div></Show>
              <Show when={captureResult()} fallback={<Show when={captureState() !== "running"}><div class="results-empty"><div class="package-illustration"><Icon name="archive" size={40} /><span>.md</span><span>.png</span><span>.json</span></div><h2>Tu paquete aparecerá aquí</h2><p>Configura rutas y destino, luego inicia una captura.</p><button class="capture-button" onClick={startCapture}><Icon name="play" size={17} /> Capturar ahora</button></div></Show>}>
                {(result) => <div class="results-content">
                  <div class="result-summary"><div><span>CAPTURA COMPLETA</span><h2>{project().name}</h2><code>{result().sessionDir}</code></div><div class="result-stat good"><b>{result().successful}</b><span>Correctas</span></div><div class="result-stat bad"><b>{result().failed}</b><span>A revisar</span></div></div>
                  <div class="artifact-strip"><div><Icon name="file" /><span><b>README.md</b><small>Índice para agentes</small></span></div><div><Icon name="image" /><span><b>{result().routes.filter((route) => route.screenshotPath).length} imágenes</b><small>Pantallazos</small></span></div><div><Icon name="archive" /><span><b>manifest.json</b><small>Índice estructurado</small></span></div></div>
                  <div class="result-routes"><div class="list-header"><span>RUTA</span><span>RESPUESTA</span><span>ARTEFACTOS</span></div><For each={result().routes}>{(route) => <div class="result-route"><span classList={{ "success-dot": !route.error, "error-dot": !!route.error }} /><div><b>{route.label}</b><code>{route.url}</code><Show when={route.error}><small>{route.error}</small></Show></div><span class={`status-code status-${Math.floor((route.statusCode ?? 0) / 100)}`}>{route.statusCode ?? "—"}</span><span class="artifact-icons"><span classList={{ present: !!route.screenshotPath }}><Icon name="image" size={16} /></span><span classList={{ present: !!route.responsePath }}><Icon name="file" size={16} /></span></span></div>}</For></div>
                </div>}
              </Show>
            </section>
          </Show>
        </div>

        <footer class="statusbar">
          <div><span classList={{ ready: captureReady() }} /> {needsBrowser() ? (browser()?.available ? `${browser()?.name} disponible` : "Navegador pendiente") : "Modo manual listo"}</div>
          <div>{sectionLabels[activeSection()]} · {project().viewport.width} × {project().viewport.height} · espera {project().waitMs} ms</div>
        </footer>
      </main>
    </div>
  );
}

export default App;

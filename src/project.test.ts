import { describe, expect, it } from "vitest";
import { applyCaptureResult, createSiteProject, defaultLibrary, defaultProject, isSensitiveHeaderName, normalizeUrl, sanitizeLibraryForStorage, sanitizeProjectForStorage, validateProject } from "./project";

describe("normalizeUrl", () => {
  it("combina la base y una ruta relativa", () => {
    expect(normalizeUrl("https://example.com/app", "/contacto")).toBe(
      "https://example.com/app/contacto",
    );
  });

  it("mantiene una URL absoluta", () => {
    expect(normalizeUrl("https://example.com", "https://status.example.com/health")).toBe(
      "https://status.example.com/health",
    );
  });
});

describe("biblioteca de sitios", () => {
  it("empieza con un sitio vacío, no con example.com", () => {
    const library = defaultLibrary();
    expect(library.sites).toHaveLength(1);
    expect(library.sites[0].baseUrl).toBe("");
    expect(library.activeSiteId).toBe(library.sites[0].id);
    expect(library.sites[0].routes[0].captureMode).toBe("automatic");
  });

  it("registra el resultado analizado en el sitio y sus rutas", () => {
    const site = createSiteProject("Biofuturo");
    const updated = applyCaptureResult(site, {
      sessionDir: "C:/captures/one",
      capturedAt: "2026-08-30T18:00:00Z",
      successful: 1,
      failed: 0,
      browser: "Chrome",
      routes: [{
        id: site.routes[0].id,
        label: site.routes[0].label,
        url: "https://biofuturo.cl/",
        method: "GET",
        captureMode: "automatic",
        statusCode: 200,
        durationMs: 80,
        contentType: "text/html",
        folder: "routes/001-home",
        screenshotPath: "routes/001-home/screenshot.png",
        responsePath: "routes/001-home/response.json",
        markdownPath: "routes/001-home/README.md",
        error: null,
      }],
    });
    expect(updated.lastCaptureStatus).toBe("success");
    expect(updated.routes[0].lastStatusCode).toBe(200);
  });

  it("redacta secretos en todos los sitios antes de persistir", () => {
    const library = defaultLibrary();
    library.sites[0].headers = [{ id: "secret", name: "Cookie", value: "session=123", enabled: true, sensitive: false }];
    expect(sanitizeLibraryForStorage(library).sites[0].headers[0].value).toBe("");
  });

  it("clasifica nombres de credenciales de forma consistente", () => {
    expect(isSensitiveHeaderName("X-Authorization-Token")).toBe(true);
    expect(isSensitiveHeaderName("Api-Key")).toBe(true);
    expect(isSensitiveHeaderName("Accept-Language")).toBe(false);
  });
});

describe("validateProject", () => {
  it("requiere destino y una ruta activa", () => {
    const project = defaultProject();
    project.baseUrl = "https://biofuturo.cl";
    project.routes[0].enabled = false;
    expect(validateProject(project)).toEqual([
      "Selecciona una carpeta de exportación.",
      "Activa al menos una ruta.",
    ]);
  });

  it("acepta un proyecto listo", () => {
    const project = defaultProject();
    project.baseUrl = "https://biofuturo.cl";
    project.outputDir = "C:\\captures";
    expect(validateProject(project)).toEqual([]);
  });

  it("acepta una ruta manual con imagen sin exigir URL base", () => {
    const project = defaultProject();
    project.outputDir = "C:\\captures";
    project.routes[0].captureMode = "manual";
    project.routes[0].manualCapture = {
      fileName: "inicio.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      addedAt: "2026-08-30T00:00:00Z",
    };
    expect(validateProject(project)).toEqual([]);
  });

  it("requiere imagen cuando una ruta activa es manual", () => {
    const project = defaultProject();
    project.outputDir = "C:\\captures";
    project.routes[0].captureMode = "manual";
    expect(validateProject(project)).toContain("Adjunta una imagen a cada ruta configurada como captura manual.");
  });
});

describe("sanitizeProjectForStorage", () => {
  it("mantiene los secretos fuera del almacenamiento durable", () => {
    const project = defaultProject();
    project.headers = [
      { id: "1", name: "Authorization", value: "Bearer secret", enabled: true, sensitive: false },
      { id: "2", name: "Accept-Language", value: "es-CL", enabled: true, sensitive: false },
      { id: "3", name: "X-Client-Key", value: "private", enabled: true, sensitive: true },
    ];
    expect(sanitizeProjectForStorage(project).headers.map((header) => header.value)).toEqual(["", "es-CL", ""]);
  });
});

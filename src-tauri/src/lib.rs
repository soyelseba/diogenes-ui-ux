use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Local, Utc};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;
use wait_timeout::ChildExt;

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_SECONDS: u64 = 45;
const MAX_MANUAL_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_LIBRARY_MANUAL_IMAGE_BYTES: usize = 128 * 1024 * 1024;
const MAX_LIBRARY_JSON_BYTES: u64 = 192 * 1024 * 1024;
const MAX_PROJECT_JSON_BYTES: u64 = MAX_LIBRARY_JSON_BYTES;
const MAX_MANUAL_IMAGE_SIDE: usize = 16_384;
const MAX_MANUAL_IMAGE_PIXELS: usize = 50_000_000;

fn default_capture_mode() -> String {
    "automatic".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeaderEntry {
    id: String,
    name: String,
    value: String,
    enabled: bool,
    #[serde(default)]
    sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteDefinition {
    id: String,
    label: String,
    path: String,
    method: String,
    body: String,
    notes: String,
    enabled: bool,
    #[serde(default = "default_capture_mode")]
    capture_mode: String,
    #[serde(default)]
    manual_capture: Option<ManualCapture>,
    last_status_code: Option<u16>,
    last_captured_at: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualCapture {
    file_name: String,
    mime_type: String,
    data_url: String,
    added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewport {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    name: String,
    base_url: String,
    output_dir: String,
    viewport: Viewport,
    wait_ms: u64,
    headers: Vec<HeaderEntry>,
    routes: Vec<RouteDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SiteProject {
    id: String,
    created_at: String,
    updated_at: String,
    last_captured_at: Option<String>,
    last_capture_dir: Option<String>,
    last_capture_status: String,
    #[serde(flatten)]
    project: ProjectConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLibrary {
    version: u8,
    active_site_id: String,
    sites: Vec<SiteProject>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteCaptureResult {
    id: String,
    label: String,
    url: String,
    method: String,
    capture_mode: String,
    status_code: Option<u16>,
    duration_ms: u128,
    content_type: Option<String>,
    folder: String,
    screenshot_path: Option<String>,
    response_path: Option<String>,
    markdown_path: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    session_dir: String,
    captured_at: String,
    successful: usize,
    failed: usize,
    browser: Option<String>,
    routes: Vec<RouteCaptureResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseMetadata {
    url: String,
    method: String,
    status_code: u16,
    duration_ms: u128,
    content_type: Option<String>,
    request_headers: BTreeMap<String, String>,
    response_headers: BTreeMap<String, String>,
    body_file: String,
    body_bytes: usize,
    truncated: bool,
    visual_capture: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStatus {
    available: bool,
    name: Option<String>,
    path: Option<String>,
}

struct HttpArtifact {
    status: u16,
    duration_ms: u128,
    content_type: Option<String>,
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;

    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            separator = false;
        } else if !separator && !slug.is_empty() {
            slug.push('-');
            separator = true;
        }
    }

    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "route".into()
    } else {
        slug.into()
    }
}

fn normalize_url(base_url: &str, route_path: &str) -> Result<String, String> {
    if route_path.starts_with("http://") || route_path.starts_with("https://") {
        return reqwest::Url::parse(route_path)
            .map(|url| url.to_string())
            .map_err(|error| format!("URL inválida: {error}"));
    }

    let mut base = base_url.trim().to_string();
    if !base.ends_with('/') {
        base.push('/');
    }

    reqwest::Url::parse(&base)
        .and_then(|url| url.join(route_path.trim_start_matches('/')))
        .map(|url| url.to_string())
        .map_err(|error| format!("No se pudo construir la URL: {error}"))
}

fn decode_manual_capture(capture: &ManualCapture) -> Result<(Vec<u8>, &'static str), String> {
    let extension = match capture.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("La captura manual debe ser PNG, JPEG o WebP".into()),
    };
    let (metadata, payload) = capture
        .data_url
        .split_once(',')
        .ok_or_else(|| "La captura manual no contiene un data URL válido".to_string())?;
    if metadata != format!("data:{};base64", capture.mime_type) {
        return Err("El tipo declarado de la captura manual no coincide con sus datos".into());
    }
    if payload.len() > MAX_MANUAL_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("La captura manual supera el límite de 12 MiB".into());
    }
    let bytes = BASE64
        .decode(payload)
        .map_err(|_| "La captura manual contiene base64 inválido".to_string())?;
    if bytes.len() > MAX_MANUAL_IMAGE_BYTES {
        return Err("La captura manual supera el límite de 12 MiB".into());
    }
    let signature_matches = match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !signature_matches {
        return Err("El contenido de la captura manual no coincide con su formato".into());
    }
    let dimensions = imagesize::blob_size(&bytes)
        .map_err(|_| "No se pudieron validar las dimensiones de la captura manual".to_string())?;
    if dimensions.width == 0
        || dimensions.height == 0
        || dimensions.width > MAX_MANUAL_IMAGE_SIDE
        || dimensions.height > MAX_MANUAL_IMAGE_SIDE
        || dimensions
            .width
            .checked_mul(dimensions.height)
            .is_none_or(|pixels| pixels > MAX_MANUAL_IMAGE_PIXELS)
    {
        return Err("La captura manual supera 16.384 px por lado o 50 megapíxeles".into());
    }
    Ok((bytes, extension))
}

fn save_manual_capture(route: &RouteDefinition, folder: &Path) -> Result<(String, String), String> {
    let capture = route
        .manual_capture
        .as_ref()
        .ok_or_else(|| "La ruta manual no tiene una imagen adjunta".to_string())?;
    let (bytes, extension) = decode_manual_capture(capture)?;
    let file_name = format!("screenshot.{extension}");
    fs::write(folder.join(&file_name), bytes)
        .map_err(|error| format!("No se pudo guardar la captura manual: {error}"))?;
    Ok((file_name, capture.mime_type.clone()))
}

fn validate_project_manual_images(project: &ProjectConfig) -> Result<(), String> {
    for capture in project
        .routes
        .iter()
        .filter_map(|route| route.manual_capture.as_ref())
    {
        decode_manual_capture(capture)?;
    }
    Ok(())
}

fn validate_library_manual_images(library: &ProjectLibrary) -> Result<(), String> {
    for site in &library.sites {
        validate_project_manual_images(&site.project)?;
    }
    Ok(())
}

#[tauri::command]
fn validate_manual_image(capture: ManualCapture) -> Result<(), String> {
    decode_manual_capture(&capture).map(|_| ())
}

fn redact_header(name: &str, value: &str) -> String {
    let normalized = name.trim().to_ascii_lowercase();
    let sensitive = [
        "authorization",
        "authenticate",
        "cookie",
        "api-key",
        "api_key",
        "token",
        "secret",
    ];
    if sensitive.iter().any(|item| normalized.contains(item)) {
        "[REDACTED]".into()
    } else {
        value.into()
    }
}

fn redact_project_header(header: &HeaderEntry) -> String {
    if header.sensitive {
        "[REDACTED]".into()
    } else {
        redact_header(&header.name, &header.value)
    }
}

fn body_extension(content_type: Option<&str>) -> &'static str {
    match content_type
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        value if value.contains("application/json") => "json",
        value if value.contains("text/html") => "html",
        value if value.contains("application/xml") || value.contains("text/xml") => "xml",
        value if value.contains("text/css") => "css",
        value if value.contains("javascript") => "js",
        _ => "txt",
    }
}

fn header_map(entries: &[HeaderEntry]) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for header in entries
        .iter()
        .filter(|entry| entry.enabled && !entry.name.trim().is_empty())
    {
        let name = HeaderName::from_bytes(header.name.trim().as_bytes())
            .map_err(|_| format!("Header inválido: {}", header.name))?;
        let value = HeaderValue::from_str(header.value.trim())
            .map_err(|_| format!("Valor inválido para el header {}", header.name))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn response_headers(response: &Response) -> BTreeMap<String, String> {
    response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                redact_header(name.as_str(), value.to_str().unwrap_or("[valor binario]")),
            )
        })
        .collect()
}

fn save_http_artifact(
    client: &Client,
    project: &ProjectConfig,
    route: &RouteDefinition,
    url: &str,
    folder: &Path,
) -> Result<HttpArtifact, String> {
    let headers = header_map(&project.headers)?;
    let method = reqwest::Method::from_bytes(route.method.as_bytes())
        .map_err(|_| format!("Método HTTP no soportado: {}", route.method))?;
    let mut request = client.request(method, url).headers(headers);
    if route.method.eq_ignore_ascii_case("POST") && !route.body.is_empty() {
        request = request.body(route.body.clone());
    }

    let started = Instant::now();
    let response = request
        .send()
        .map_err(|error| format!("Falló la solicitud HTTP: {error}"))?;
    let duration_ms = started.elapsed().as_millis();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let headers = response_headers(&response);
    let mut bytes = Vec::with_capacity(MAX_BODY_BYTES + 1);
    response
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("No se pudo leer la respuesta: {error}"))?;
    let truncated = bytes.len() > MAX_BODY_BYTES;
    let stored_bytes = &bytes[..bytes.len().min(MAX_BODY_BYTES)];
    let body_name = format!("body.{}", body_extension(content_type.as_deref()));
    fs::write(folder.join(&body_name), stored_bytes)
        .map_err(|error| format!("No se pudo guardar {body_name}: {error}"))?;

    let request_headers = project
        .headers
        .iter()
        .filter(|header| header.enabled && !header.name.trim().is_empty())
        .map(|header| (header.name.clone(), redact_project_header(header)))
        .collect();
    let metadata = ResponseMetadata {
        url: url.into(),
        method: route.method.clone(),
        status_code: status,
        duration_ms,
        content_type: content_type.clone(),
        request_headers,
        response_headers: headers,
        body_file: body_name,
        body_bytes: stored_bytes.len(),
        truncated,
        visual_capture: if route.method == "GET" {
            "GET navigation in a clean browser profile without custom headers".into()
        } else {
            "No screenshot generated for non-GET request".into()
        },
    };
    let response_path = folder.join("response.json");
    let json = serde_json::to_string_pretty(&metadata)
        .map_err(|error| format!("No se pudo serializar la respuesta: {error}"))?;
    fs::write(&response_path, json)
        .map_err(|error| format!("No se pudo guardar response.json: {error}"))?;

    Ok(HttpArtifact {
        status,
        duration_ms,
        content_type,
    })
}

fn path_candidates() -> Vec<(String, PathBuf)> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("DIOGENES_BROWSER_PATH") {
        candidates.push(("Navegador configurado".into(), PathBuf::from(path)));
    }

    #[cfg(target_os = "windows")]
    {
        let vars = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"];
        for variable in vars {
            if let Ok(root) = std::env::var(variable) {
                candidates.push((
                    "Google Chrome".into(),
                    Path::new(&root).join("Google/Chrome/Application/chrome.exe"),
                ));
                candidates.push((
                    "Microsoft Edge".into(),
                    Path::new(&root).join("Microsoft/Edge/Application/msedge.exe"),
                ));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push((
            "Google Chrome".into(),
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ));
        candidates.push((
            "Microsoft Edge".into(),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        for name in [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
        ] {
            candidates.push(("Chromium".into(), PathBuf::from(name)));
        }
    }

    candidates
}

fn find_browser() -> Option<(String, PathBuf)> {
    path_candidates()
        .into_iter()
        .find(|(_, path)| path.is_file())
}

fn capture_screenshot(
    browser: &Path,
    url: &str,
    screenshot_path: &Path,
    profile_path: &Path,
    viewport: &Viewport,
    wait_ms: u64,
) -> Result<(), String> {
    fs::create_dir_all(profile_path)
        .map_err(|error| format!("No se pudo preparar el perfil temporal: {error}"))?;

    let mut child = Command::new(browser)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--hide-scrollbars")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-data-dir={}", profile_path.display()))
        .arg(format!(
            "--window-size={},{}",
            viewport.width, viewport.height
        ))
        .arg(format!("--virtual-time-budget={}", wait_ms.max(100)))
        .arg(format!("--screenshot={}", screenshot_path.display()))
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("No se pudo iniciar el navegador: {error}"))?;

    let timeout = Duration::from_secs(REQUEST_TIMEOUT_SECONDS);
    let status = child
        .wait_timeout(timeout)
        .map_err(|error| format!("No se pudo esperar al navegador: {error}"))?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "El navegador excedió el tiempo límite de {REQUEST_TIMEOUT_SECONDS} s"
        ));
    }

    if !screenshot_path.is_file() {
        return Err("El navegador terminó sin producir screenshot.png".into());
    }
    Ok(())
}

fn route_markdown(route: &RouteDefinition, result: &RouteCaptureResult) -> String {
    let status = result
        .status_code
        .map(|value| value.to_string())
        .unwrap_or_else(|| "Sin respuesta".into());
    let screenshot = result
        .screenshot_path
        .as_deref()
        .and_then(|path| path.rsplit('/').next())
        .map(|file| format!("![Pantallazo de la ruta](./{file})"))
        .unwrap_or_else(|| "_No se generó un pantallazo para esta ruta._".into());
    let notes = if route.notes.trim().is_empty() {
        "Sin notas."
    } else {
        route.notes.trim()
    };
    let error = result.error.as_deref().unwrap_or("Ninguno");

    let files = if route.capture_mode == "manual" {
        "- `screenshot.*`: imagen adjuntada manualmente por el usuario."
    } else {
        "- `response.json`: metadatos HTTP y headers.\n- `body.*`: cuerpo crudo de la respuesta (máximo 5 MiB).\n- `screenshot.png`: render del navegador, cuando aplica."
    };

    format!(
        "# {}\n\n- **URL o referencia:** `{}`\n- **Modo de captura:** `{}`\n- **Método:** `{}`\n- **Estado HTTP:** `{}`\n- **Duración:** `{} ms`\n- **Content-Type:** `{}`\n- **Error de captura:** {}\n\n## Intención de la ruta\n\n{}\n\n## Archivos\n\n{}\n\n## Pantallazo\n\n{}\n",
        route.label,
        result.url,
        if route.capture_mode == "manual" { "Manual" } else { "Automática" },
        result.method,
        status,
        result.duration_ms,
        result.content_type.as_deref().unwrap_or("Desconocido"),
        error,
        notes,
        files,
        screenshot,
    )
}

fn root_markdown(project: &ProjectConfig, result: &CaptureResult) -> String {
    let mut rows = String::new();
    for route in &result.routes {
        let state = if route.error.is_none() {
            "OK"
        } else {
            "Revisar"
        };
        let status = route
            .status_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "—".into());
        rows.push_str(&format!(
            "| [{}](./{}/README.md) | `{}` | {} | {} |\n",
            route.label,
            route.folder,
            if route.capture_mode == "manual" {
                "MANUAL"
            } else {
                &route.method
            },
            status,
            state
        ));
    }

    format!(
        "# Contexto web: {}\n\nRecopilación autocontenida producida por Diógenes para lectura humana y de agentes. Puede combinar rutas rastreadas automáticamente con pantallazos adjuntados manualmente.\n\n- **Sitio base:** `{}`\n- **Capturado:** `{}`\n- **Viewport:** `{} × {} px`\n- **Rutas:** {}\n- **Navegador:** {}\n\n## Cómo leer este paquete\n\n1. Empieza por esta tabla para conocer la cobertura.\n2. Abre el `README.md` de cada ruta para ver intención, estado y pantallazo.\n3. En rutas automáticas, usa `response.json` y `body.*` para revisar la respuesta original.\n4. Usa `manifest.json` si necesitas procesar el conjunto automáticamente.\n\n## Rutas\n\n| Ruta | Método | HTTP | Captura |\n|---|---:|---:|---:|\n{}\n> Los valores de headers sensibles (`Authorization`, `Cookie`, `X-API-Key`) se redactan en la exportación. Los headers personalizados sólo se usan en solicitudes automáticas; el navegador headless navega sin ellos.\n",
        project.name,
        project.base_url,
        result.captured_at,
        project.viewport.width,
        project.viewport.height,
        result.routes.len(),
        result.browser.as_deref().unwrap_or("No disponible"),
        rows,
    )
}

fn collect_sync(project: ProjectConfig) -> Result<CaptureResult, String> {
    validate_project(&project)?;

    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let session_dir = Path::new(&project.output_dir)
        .join(slugify(&project.name))
        .join(format!("capture-{timestamp}"));
    let routes_dir = session_dir.join("routes");
    fs::create_dir_all(&routes_dir)
        .map_err(|error| format!("No se pudo crear la exportación: {error}"))?;

    let browser = project
        .routes
        .iter()
        .any(|route| route.enabled && route.capture_mode == "automatic" && route.method == "GET")
        .then(find_browser)
        .flatten();
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .user_agent("Diogenes-Web-Collector/0.1")
        .build()
        .map_err(|error| format!("No se pudo preparar el cliente HTTP: {error}"))?;
    let mut results = Vec::new();

    for (index, route) in project
        .routes
        .iter()
        .filter(|route| route.enabled)
        .enumerate()
    {
        let folder_name = format!("{:03}-{}", index + 1, slugify(&route.label));
        let folder = routes_dir.join(&folder_name);
        fs::create_dir_all(&folder)
            .map_err(|error| format!("No se pudo crear la carpeta de ruta: {error}"))?;
        if route.capture_mode == "manual" {
            let url = if project.base_url.trim().is_empty() {
                route.path.clone()
            } else {
                normalize_url(&project.base_url, &route.path).unwrap_or_else(|_| route.path.clone())
            };
            let mut result = RouteCaptureResult {
                id: route.id.clone(),
                label: route.label.clone(),
                url,
                method: route.method.clone(),
                capture_mode: route.capture_mode.clone(),
                status_code: None,
                duration_ms: 0,
                content_type: None,
                folder: format!("routes/{folder_name}"),
                screenshot_path: None,
                response_path: None,
                markdown_path: format!("routes/{folder_name}/README.md"),
                error: None,
            };
            match save_manual_capture(route, &folder) {
                Ok((file_name, mime_type)) => {
                    result.content_type = Some(mime_type);
                    result.screenshot_path = Some(format!("routes/{folder_name}/{file_name}"));
                }
                Err(error) => result.error = Some(error),
            }
            fs::write(folder.join("README.md"), route_markdown(route, &result))
                .map_err(|error| format!("No se pudo guardar el Markdown de ruta: {error}"))?;
            results.push(result);
            continue;
        }
        let url = match normalize_url(&project.base_url, &route.path) {
            Ok(url) => url,
            Err(error) => {
                let result = RouteCaptureResult {
                    id: route.id.clone(),
                    label: route.label.clone(),
                    url: route.path.clone(),
                    method: route.method.clone(),
                    capture_mode: route.capture_mode.clone(),
                    status_code: None,
                    duration_ms: 0,
                    content_type: None,
                    folder: format!("routes/{folder_name}"),
                    screenshot_path: None,
                    response_path: None,
                    markdown_path: format!("routes/{folder_name}/README.md"),
                    error: Some(error),
                };
                fs::write(folder.join("README.md"), route_markdown(route, &result))
                    .map_err(|e| e.to_string())?;
                results.push(result);
                continue;
            }
        };

        let mut result = RouteCaptureResult {
            id: route.id.clone(),
            label: route.label.clone(),
            url: url.clone(),
            method: route.method.clone(),
            capture_mode: route.capture_mode.clone(),
            status_code: None,
            duration_ms: 0,
            content_type: None,
            folder: format!("routes/{folder_name}"),
            screenshot_path: None,
            response_path: None,
            markdown_path: format!("routes/{folder_name}/README.md"),
            error: None,
        };

        match save_http_artifact(&client, &project, route, &url, &folder) {
            Ok(artifact) => {
                result.status_code = Some(artifact.status);
                result.duration_ms = artifact.duration_ms;
                result.content_type = artifact.content_type;
                result.response_path = Some(format!("routes/{folder_name}/response.json"));
            }
            Err(error) => result.error = Some(error),
        }

        if route.method.eq_ignore_ascii_case("GET") {
            match browser.as_ref() {
                Some((_, browser_path)) => {
                    let screenshot_path = folder.join("screenshot.png");
                    let profile_path = folder.join(".browser-profile");
                    let screenshot = capture_screenshot(
                        browser_path,
                        &url,
                        &screenshot_path,
                        &profile_path,
                        &project.viewport,
                        project.wait_ms,
                    );
                    let _ = fs::remove_dir_all(&profile_path);
                    match screenshot {
                        Ok(()) => {
                            result.screenshot_path =
                                Some(format!("routes/{folder_name}/screenshot.png"))
                        }
                        Err(error) => {
                            result.error = Some(match result.error.take() {
                                Some(previous) => format!("{previous}; {error}"),
                                None => error,
                            });
                        }
                    }
                }
                None => {
                    result.error =
                        Some("No se encontró Chrome, Edge o Chromium para el pantallazo".into())
                }
            }
        }

        fs::write(folder.join("README.md"), route_markdown(route, &result))
            .map_err(|error| format!("No se pudo guardar el Markdown de ruta: {error}"))?;
        results.push(result);
    }

    let captured_at: DateTime<Utc> = Utc::now();
    let successful = results.iter().filter(|route| route.error.is_none()).count();
    let failed = results.len() - successful;
    let browser_name = browser.as_ref().map(|(name, _)| name.clone());
    let result = CaptureResult {
        session_dir: session_dir.display().to_string(),
        captured_at: captured_at.to_rfc3339(),
        successful,
        failed,
        browser: browser_name,
        routes: results,
    };
    let mut portable_manifest = result.clone();
    portable_manifest.session_dir = ".".into();
    let manifest = serde_json::to_string_pretty(&portable_manifest)
        .map_err(|error| format!("No se pudo serializar el manifiesto: {error}"))?;
    fs::write(session_dir.join("manifest.json"), manifest)
        .map_err(|error| format!("No se pudo guardar manifest.json: {error}"))?;
    fs::write(
        session_dir.join("README.md"),
        root_markdown(&project, &result),
    )
    .map_err(|error| format!("No se pudo guardar README.md: {error}"))?;
    Ok(result)
}

#[tauri::command]
async fn collect_project(project: ProjectConfig) -> Result<CaptureResult, String> {
    tauri::async_runtime::spawn_blocking(move || collect_sync(project))
        .await
        .map_err(|error| format!("La tarea de captura se interrumpió: {error}"))?
}

#[tauri::command]
fn browser_status() -> BrowserStatus {
    match find_browser() {
        Some((name, path)) => BrowserStatus {
            available: true,
            name: Some(name),
            path: Some(path.display().to_string()),
        },
        None => BrowserStatus {
            available: false,
            name: None,
            path: None,
        },
    }
}

#[tauri::command]
fn save_project_file(path: String, mut site: SiteProject) -> Result<(), String> {
    validate_project_definition(&site.project)?;
    validate_project_manual_images(&site.project)?;
    for header in &mut site.project.headers {
        if header.sensitive || redact_header(&header.name, &header.value) == "[REDACTED]" {
            header.value.clear();
        }
    }
    let json = serde_json::to_string_pretty(&site)
        .map_err(|error| format!("No se pudo serializar el proyecto: {error}"))?;
    if json.len() as u64 > MAX_PROJECT_JSON_BYTES {
        return Err("El proyecto supera el límite de 192 MiB y no puede exportarse".into());
    }
    write_json_file(Path::new(&path), &json)
}

#[tauri::command]
fn load_project_file(path: String) -> Result<serde_json::Value, String> {
    let json = read_text_file_bounded(Path::new(&path), MAX_PROJECT_JSON_BYTES, "proyecto")?;
    if let Ok(site) = serde_json::from_str::<SiteProject>(&json) {
        validate_project_definition(&site.project)?;
        validate_project_manual_images(&site.project)?;
        return serde_json::to_value(site).map_err(|error| error.to_string());
    }
    let project: ProjectConfig = serde_json::from_str(&json)
        .map_err(|error| format!("El proyecto no es válido: {error}"))?;
    validate_project_definition(&project)?;
    validate_project_manual_images(&project)?;
    serde_json::to_value(project).map_err(|error| error.to_string())
}

fn validate_library(library: &ProjectLibrary) -> Result<(), String> {
    if library.version != 1 {
        return Err("La versión de la biblioteca no es compatible".into());
    }
    if library.sites.is_empty() || library.sites.len() > 100 {
        return Err("La biblioteca debe contener entre 1 y 100 sitios".into());
    }
    if !library
        .sites
        .iter()
        .any(|site| site.id == library.active_site_id)
    {
        return Err("El sitio activo no existe en la biblioteca".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut manual_bytes = 0_usize;
    for site in &library.sites {
        if site.id.trim().is_empty() || !ids.insert(&site.id) {
            return Err("Cada sitio debe tener un identificador único".into());
        }
        validate_project_definition(&site.project)?;
        for capture in site
            .project
            .routes
            .iter()
            .filter_map(|route| route.manual_capture.as_ref())
        {
            let payload_len = capture
                .data_url
                .split_once(',')
                .map(|(_, payload)| payload.len())
                .unwrap_or(capture.data_url.len());
            manual_bytes = manual_bytes
                .checked_add(payload_len.saturating_mul(3) / 4)
                .ok_or_else(|| {
                    "La biblioteca de imágenes manuales es demasiado grande".to_string()
                })?;
        }
        if !matches!(
            site.last_capture_status.as_str(),
            "never" | "success" | "partial"
        ) {
            return Err("El estado de captura del sitio no es válido".into());
        }
    }
    if manual_bytes > MAX_LIBRARY_MANUAL_IMAGE_BYTES {
        return Err("La biblioteca admite hasta 128 MiB de capturas manuales".into());
    }
    Ok(())
}

fn redact_library_secrets(library: &mut ProjectLibrary) {
    for site in &mut library.sites {
        for header in &mut site.project.headers {
            if header.sensitive || redact_header(&header.name, &header.value) == "[REDACTED]" {
                header.value.clear();
            }
        }
    }
}

fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No se pudo resolver el directorio local: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("No se pudo crear el directorio local: {error}"))?;
    Ok(directory.join("diogenes-library.json"))
}

fn write_library(path: &Path, library: &ProjectLibrary) -> Result<(), String> {
    let json = serde_json::to_string_pretty(library)
        .map_err(|error| format!("No se pudo serializar la biblioteca: {error}"))?;
    if json.len() as u64 > MAX_LIBRARY_JSON_BYTES {
        return Err("La biblioteca supera el límite de 192 MiB y no puede guardarse".into());
    }
    write_json_file(path, &json)
}

fn write_json_file(path: &Path, json: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("No se pudo preparar el respaldo local: {error}"))?;
    file.write_all(json.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("No se pudo completar el respaldo local: {error}"))?;
    if path.is_file() {
        fs::copy(path, &backup)
            .map_err(|error| format!("No se pudo preservar la copia anterior: {error}"))?;
        fs::remove_file(path)
            .map_err(|error| format!("No se pudo reemplazar la biblioteca anterior: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.is_file() {
            let _ = fs::copy(&backup, path);
        }
        return Err(format!("No se pudo activar el nuevo respaldo: {error}"));
    }
    Ok(())
}

fn read_text_file_bounded(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("No se pudo inspeccionar el {label}: {error}"))?;
    if metadata.len() > max_bytes {
        return Err(format!("El archivo de {label} supera el límite permitido"));
    }
    fs::read_to_string(path).map_err(|error| format!("No se pudo leer el {label}: {error}"))
}

fn read_library_file(path: &Path) -> Result<ProjectLibrary, String> {
    let json = read_text_file_bounded(path, MAX_LIBRARY_JSON_BYTES, "respaldo de biblioteca")?;
    let library: ProjectLibrary = serde_json::from_str(&json)
        .map_err(|error| format!("{} no es una biblioteca válida: {error}", path.display()))?;
    validate_library(&library)?;
    validate_library_manual_images(&library)?;
    Ok(library)
}

fn read_library_with_backup(path: &Path) -> Result<Option<ProjectLibrary>, String> {
    let backup = path.with_extension("json.bak");
    if path.is_file() {
        match read_library_file(path) {
            Ok(library) => return Ok(Some(library)),
            Err(primary_error) if backup.is_file() => {
                return read_library_file(&backup).map(Some).map_err(|backup_error| {
                    format!("Fallaron el respaldo principal ({primary_error}) y su copia ({backup_error})")
                });
            }
            Err(error) => return Err(error),
        }
    }
    if backup.is_file() {
        return read_library_file(&backup).map(Some);
    }
    Ok(None)
}

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<Option<ProjectLibrary>, String> {
    let path = library_path(&app)?;
    read_library_with_backup(&path)
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, mut library: ProjectLibrary) -> Result<String, String> {
    validate_library(&library)?;
    validate_library_manual_images(&library)?;
    redact_library_secrets(&mut library);
    let path = library_path(&app)?;
    write_library(&path, &library)?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn export_library_file(path: String, mut library: ProjectLibrary) -> Result<(), String> {
    validate_library(&library)?;
    validate_library_manual_images(&library)?;
    redact_library_secrets(&mut library);
    write_library(Path::new(&path), &library)
}

#[tauri::command]
fn import_library_file(path: String) -> Result<ProjectLibrary, String> {
    read_library_file(Path::new(&path))
}

fn validate_project(project: &ProjectConfig) -> Result<(), String> {
    validate_project_definition(project)?;
    if project.name.trim().is_empty() || project.output_dir.trim().is_empty() {
        return Err("El nombre y la carpeta de exportación son obligatorios".into());
    }
    let active_routes: Vec<_> = project
        .routes
        .iter()
        .filter(|route| route.enabled)
        .collect();
    if active_routes.is_empty() {
        return Err("El proyecto debe contener al menos una ruta activa".into());
    }
    if active_routes
        .iter()
        .any(|route| route.capture_mode == "manual" && route.manual_capture.is_none())
    {
        return Err("Cada ruta manual activa necesita una imagen adjunta".into());
    }
    if active_routes
        .iter()
        .any(|route| route.capture_mode == "automatic")
    {
        let url = reqwest::Url::parse(&project.base_url)
            .map_err(|_| "La URL base del proyecto no es válida".to_string())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("La URL base debe usar HTTP o HTTPS".into());
        }
    }
    Ok(())
}

fn validate_project_definition(project: &ProjectConfig) -> Result<(), String> {
    if project.name.trim().is_empty() {
        return Err("El proyecto necesita un nombre".into());
    }
    if project.viewport.width < 320
        || project.viewport.height < 320
        || project.viewport.width > 7680
        || project.viewport.height > 7680
    {
        return Err("El viewport debe estar entre 320 y 7680 px por lado".into());
    }
    if project.wait_ms > 60_000 || project.routes.len() > 500 {
        return Err("La configuración del proyecto supera los límites permitidos".into());
    }
    let mut route_ids = std::collections::HashSet::new();
    if project.routes.iter().any(|route| {
        route.id.trim().is_empty()
            || !route_ids.insert(&route.id)
            || !matches!(route.method.as_str(), "GET" | "POST")
            || !matches!(route.capture_mode.as_str(), "automatic" | "manual")
            || route.path.trim().is_empty()
    }) {
        return Err("Las rutas deben tener ID único, URL y método GET o POST".into());
    }
    let mut project_manual_bytes = 0_usize;
    for capture in project
        .routes
        .iter()
        .filter_map(|route| route.manual_capture.as_ref())
    {
        if !matches!(
            capture.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        ) || capture.file_name.trim().is_empty()
            || capture.data_url.len() > MAX_MANUAL_IMAGE_BYTES * 4 / 3 + 64
            || !capture
                .data_url
                .starts_with(&format!("data:{};base64,", capture.mime_type))
        {
            return Err("La captura manual adjunta no es válida".into());
        }
        let payload_len = capture
            .data_url
            .split_once(',')
            .map(|(_, payload)| payload.len())
            .unwrap_or(capture.data_url.len());
        project_manual_bytes = project_manual_bytes
            .checked_add(payload_len.saturating_mul(3) / 4)
            .ok_or_else(|| "El proyecto de imágenes manuales es demasiado grande".to_string())?;
    }
    if project_manual_bytes > MAX_LIBRARY_MANUAL_IMAGE_BYTES {
        return Err("El proyecto admite hasta 128 MiB de capturas manuales".into());
    }
    let mut header_ids = std::collections::HashSet::new();
    if project
        .headers
        .iter()
        .any(|header| header.id.trim().is_empty() || !header_ids.insert(&header.id))
    {
        return Err("Los headers deben tener identificadores únicos".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            collect_project,
            browser_status,
            validate_manual_image,
            save_project_file,
            load_project_file,
            load_library,
            save_library,
            export_library_file,
            import_library_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn creates_safe_folder_names() {
        assert_eq!(slugify("Inicio / Productos Ñandú"), "inicio-productos-and");
        assert_eq!(slugify("***"), "route");
    }

    #[test]
    fn joins_relative_routes() {
        assert_eq!(
            normalize_url("https://example.com/app", "/contacto").unwrap(),
            "https://example.com/app/contacto"
        );
    }

    #[test]
    fn redacts_secrets_only() {
        assert_eq!(
            redact_header("Authorization", "Bearer secret"),
            "[REDACTED]"
        );
        assert_eq!(redact_header("Set-Cookie", "session=secret"), "[REDACTED]");
        assert_eq!(redact_header("Accept-Language", "es-CL"), "es-CL");
    }

    #[test]
    fn chooses_body_extensions() {
        assert_eq!(
            body_extension(Some("application/json; charset=utf-8")),
            "json"
        );
        assert_eq!(body_extension(Some("text/html")), "html");
        assert_eq!(body_extension(None), "txt");
        assert!(MAX_PROJECT_JSON_BYTES as usize > MAX_LIBRARY_MANUAL_IMAGE_BYTES * 4 / 3);
    }

    #[test]
    fn rejects_manual_images_with_unsafe_dimensions() {
        let mut png_header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png_header.extend_from_slice(&20_000_u32.to_be_bytes());
        png_header.extend_from_slice(&20_000_u32.to_be_bytes());
        let capture = ManualCapture {
            file_name: "enorme.png".into(),
            mime_type: "image/png".into(),
            data_url: format!("data:image/png;base64,{}", BASE64.encode(png_header)),
            added_at: "2026-08-30T00:00:00Z".into(),
        };
        assert!(decode_manual_capture(&capture)
            .unwrap_err()
            .contains("50 megapíxeles"));
    }

    #[test]
    fn collects_a_real_local_route() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut request = [0_u8; 2048];
                        let _ = stream.read(&mut request);
                        let body = "<!doctype html><html><body style='background:#15201a;color:#dfff68'><h1>Contexto listo</h1></body></html>";
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(), body
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        let output = std::env::temp_dir().join(format!(
            "diogenes-collector-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis()
        ));
        let browser_available = find_browser().is_some();
        let result = collect_sync(ProjectConfig {
            name: "Prueba local".into(),
            base_url: format!("http://{address}"),
            output_dir: output.display().to_string(),
            viewport: Viewport {
                width: 800,
                height: 600,
            },
            wait_ms: 200,
            headers: vec![],
            routes: vec![RouteDefinition {
                id: "home".into(),
                label: "Inicio".into(),
                path: "/".into(),
                method: "GET".into(),
                body: String::new(),
                notes: "Ruta de prueba".into(),
                enabled: true,
                capture_mode: "automatic".into(),
                manual_capture: None,
                last_status_code: None,
                last_captured_at: None,
                last_error: None,
            }],
        })
        .unwrap();

        let session = PathBuf::from(&result.session_dir);
        assert!(session.join("README.md").is_file());
        assert!(session.join("manifest.json").is_file());
        assert!(session.join("routes/001-inicio/body.html").is_file());
        assert!(session.join("routes/001-inicio/response.json").is_file());
        let index = fs::read_to_string(session.join("README.md")).unwrap();
        assert!(index.contains("Contexto web: Prueba local"));
        assert!(index.contains("routes/001-inicio/README.md"));
        let manifest = fs::read_to_string(session.join("manifest.json")).unwrap();
        assert!(manifest.contains("\"sessionDir\": \".\""));
        assert!(manifest.contains("routes/001-inicio/response.json"));
        assert!(!manifest.contains(&output.display().to_string()));
        if browser_available {
            let screenshot = fs::read(session.join("routes/001-inicio/screenshot.png")).unwrap();
            assert!(screenshot.len() > 1_000);
            assert_eq!(&screenshot[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(result.successful, 1);
        }

        fs::remove_dir_all(&output).unwrap();
    }

    #[test]
    fn exports_a_manual_capture_without_http_or_browser() {
        let output = std::env::temp_dir().join(format!(
            "diogenes-manual-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis()
        ));
        let result = collect_sync(ProjectConfig {
            name: "Captura manual".into(),
            base_url: String::new(),
            output_dir: output.display().to_string(),
            viewport: Viewport {
                width: 800,
                height: 600,
            },
            wait_ms: 200,
            headers: vec![],
            routes: vec![RouteDefinition {
                id: "manual".into(),
                label: "Diseño entregado".into(),
                path: "/inicio".into(),
                method: "GET".into(),
                body: String::new(),
                notes: "Referencia visual".into(),
                enabled: true,
                capture_mode: "manual".into(),
                manual_capture: Some(ManualCapture {
                    file_name: "inicio.png".into(),
                    mime_type: "image/png".into(),
                    data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                    added_at: "2026-08-30T00:00:00Z".into(),
                }),
                last_status_code: None,
                last_captured_at: None,
                last_error: None,
            }],
        })
        .unwrap();

        let session = PathBuf::from(&result.session_dir);
        assert_eq!(result.successful, 1);
        assert!(result.browser.is_none());
        let route = &result.routes[0];
        assert!(session
            .join(route.screenshot_path.as_ref().unwrap())
            .is_file());
        assert!(route.response_path.is_none());
        let markdown = fs::read_to_string(session.join(&route.markdown_path)).unwrap();
        assert!(markdown.contains("**Modo de captura:** `Manual`"));
        assert!(markdown.contains("./screenshot.png"));
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn validates_and_redacts_a_library_backup() {
        let project = ProjectConfig {
            name: "Sitio".into(),
            base_url: String::new(),
            output_dir: String::new(),
            viewport: Viewport {
                width: 1440,
                height: 900,
            },
            wait_ms: 1000,
            headers: vec![HeaderEntry {
                id: "auth".into(),
                name: "X-Client-Key".into(),
                value: "Bearer secret".into(),
                enabled: true,
                sensitive: true,
            }],
            routes: vec![RouteDefinition {
                id: "home".into(),
                label: "Inicio".into(),
                path: "/".into(),
                method: "GET".into(),
                body: String::new(),
                notes: String::new(),
                enabled: true,
                capture_mode: "manual".into(),
                manual_capture: Some(ManualCapture {
                    file_name: "inicio.png".into(),
                    mime_type: "image/png".into(),
                    data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                    added_at: "2026-08-30T00:00:00Z".into(),
                }),
                last_status_code: None,
                last_captured_at: None,
                last_error: None,
            }],
        };
        let mut library = ProjectLibrary {
            version: 1,
            active_site_id: "site-1".into(),
            sites: vec![SiteProject {
                id: "site-1".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                updated_at: "2026-08-30T00:00:00Z".into(),
                last_captured_at: None,
                last_capture_dir: None,
                last_capture_status: "never".into(),
                project,
            }],
        };
        validate_library(&library).unwrap();
        redact_library_secrets(&mut library);
        assert_eq!(library.sites[0].project.headers[0].value, "");
        let json = serde_json::to_value(&library).unwrap();
        assert_eq!(json["sites"][0]["name"], "Sitio");
        assert!(json["sites"][0].get("project").is_none());
        let restored: ProjectLibrary = serde_json::from_value(json).unwrap();
        assert_eq!(restored.sites[0].project.routes[0].label, "Inicio");
        let restored_capture = restored.sites[0].project.routes[0]
            .manual_capture
            .as_ref()
            .unwrap();
        assert_eq!(restored_capture.file_name, "inicio.png");
        assert_eq!(restored_capture.mime_type, "image/png");
        assert!(restored_capture
            .data_url
            .starts_with("data:image/png;base64,"));

        let output = std::env::temp_dir().join(format!(
            "diogenes-library-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis()
        ));
        fs::create_dir_all(&output).unwrap();
        let library_file = output.join("library.json");
        write_library(&library_file, &library).unwrap();
        library.sites[0].project.name = "Sitio actualizado".into();
        write_library(&library_file, &library).unwrap();
        assert!(output.join("library.json.bak").is_file());
        fs::write(&library_file, "{archivo dañado").unwrap();
        let recovered = read_library_with_backup(&library_file).unwrap().unwrap();
        assert_eq!(recovered.sites[0].project.name, "Sitio");
        write_library(&library_file, &library).unwrap();

        library.sites[0].last_capture_status = "success".into();
        library.sites[0].last_captured_at = Some("2026-08-30T01:00:00Z".into());
        let site_file = output.join("site.diogenes.json");
        save_project_file(site_file.display().to_string(), library.sites[0].clone()).unwrap();
        let imported = load_project_file(site_file.display().to_string()).unwrap();
        assert_eq!(imported["lastCaptureStatus"], "success");
        assert_eq!(imported["lastCapturedAt"], "2026-08-30T01:00:00Z");

        library.sites[0].project.routes.clear();
        validate_library(&library).unwrap();
        fs::remove_dir_all(output).unwrap();
    }
}

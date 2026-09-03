# Diógenes

Herramienta de escritorio para recopilar interfaces web como contexto durable para agentes: rutas, respuestas HTTP, pantallazos, notas y manifiestos navegables.

Está construida con SolidJS y Tauri v2. La captura ocurre localmente: Rust descarga cada respuesta y utiliza Chrome, Edge o Chromium en modo headless para producir imágenes PNG.

## Biblioteca local de sitios

Diógenes administra varios sitios desde una biblioteca local. Cada uno conserva de forma independiente su URL, rutas, headers, viewport, destino, última captura y estado de las rutas analizadas. Un sitio nuevo comienza con la URL vacía para que el usuario configure el dominio real.

La persistencia usa JSON versionado en el directorio privado de datos de Tauri (`diogenes-library.json`). Se eligió JSON en lugar de SQLite porque la biblioteca es pequeña, se guarda como un único documento y necesita ser portable e inspeccionable. Cada escritura se completa primero en un archivo temporal y conserva la versión anterior como `diogenes-library.json.bak`. La UI permite:

- Crear, cambiar, duplicar y eliminar sitios.
- Importar o exportar un sitio como `.diogenes.json`, incluyendo su historial de análisis.
- Respaldar o restaurar la biblioteca completa como JSON.
- Consultar cuántas rutas tiene cada sitio y cuáles ya fueron analizadas.

Los secretos de headers permanecen sólo en memoria y se eliminan tanto del archivo local como de los respaldos. Diógenes reconoce nombres habituales de autenticación y además permite marcar manualmente cualquier header como secreto.

## Capturas automáticas y manuales

Cada ruta puede usar uno de dos modos:

- **Automática:** Diógenes solicita la URL, conserva la respuesta HTTP y genera el pantallazo con Chrome, Edge o Chromium.
- **Manual:** el usuario pega desde el portapapeles, arrastra o selecciona una imagen PNG, JPEG o WebP. Diógenes no solicita la página y exporta la imagen directamente como referencia de esa ruta.

Las imágenes manuales se guardan dentro del JSON para que acompañen al sitio y a la biblioteca al importar o exportar. El límite es de 12 MiB por imagen y 128 MiB para la biblioteca completa; además se rechazan imágenes mayores de 16.384 px por lado o 50 megapíxeles. Una colección compuesta sólo por capturas manuales no necesita URL base ni navegador instalado.

## Qué exporta

Cada ejecución crea un paquete independiente:

```text
<destino>/
└── <proyecto>/
    └── capture-YYYYMMDD-HHMMSS-ms/
        ├── README.md
        ├── manifest.json
        └── routes/
            └── 001-pagina-principal/
                ├── README.md
                ├── response.json
                ├── body.html
                └── screenshot.*
```

- `README.md` contiene el índice y la guía de lectura para agentes.
- `manifest.json` permite procesar la recopilación automáticamente.
- Las rutas automáticas conservan metadatos HTTP, el cuerpo original hasta 5 MiB, notas y pantallazo.
- Las rutas manuales conservan notas y la imagen proporcionada, sin realizar solicitudes de red.
- Los valores de `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, headers de autenticación y cualquier header marcado como secreto se redactan del JSON exportado.
- Los secretos configurados se mantienen sólo en memoria durante la sesión: no se guardan en `localStorage` ni en el archivo de proyecto.

Los pantallazos se generan para solicitudes GET. Los headers personalizados se aplican a la solicitud HTTP, no a la navegación headless; esta limitación queda registrada también dentro del paquete.

## Desarrollo

Requisitos: Node.js, Rust y Chrome/Edge/Chromium instalado.

```powershell
npm install
npm run tauri dev
```

Si el navegador está en una ubicación no estándar, define `DIOGENES_BROWSER_PATH` con la ruta absoluta al ejecutable.

## Verificación

```powershell
npm test
npm run typecheck
npm run build
cd src-tauri
cargo test
cargo check
```

Para producir un instalador de escritorio:

```powershell
npm run tauri build
```

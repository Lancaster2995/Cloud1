# Relevo

App Android (APK) para trabajar con **varias sesiones de Claude a la vez, cada una con una cuenta distinta**, y **pasar un proyecto de una cuenta a otra** con todo su estado y avance hasta terminarlo.

- **Ventanas aisladas por cuenta**: hasta 8 cuentas. Cada una abre su propia ventana con el motor de Chrome (Android System WebView) y cookies separadas, como si fueran perfiles distintos de Chrome. Así puedes tener varias sesiones iniciadas al mismo tiempo, en pantalla dividida, en DeX o cambiando desde Recientes.
- **Proyectos con estado**: cada proyecto guarda su objetivo, repositorio, indicaciones y el último **bloque de estado** (hecho, en progreso, siguientes pasos, decisiones, bloqueos, archivos clave y % de progreso), con historial de checkpoints y traspasos.
- **Traspaso entre cuentas**: con un toque pides el estado a Claude, lo guardas y lo pasas a otra cuenta. La ventana destino te ofrece el prompt de continuación, listo en el cuadro de mensaje.
- **Pausas por límite**: marca una cuenta en pausa (1–24 h u hora exacta) y recibe un aviso cuando vuelve a estar disponible.

## Instalar

1. Descarga [`dist/Relevo.apk`](dist/Relevo.apk) en el teléfono (o el `Relevo.apk` de la última *Release* del repositorio, que compila GitHub Actions).
2. Ábrelo y permite «Instalar apps desconocidas» para tu navegador o gestor de archivos.
3. Requiere Android 10 o superior.

Todas las compilaciones se firman con la misma clave (`app/relevo.keystore`), así que una versión nueva se instala encima de la anterior sin perder sesiones ni proyectos.

## Cómo se usa

### 1. Cuentas
Pestaña **Cuentas → + Agregar cuenta**. Pon un nombre, un color y la página de inicio (chat de claude.ai o Claude Code). Pulsa **Abrir** e inicia sesión en esa ventana. Repite con cada cuenta.

> Inicio de sesión: lo más fiable es con el correo. Si «Continuar con Google» se bloquea dentro de la ventana integrada, usa el correo. Si te llega un enlace, mantenlo pulsado en el correo, cópialo y ábrelo en la ventana de la cuenta con **⋮ → Abrir un enlace aquí**; si lo abres directamente se iniciaría sesión en Chrome y no en esa cuenta.

### 2. Proyecto
Pestaña **Proyectos → + Nuevo proyecto** (nombre, objetivo y, si hay código, repositorio y rama). **Continuar** abre la ventana de la cuenta asignada. Ahí aparece un aviso para insertar el **prompt de inicio**: revísalo y envíalo.

### 3. Barra de la ventana de sesión

| Botón | Qué hace |
|---|---|
| 📨 **Traspaso** | Inserta el prompt de inicio (si el proyecto no tiene estado) o el de continuación con el último estado. |
| 🧭 **Pedir estado** | Inserta el mensaje `CHECKPOINT`, que pide a Claude el bloque `<<<ESTADO … ESTADO>>>`. |
| 💾 **Guardar** | Lee el bloque más reciente de la conversación (o del portapapeles) y lo guarda como checkpoint con su % de progreso. |
| ⇄ **Pasar** | Guarda el estado visible, eliges la cuenta destino y si pausar la actual. Se registra el traspaso y se abre la otra ventana. |
| ⋮ | Recargar, chat nuevo, Claude Code, detalles del proyecto, pausar, modo escritorio, pegar estado a mano, abrir enlace, cerrar sesión, cerrar ventana. |

El selector de arriba indica en qué proyecto trabaja esa ventana; cada cuenta puede llevar un proyecto distinto al mismo tiempo.

### 4. Pasar el proyecto a otra cuenta
1. **🧭 Pedir estado** y envía el mensaje. Claude responde con el bloque de estado.
2. **💾 Guardar**.
3. **⇄ Pasar**: elige la cuenta destino y, si la actual llegó a su límite, cuánto pausarla.
4. En la ventana destino sale **Traspaso pendiente → Insertar prompt**. Si ya había una conversación abierta, Relevo ofrece hacerlo en un chat nuevo. Envía el mensaje y Claude continúa desde *SIGUIENTES_PASOS*.

Repite hasta terminar. El historial del proyecto (Detalles) muestra cada checkpoint y cada traspaso, y permite restaurar un estado anterior.

### Con código
Si el proyecto tiene repositorio, los prompts piden a Claude hacer commit y push de cada avance y mantener el mismo bloque en `HANDOFF.md`. Así el estado viaja también con el código (ideal con Claude Code en `claude.ai/code`).

### Exportar
**Detalles → Compartir resumen** (Markdown) o **Exportar JSON** para llevar el proyecto a otro teléfono (**Proyectos → Importar**). Los prompts también se pueden copiar para usarlos en Chrome de escritorio.

## Formato del bloque de estado

```
<<<ESTADO
PROYECTO: Tienda
PROGRESO: 45%
RESUMEN: Backend listo, falta el frontend.
HECHO:
- API de productos
EN_PROGRESO:
- Carrito (falta el total)
SIGUIENTES_PASOS:
- Terminar el carrito
DECISIONES:
- PostgreSQL por las transacciones
BLOQUEOS:
- ninguno
ARCHIVOS_CLAVE:
- api/server.ts: rutas
CONTEXTO_EXTRA:
npm run dev en el puerto 3000
ESTADO>>>
```

## Privacidad y límites

- Relevo **no envía mensajes ni automatiza Claude**: solo coloca texto en el cuadro de mensaje cuando pulsas un botón (o lo copia al portapapeles), y tú decides enviarlo.
- Todo se guarda localmente en el teléfono (`files/relevo.json`); no hay servidores ni analítica.
- Usa solo tus propias cuentas y respeta los [Términos de uso de Anthropic](https://www.anthropic.com/legal/consumer-terms).
- Micrófono y modo de voz no están habilitados en las ventanas integradas.

## Cómo está hecho

- Java puro sobre el framework de Android (sin AndroidX), `minSdk 29`, `targetSdk 34`.
- Cada cuenta es una actividad (`slots/SlotNActivity`) declarada en **su propio proceso** (`:sN`) y su propia tarea. En cada proceso `WebView.setDataDirectorySuffix("sN")` aísla cookies, almacenamiento y caché; la tarea propia la convierte en una ventana independiente.
- `Store` guarda un único JSON compartido por todos los procesos, protegido con un bloqueo de archivo.
- `StateBlock` interpreta el bloque de estado; `Prompts` genera los prompts de inicio, traspaso y checkpoint.
- Pruebas: `StateBlockTest` (lógica) y `AppSmokeTest` (Robolectric: pantallas, traspaso, diálogos, avisos).

## Compilar

Con Android SDK y JDK 17:

```bash
./gradlew testDebugUnitTest assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

GitHub Actions (`.github/workflows/android.yml`) ejecuta las pruebas, compila el APK en cada push y lo publica como *Release*.

Sin Android SDK (por ejemplo, si `dl.google.com` no es accesible), `tools/build-local.sh` compila el APK usando solo artefactos de Maven Central y npm (aapt2 de apktool, clases de Android de Robolectric, D8 y apksig) y lo deja en `dist/Relevo.apk`.

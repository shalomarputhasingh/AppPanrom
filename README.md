# AppPanrom

**AppPanrom** is a Tanglish programming language and a local-first web IDE ("Studio") for building Android apps.
Write code in natural Tanglish, see it run in an interactive Android phone frame, and build a real **debug APK**.

```
app_uruvakku("Vanakkam App")

function welcome():
    message_kaattu("Vanakkam " + input_value("name") + "!")

screen_uruvakku("home"):
    column_uruvakku(style={"padding": 24, "gap": 16}):
        title("Vanakkam Nanba!")
        input_uruvakku("name", label="Un peru", placeholder="Un peru enna?")
        button("Click Pannu", click_pannumbodhu=welcome)
```

## How it works

```
 main.apn ──► lexer/parser ──► validator ──► IR (JSON) ──┬──► Studio preview (sandboxed iframe) ┐ same
 (Python, backend/apppanrom/lang)                         └──► Android app (WebView in an APK)   ┘ runtime
                                                                  runtime/apppanrom-runtime.js
```

* **One runtime, two hosts.** `runtime/apppanrom-runtime.js` interprets the IR and renders it. The Studio preview and the
  generated APK embed the *same file*, so behaviour matches by construction.
* **One spec.** `spec/schema.json` defines components, style keys, and the standard library. The validator, runtime
  (tests assert the lists match), editor highlighting and docs all use it.
* **No `exec`/`eval`.** AppPanrom source is never executed as Python/JavaScript; see the security model in
  [docs/language.md](docs/language.md#9-runtime-limits-and-security-model).
* The server **never runs your app**; it only compiles. Rendering happens in the browser / on the device.

## Status

| Area | Status |
|---|---|
| Language: variables, expressions, `enna_na`/`illana_enna`/`illana`, `ovvoru`, `irukkura_varai`, functions, `try/catch`, lists/dicts | ✅ implemented + tested |
| Diagnostics with file/line/column + suggestions | ✅ |
| Components: title, text, button, text/password/number inputs, checkbox, toggle, dropdown, image, list, progress, loading, divider, card, column, row, center | ✅ |
| Layout + validated, component-scoped styles; light/dark theme | ✅ (subset, see language doc) |
| Multi-screen navigation + back, screen data | ✅ |
| App-local storage (`data_*`) | ✅ (not encrypted) |
| Studio: projects (create/open/rename/delete), editor with highlighting + live diagnostics, console, live phone preview, settings, reference, examples | ✅ |
| Persistence of projects/builds across restarts (SQLite + files) | ✅ |
| Android build pipeline (generate project → Gradle → verify → download) | ✅ implemented, **⚠ not yet verified against a real Android SDK** (see below) |
| Network APIs (`api_get`…), device capabilities, app icon, release signing/AAB, dialogs, gradients/shadows/custom fonts, extra themes, "fun mode" | ❌ not implemented (the compiler says so) |
| Authentication / multi-user | ❌ local single-user MVP |

### Honest note on APK builds

The pipeline (project generation, background Gradle run, log capture, timeout, artifact verification, history, download)
is implemented and tested, but the development sandbox this was built in has **no Android SDK and cannot reach Google's
Maven/SDK hosts**, so a real `assembleDebug` has **never been run** here. What *was* verified:

* prerequisite detection and the failure path with an actionable message (real run, no SDK);
* the build manager with a **clearly labelled Gradle test double** (status transitions, log capture/cap, timeout kill,
  corrupt/tiny/missing APK rejection, artifact pruning, download gating) — this proves the mechanics, **not** that the
  Android template compiles;
* the generated `index.html`/`app.js` bundle runs in Chromium under the same CSP the APK uses.

The Android template (`android-template/`: AGP 8.5.2, compileSdk/targetSdk 34, minSdk 24, `androidx.webkit` asset loader)
was reviewed against known-good configurations but is **unproven until you run a build on a machine with the SDK**.
A build is only ever reported as succeeded if Gradle exits 0 *and* a nonzero-size, valid APK zip containing
`AndroidManifest.xml` and the runtime exists. Output is a **debug APK signed with the Android debug key** — not
Play-Store ready; release signing and AAB are not implemented.

## Quick start

Prerequisites: Python 3.11+, Node 18+ (tested with Python 3.13 / Node 22). For APK builds also: JDK 17+, Gradle 8.7+,
Android SDK (see below).

```bash
make setup                   # pip install backend deps, npm install frontend
make serve                   # builds the Studio and serves everything at http://127.0.0.1:8000
```

Development mode (hot reload), two terminals:

```bash
make dev-backend             # API on :8000   (uvicorn apppanrom.main:create_app --factory)
make dev-frontend            # Studio on :5173 (proxies /api to :8000)
```

Press **▶ Run** (or Ctrl+Enter) to compile and preview. Sample programs are in `examples/` and in the Studio's
**Reference → Examples**.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `APPANROM_DATA_DIR` | `./data` | Projects, SQLite DB, build logs, APKs, Gradle cache. Not committed. |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | unset | Android SDK location (required for APK builds) |
| `GRADLE_BIN` | `gradle` on `PATH` | Gradle executable (8.7+) |
| `JAVA_HOME` | `java` on `PATH` | JDK 17+ |
| `APPANROM_BUILD_TIMEOUT` | `900` | Seconds before a build is killed |
| `APPANROM_KEEP_BUILD_DIRS` | `0` | `1` keeps the generated Gradle project after a build (debugging) |
| `APPANROM_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed browser origins (`*` is ignored) |

Only an allow-list of environment variables (PATH, HOME, proxy settings, Java/Android locations) is passed to Gradle;
other secrets in your environment are not.

## Building an APK

1. Install JDK 17+, Gradle 8.7+, and the Android SDK command-line tools, then:
   `sdkmanager "platforms;android-34" "build-tools;34.0.0"` and accept licences (`sdkmanager --licenses`).
2. `export ANDROID_HOME=/path/to/sdk` (and `GRADLE_BIN` if `gradle` isn't on `PATH`) before starting the backend.
3. In the Studio open **Build → Build debug APK**. The panel shows what is missing if prerequisites aren't met,
   streams the real Gradle log, and offers **Download** only for a verified APK.
4. Or by hand: `cd backend && python3 -m apppanrom.cli android-project ../examples/vanakkam.apn /tmp/myapp`, then open
   `/tmp/myapp` in Android Studio or run `gradle assembleDebug` there.

Application id, version, app name and theme flow from `main.apn` / project settings into `build.gradle`, the manifest
and string resources (values are validated and XML-escaped; build directories are isolated per build, Gradle is invoked
with an argument array, and a timeout and log-size cap apply). Gradle needs to download dependencies from Google Maven /
Maven Central on first build.

## Tests

```bash
make test        # backend (pytest) + runtime (node --test) + frontend (tsc + vitest)
make e2e         # real backend + real Chromium: create project, edit, diagnostics, run, interact, navigate,
                 # storage, build-failure UI, persistence, rename/delete, generated Android web bundle
```

| Suite | Needs Android SDK/Gradle? |
|---|---|
| `backend/tests/test_language.py` – parser/validator/diagnostics/limits | no |
| `backend/tests/test_api.py` – CRUD, validation, path traversal, persistence, CORS | no |
| `backend/tests/test_builds.py` – build manager with a Gradle test double (needs `java` for the prerequisite check) | no (but not a real build) |
| `runtime/test/` – interpreter, view tree, events, state, navigation, styles, storage, limits | no (calls the Python compiler) |
| `frontend/e2e/run.mjs` | no (Chromium required; uses `/opt/pw-browsers` or `CHROMIUM_PATH`) |
| A real `assembleDebug` | **yes — not part of the automated suite yet** |

## API (local, unauthenticated)

`GET /health` · `GET /api/system/status` · `GET /api/language/spec` · `GET|POST /api/projects` ·
`GET|PATCH|DELETE /api/projects/{id}` · `GET /api/projects/{id}/files` · `GET|PUT|DELETE /api/projects/{id}/files/{name}` ·
`POST /api/projects/{id}/validate` · `POST /api/projects/{id}/preview` · `GET|POST /api/projects/{id}/builds` ·
`GET /api/builds/{id}` · `GET /api/builds/{id}/logs?offset=` · `GET /api/builds/{id}/artifact`.
Errors are always `{"error": {"code", "message", "details?"}}`. Interactive docs: `/docs`.

## Security assumptions

This is a **local, single-user development tool**. There is no authentication; do not expose it to the internet as is.
Before any public deployment you would need: authentication/authorisation and per-user project isolation, HTTPS, per-user
quotas and rate limits, and running Gradle builds in a locked-down sandbox/container (a build runs arbitrary Gradle
plugins' code from the template's dependencies; project source never reaches Gradle as code, only validated metadata and
the IR as data). Implemented safeguards: strict identifier/path validation (flat file names, generated ids,
`fullmatch` regexes), request/source/log size limits, interpreter step/depth/size limits, sandboxed preview iframe with
CSP, restrictive CORS, no stack traces in API errors, no secrets in generated projects, no keystores in the repo.
There is no network access from AppPanrom code yet, so there is no SSRF surface; when `api_*` functions are added they must
go through a server-side validated proxy.

## Known limitations / next steps

* Run a real build on a machine with the Android SDK and fix whatever the template needs; add it as a CI job.
* App icon, release signing (secure config), AAB, network APIs, device capabilities, dialogs, more themes.
* Text-input IME: redraws are deferred during composition; the whole screen is rebuilt on each event (fine for small apps).
* Only `main.apn` is compiled; additional files are notes.
* Builds run one at a time; the build list shows the latest 50 builds; APK files are kept for the latest 10 builds per project (older records stay, their APKs are pruned).
* Editor is CodeMirror 6 rather than Monaco (fully local/offline, much smaller).
* No `break`/`continue`, no first-class functions, no modules/imports.

See [docs/language.md](docs/language.md) for the full language reference.

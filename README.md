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
| **Visual designer**: drag components from a palette onto the phone, select/move/duplicate/delete, outline tree, property inspector (properties, events, styles), new screens and handlers — every action edits `main.apn` and every code edit redraws the canvas | ✅ |
| App icon (PNG upload), automatic Android permission declaration, `clipboard_copy`, `vibrate_pannu` | ✅ |
| Release signing + release APK + AAB (keystore from environment, signature independently verified when tools are available) | ✅ built and signature-verified for real (apksigner / jarsigner); install on a device not tested |
| Persistence of projects/builds across restarts (SQLite + files) | ✅ |
| Android build pipeline (generate project → Gradle → verify → download) | ✅ real `assembleDebug` / release APK / AAB succeeded with a real SDK; **⚠ never installed or launched on a device/emulator** (see below) |
| Network APIs (`api_get`…), runtime-permission device capabilities (camera, location…), dialogs, gradients/shadows/custom fonts, extra themes, "fun mode" | ❌ not implemented (the compiler says so) |
| Authentication / multi-user | ❌ local single-user MVP |

### Honest note on APK builds

Verified **for real** (Android SDK 34 / build-tools 34.0.0 from dl.google.com, JDK 21, Gradle 8.14.3, AGP 8.5.2, real Maven downloads):

* `cli android-project` → `gradle assembleDebug` exits 0; the APK has the expected manifest (package, label, minSdk 24, launcher
  activity), `assets/www/apppanrom-runtime.js` byte-identical to `runtime/apppanrom-runtime.js`, and the debug signature verifies with `apksigner`.
* The same through the Studio pipeline: API and the Studio **Build** tab (driven with Chromium) built debug APK, release APK and release AAB;
  each artifact downloaded and verified. The uploaded icon is in the APK (`application: icon=…`).
* `INTERNET` and `VIBRATE` are declared in the built APK exactly when `image_kaattu` / `vibrate_pannu` are used (checked with `aapt2 dump permissions`).
* Release: a throwaway keystore from `make-keystore`; release APK verified by `apksigner verify`, AAB by `jarsigner -verify`; a release build without
  the signing variables fails with `signing_not_configured` and produces no artifact.
* `backend/tests/test_real_build.py` automates the above (runs only when `ANDROID_HOME` is set) and is the `android-build` job in
  `.github/workflows/ci.yml`. That workflow file has **not been run on GitHub yet**; the commands in it were run by hand here.

**Device test:** the maintainer installed the Vanakkam example's debug APK on a real Android phone and reported it ran without errors (reported by the user, not automated). **Not verified:** the release APK/AAB on a device, the permissions-test app on a device, any emulator run (this environment has no KVM); Play Store acceptance of the AAB;
release APKs have shortened resource paths (e.g. `res/o-.png` for the icon), which is normal AGP behaviour but was only inspected, not exercised.

Practical notes from the real runs: the first build downloads ~hundreds of MB of dependencies and takes 2-4 minutes. Maven Central may answer
HTTP 429 when the Gradle cache is cold (seen from this environment's shared egress); re-running continues from what was already downloaded, and the
real-build test retries only on such download errors. The template disables Android lint for generated projects (`lint { checkReleaseBuilds false }`)
so release builds do not fetch the lint toolchain. A build is only reported as succeeded if Gradle exits 0 *and* a valid artifact exists. Debug builds
are signed with the Android debug key and are not Play-Store ready.

## Visual designer

Press **✎ Design** above the phone (or open the **Design** tab). The designer is not a separate model of your app: **`main.apn` is the only
source of truth**, and the designer edits it as text.

* **Drag** a component from the palette onto the phone: onto empty space (appends to the screen), next to another component
  (before/after, shown with a blue line) or into a container (dashed outline). Click a palette item to add it next to the selection.
* **Click** a component (or pick it in the Outline) to select it; **drag** it to move it (containers move with their children);
  **Del** removes it, **Ctrl+D** duplicates it; ↶ ↷ undo/redo (the editor's own undo history).
* The **Inspector** edits properties, events and styles. Each field is a typed control (text, number, colour picker, dropdown…); **ƒx**
  switches a field to a code expression such as `"Count: " + str(count)`. Invalid values (e.g. `font_size` 4) are rejected with the compiler's
  message and never written. Choosing **＋ New handler…** writes a `function` into your code and wires the event to it.
* **Live both ways:** every designer action rewrites the code in the editor (visible immediately, autosaved), and typing in the code redraws the
  canvas as soon as it compiles. If the code has errors the designer freezes on the last valid design with a banner instead of guessing.
* Empty containers contain `summa` (a no-op statement); it disappears when you drop something in.

Under the hood each action is a small text edit (`backend/apppanrom/lang/designer.py`): components are addressed by source line, headers of edited
components are regenerated from the AST, everything else (comments, formatting, other code) is untouched, and the result is re-parsed before it is
accepted. Randomised tests apply hundreds of edits and check the file always stays valid.

## Local setup (your own PC)

### 1. Install the tools

| Tool | Version | Needed for | Get it |
|---|---|---|---|
| Python | 3.11+ | backend / compiler | python.org (Windows: tick "Add to PATH") |
| Node.js | 18+ | Studio (frontend) | nodejs.org |
| Git | any | cloning | git-scm.com |
| JDK | 17+ | APK builds only | e.g. Temurin from adoptium.net (`java -version` must work) |
| Gradle | 8.7+ (tested 8.14.3) | APK builds only | gradle.org/install (or SDKMAN / Homebrew / Scoop) |
| Android SDK | platform 34, build-tools 34.0.0 | APK builds only | below |

You can use the Studio, editor, designer and preview with just Python and Node. JDK, Gradle and the SDK are only for building an APK.

### 2. Get the code and start the Studio

```bash
git clone https://github.com/shalomarputhasingh/AppPanrom.git
cd AppPanrom

# macOS / Linux (needs make)
make setup          # installs backend + frontend dependencies
make serve          # builds the Studio and serves it at http://127.0.0.1:8000
```

Windows (PowerShell) or no `make` - the same steps by hand:

```powershell
pip install -r backend/requirements-dev.txt
cd frontend; npm install; npm run build; cd ..
cd backend
python -m uvicorn apppanrom.main:create_app --factory --port 8000
```

Open <http://127.0.0.1:8000>, create a project, press **Run** (Ctrl+Enter) to preview. Projects, builds and APKs are stored in `./data`
(or `APPANROM_DATA_DIR`), which is not committed. Run the server from the `backend` folder; if you change the frontend, rebuild it
(`npm run build`) and restart the server.

### 3. Install the Android SDK (no Android Studio needed)

1. Download "Command line tools only" from <https://developer.android.com/studio#command-line-tools-only> and unzip it so that the
   path is `<SDK>/cmdline-tools/latest/bin/sdkmanager` (`<SDK>` e.g. `~/android-sdk` or `C:\Android\sdk`). The `latest` folder level matters.
2. Install the packages and accept the licences:

```bash
<SDK>/cmdline-tools/latest/bin/sdkmanager --licenses
<SDK>/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

(On Windows use `sdkmanager.bat`.) If you already have Android Studio, its SDK works too; just make sure those two packages are installed.

### 4. Tell AppPanrom where things are, then restart the server

```bash
# macOS / Linux
export ANDROID_HOME=~/android-sdk
export GRADLE_BIN=/path/to/gradle/bin/gradle     # only if `gradle` is not on PATH
```

```powershell
# Windows PowerShell
$env:ANDROID_HOME = "C:\Android\sdk"
$env:GRADLE_BIN = "C:\gradle\bin\gradle.bat"    # only if gradle is not on PATH
```

Start the server **from the same terminal** (variables are per terminal). In the Studio, **Build** shows green checks for Java, Gradle and
the Android SDK; anything missing is listed with the fix. Then **Build Debug APK**, wait 2-5 minutes on the first build (it downloads
dependencies from Google Maven / Maven Central; you need internet), and **Download**.

### 5. Install the APK on your phone

* Send the `.apk` to the phone (cable, cloud drive, chat), open it and allow "install unknown apps" for that app when Android asks; or
* USB debugging on, then `adb install -r app-debug.apk` (`adb` is in `<SDK>/platform-tools`).

Debug APKs are signed with the Android debug key: fine for testing, not for the Play Store.

### 6. (Optional) Signed release APK / AAB for the Play Store

```bash
cd backend
python -m apppanrom.cli make-keystore ~/keys/myapp.jks --alias release     # asks for a password; needs keytool (comes with the JDK)
export APPANROM_KEYSTORE=~/keys/myapp.jks APPANROM_KEY_ALIAS=release
export APPANROM_KEYSTORE_PASSWORD='your-password'                          # PowerShell: $env:NAME = "value"
python -m uvicorn apppanrom.main:create_app --factory --port 8000
```

Then choose *Release APK* or *Release AAB* in **Build**. **Back up the keystore and password** (without them you can never update a
published app) and never commit them.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Build tab says Java / Gradle / Android SDK not ready | Follow the "fix" text shown; check `java -version`, `gradle -v`, and that `ANDROID_HOME` was exported in the terminal that started the server |
| `sdkmanager` says it cannot find the SDK root | The unzipped folder must be `cmdline-tools/latest/...`, not `cmdline-tools/cmdline-tools/...` |
| Gradle: "Could not GET ... 429" or timeouts | Network / Maven rate limit; just press Build again, it resumes from what was downloaded. Behind a proxy set `HTTPS_PROXY` |
| Build fails with "Unsupported class file major version" | JDK too new/old for Gradle; use JDK 17 or 21 |
| Studio page is blank / 404 at `/` | Frontend not built: `cd frontend && npm run build`, then restart the server |
| `pip` / `python` not found on Windows | Use `py -m pip` / `py -m uvicorn`, or reinstall Python with "Add to PATH" |
| Release buttons are disabled | The three `APPANROM_KEYSTORE*` variables were not set when the server started |

Development mode with hot reload (two terminals): `make dev-backend` (API on :8000) and `make dev-frontend` (Studio on :5173).
Press **▶ Run** (or Ctrl+Enter) to compile and preview. Sample programs are in `examples/` and in the Studio's **Reference → Examples**. `examples/calculator.apn` + `examples/calculator-icon.png` is a full colourful calculator app (upload the PNG in Settings → App icon, then build).

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

Set up the JDK, Gradle and Android SDK as described in [Local setup](#local-setup-your-own-pc), then open **Build → Build debug APK** in the Studio.
The panel shows what is missing if prerequisites aren't met, streams the real Gradle log, and offers **Download** only for a verified APK.

By hand: `cd backend && python3 -m apppanrom.cli android-project ../examples/vanakkam.apn /tmp/myapp`, then open
   `/tmp/myapp` in Android Studio or run `gradle assembleDebug` there.

Application id, version, app name and theme flow from `main.apn` / project settings into `build.gradle`, the manifest
and string resources (values are validated and XML-escaped; build directories are isolated per build, Gradle is invoked
with an argument array, and a timeout and log-size cap apply). Gradle needs to download dependencies from Google Maven /
Maven Central on first build.

### App icon, permissions, signing, AAB

* **Icon:** Settings → App icon (square PNG, 192–1024 px, ≤500 KB). It becomes the launcher icon.
* **Permissions:** declared automatically from what your code uses (`image_kaattu` → INTERNET, `vibrate_pannu` → VIBRATE) and listed in the Build tab.
  Runtime-prompt permissions are not implemented.
* **Release signing (never in the repo, the database or the logs):**
  1. `cd backend && python3 -m apppanrom.cli make-keystore ~/keys/myapp.jks --alias release` (prompts for a password; needs `keytool`).
  2. Start the backend with `APPANROM_KEYSTORE`, `APPANROM_KEYSTORE_PASSWORD`, `APPANROM_KEY_ALIAS` (and `APPANROM_KEY_PASSWORD` if different).
  3. In **Build**, choose *Release APK* or *Release AAB*. Without a configured key these are disabled and any attempt fails; **an unsigned "release" is never produced**.
  The secrets are passed only to the Gradle process environment. After the build the signature is checked independently
  (`apksigner` for APKs, `jarsigner` for bundles); an APK signed with the Android debug key is rejected as a release.
  If the verifier tool isn't installed the build is reported as *"not independently verified"*. **Back up your keystore**: you cannot update a published app without it.
* Release builds use the same pipeline as debug builds (verified for real, see the note above).

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
| `backend/tests/test_builds.py`, `test_signing_icon.py` – build manager with a Gradle test double (needs `java`); signing uses a real `keytool`/`jarsigner` | no (but not a real Gradle build) |
| `backend/tests/test_designer.py` – drop/move/delete/duplicate/property/style/event edits incl. 150 randomised edits | no |
| `runtime/test/` – interpreter, view tree, events, state, navigation, styles, storage, limits | no (calls the Python compiler) |
| `frontend/e2e/run.mjs` – incl. drag-and-drop designer flow | no (Chromium required; uses `/opt/pw-browsers` or `CHROMIUM_PATH`) |
| `backend/tests/test_real_build.py` – real debug APK, release APK, release AAB, permissions, icon, signature checks | **yes** (skipped unless `ANDROID_HOME` is set; ~4 min) |

## API (local, unauthenticated)

`GET /health` · `GET /api/system/status` · `GET /api/language/spec` · `GET|POST /api/projects` ·
`GET|PATCH|DELETE /api/projects/{id}` · `GET /api/projects/{id}/files` · `GET|PUT|DELETE /api/projects/{id}/files/{name}` ·
`POST /api/projects/{id}/validate` · `POST /api/projects/{id}/preview` · `POST /api/projects/{id}/design/edit|node` ·
`PUT|GET|DELETE /api/projects/{id}/icon` · `GET|POST /api/projects/{id}/builds` (`{"kind": "debug_apk"|"release_apk"|"release_aab"}`) ·
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

* Install and launch the built APK on an emulator/device (not possible in the environment used so far); confirm the CI workflow runs on GitHub.
* Network APIs, runtime-permission device capabilities, dialogs, more themes. 
* Designer: no resize handles or free positioning (layout is flex-based, so you reorder/nest and set sizes in the inspector); selection is cleared when you type in the code (line numbers shift); edits to components that were generated by loops act on the one source line.
* Text-input IME: redraws are deferred during composition; the whole screen is rebuilt on each event (fine for small apps).
* Only `main.apn` is compiled; additional files are notes.
* Builds run one at a time; the build list shows the latest 50 builds; APK files are kept for the latest 10 builds per project (older records stay, their APKs are pruned).
* Editor is CodeMirror 6 rather than Monaco (fully local/offline, much smaller).
* No `break`/`continue`, no first-class functions, no modules/imports.

See [docs/language.md](docs/language.md) for the full language reference.

"""FastAPI application. Local-first MVP: no authentication (see README, "Security assumptions")."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .android.builder import BuildManager
from typing import Literal

from .android.prereqs import check_prerequisites, check_signing
from .config import Settings
from .db import Database
from .lang import compile_source
from .lang.designer import DesignError, apply_op, describe, describe_app
from .ai import AiConfig, AiError, ChatMessage, assist
from .lang.spec import REPO_ROOT, load_spec
from .lang.tanglish import detect_style, to_english, to_tanglish
from .projects import MAIN_FILE, Invalid, NotFound, ProjectStore


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        self.status, self.code, self.message, self.details = status, code, message, details


def error_response(status: int, code: str, message: str, details=None) -> JSONResponse:
    body = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(body, status_code=status)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    app_id: str | None = Field(default=None, max_length=100)
    version: str = Field(default="1.0.0", max_length=20)
    theme: str = Field(default="light", max_length=10)
    source: str | None = Field(default=None, max_length=200_000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    app_id: str | None = Field(default=None, max_length=100)
    version: str | None = Field(default=None, max_length=20)
    theme: str | None = Field(default=None, max_length=10)


class FileBody(BaseModel):
    content: str = Field(max_length=200_000)


class DesignEdit(BaseModel):
    source: str = Field(max_length=200_000)
    op: dict


class DesignNode(BaseModel):
    source: str = Field(max_length=200_000)
    line: int = Field(ge=1, le=100_000)


class BuildRequest(BaseModel):
    kind: Literal["debug_apk", "release_apk", "release_aab"] = "debug_apk"


class AiMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class AiDiag(BaseModel):
    line: int = Field(ge=1, le=100_000)
    message: str = Field(max_length=500)
    suggestion: str | None = Field(default=None, max_length=300)


class AiSelection(BaseModel):
    line: int = Field(ge=1, le=100_000)
    component: str = Field(max_length=60)


class AiChat(BaseModel):
    messages: list[AiMessage] = Field(min_length=1, max_length=24)
    source: str | None = Field(default=None, max_length=200_000)   # the editor's current text; default: the saved main.apn
    include_code: bool = True                                       # false: the code is NOT sent to the AI service
    diagnostics: list[AiDiag] = Field(default_factory=list, max_length=30)
    selection: AiSelection | None = None
    on_limit: Literal["wait", "fallback"] = "wait"            # when Groq's limit is reached: wait for it to reset, or use the backup model


class AiKey(BaseModel):
    key: str = Field(min_length=8, max_length=300)


class ConvertBody(BaseModel):
    source: str = Field(max_length=200_000)
    to: Literal["tanglish", "english"]


class SourceBody(BaseModel):
    source: str | None = Field(default=None, max_length=200_000)


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings.from_env()
    s.ensure_dirs()
    db = Database(s.db_path)
    store = ProjectStore(s, db)
    builds = BuildManager(s, db)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        builds.shutdown()
        db.close()

    app = FastAPI(title="AppPanrom API", version=__version__, lifespan=lifespan)
    ai = AiConfig(s.ai_api_key, s.ai_model, s.ai_base_url, tier=s.ai_tier, tpm=s.ai_tpm, fallback_models=s.ai_fallback_models, max_inline_wait=s.ai_max_wait_s)
    app.state.settings, app.state.store, app.state.builds, app.state.ai = s, store, builds, ai

    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["Content-Type"])

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > s.max_request_bytes:
            return error_response(413, "request_too_large", f"Request body exceeds {s.max_request_bytes} bytes.")
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def _api_error(_, e: ApiError):
        return error_response(e.status, e.code, e.message, e.details)

    @app.exception_handler(AiError)
    async def _ai(_, e: AiError):
        return error_response(e.status, e.code, e.message, e.details)

    @app.exception_handler(NotFound)
    async def _not_found(_, e: NotFound):
        return error_response(404, "not_found", f"{e} not found.")

    @app.exception_handler(Invalid)
    async def _invalid(_, e: Invalid):
        return error_response(422, e.code, str(e))

    @app.exception_handler(DesignError)
    async def _design(_, e: DesignError):
        return error_response(422, e.code, str(e))

    @app.exception_handler(RequestValidationError)
    async def _validation(_, e: RequestValidationError):
        details = [{"field": ".".join(str(x) for x in err["loc"][1:]), "message": err["msg"]} for err in e.errors()]
        return error_response(422, "validation_error", "Request validation failed.", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_, e: StarletteHTTPException):
        return error_response(e.status_code, "http_error", str(e.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_, e: Exception):  # no stack traces or paths leak to clients
        return error_response(500, "internal_error", "Internal server error.")

    # ---- health / system
    @app.get("/health")
    def health():
        return {"status": "ok", "version": __version__}

    @app.get("/api/system/status")
    def system_status():
        return {"version": __version__, "android": check_prerequisites(s), "signing": check_signing(s),
                "limits": {"max_file_bytes": s.max_file_bytes, "max_files_per_project": s.max_files_per_project,
                           "build_timeout_s": s.build_timeout_s}}

    # ---- AI assistant (Groq). The key is never returned, stored or logged.
    @app.get("/api/ai/status")
    def ai_status():
        return ai.status()

    @app.post("/api/ai/key")
    def ai_set_key(body: AiKey):
        """Keeps a key in server memory until the backend stops (for people who did not set GROQ_API_KEY)."""
        ai.set_session_key(body.key)
        return ai.status()

    @app.delete("/api/ai/key")
    def ai_clear_key():
        ai.set_session_key(None)
        return ai.status()

    @app.post("/api/projects/{project_id}/ai/chat")
    def ai_chat(project_id: str, body: AiChat):
        project = store.get(project_id)
        if body.messages[-1].role != "user":
            raise ApiError(422, "bad_request", "The last message must be from the user.")
        source = body.source if body.source is not None else store.read_file(project_id, MAIN_FILE)
        defaults = store.compile_defaults(project)

        def check(code: str) -> tuple[bool, list[dict]]:
            r = compile_source(code, defaults)
            return r.ok, [d.to_dict() for d in r.diagnostics]

        result = assist(ai, check, [ChatMessage(m.role, m.content) for m in body.messages], source, body.include_code,
                        [d.model_dump() for d in body.diagnostics], body.selection.model_dump() if body.selection else None, body.on_limit)
        return result

    @app.get("/api/language/spec")
    def language_spec():
        return load_spec()

    @app.post("/api/language/convert")
    def language_convert(body: ConvertBody):
        """Rewrites source between the English and the Tanglish vocabulary (same program, strings/comments untouched)."""
        out = to_tanglish(body.source) if body.to == "tanglish" else to_english(body.source)
        return {"source": out, "style": detect_style(out)}

    # ---- projects
    @app.get("/api/projects")
    def list_projects():
        return {"projects": store.list()}

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectCreate):
        return store.create(body.name, body.app_id, body.version, body.theme, body.source)

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str):
        return store.get(project_id)

    @app.patch("/api/projects/{project_id}")
    def patch_project(project_id: str, body: ProjectPatch):
        return store.update(project_id, **body.model_dump())

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str):
        store.delete(project_id, builds.delete_project_builds)

    # ---- app icon (PNG 192-1024 px square, max 512 KB)
    @app.put("/api/projects/{project_id}/icon")
    async def put_icon(project_id: str, request: Request):
        if "image/png" not in request.headers.get("content-type", ""):
            raise ApiError(415, "bad_icon", "Send the icon as a PNG (Content-Type: image/png).")
        return store.set_icon(project_id, await request.body())

    @app.get("/api/projects/{project_id}/icon")
    def get_icon(project_id: str):
        p = store.icon_path(project_id)
        if not p:
            raise NotFound("icon")
        return FileResponse(p, media_type="image/png", headers={"Cache-Control": "no-cache"})

    @app.delete("/api/projects/{project_id}/icon", status_code=204)
    def delete_icon(project_id: str):
        store.delete_icon(project_id)

    # ---- files
    @app.get("/api/projects/{project_id}/files")
    def list_files(project_id: str):
        p = store.get(project_id)
        return {"files": [{"name": n, "entry": n == MAIN_FILE} for n in p["files"]]}

    @app.get("/api/projects/{project_id}/files/{file_name}")
    def read_file(project_id: str, file_name: str):
        return {"name": file_name, "content": store.read_file(project_id, file_name)}

    @app.put("/api/projects/{project_id}/files/{file_name}")
    def put_file(project_id: str, file_name: str, body: FileBody):
        return store.write_file(project_id, file_name, body.content)

    @app.delete("/api/projects/{project_id}/files/{file_name}", status_code=204)
    def delete_file(project_id: str, file_name: str):
        store.delete_file(project_id, file_name)

    # ---- compile / preview
    def compile_project(project_id: str, source: str | None):
        project = store.get(project_id)
        text = source if source is not None else store.read_file(project_id, MAIN_FILE)
        return compile_source(text, store.compile_defaults(project))

    @app.post("/api/projects/{project_id}/validate")
    def validate(project_id: str, body: SourceBody | None = None):
        r = compile_project(project_id, body.source if body else None)
        return {"ok": r.ok, "diagnostics": [d.to_dict() for d in r.diagnostics]}

    @app.post("/api/projects/{project_id}/preview")
    def preview(project_id: str, body: SourceBody | None = None):
        """Compiles to IR. The Studio renders the IR with the shared runtime; nothing is executed server-side."""
        r = compile_project(project_id, body.source if body else None)
        return r.to_dict()

    # ---- visual designer: stateless text edits of the editor buffer (the source file stays the single source of truth)
    @app.post("/api/projects/{project_id}/design/edit")
    def design_edit(project_id: str, body: DesignEdit):
        store.get(project_id)
        return apply_op(body.source, body.op)

    @app.post("/api/projects/{project_id}/design/app")
    def design_app(project_id: str, body: SourceBody):
        store.get(project_id)
        return describe_app(body.source if body.source is not None else store.read_file(project_id, MAIN_FILE))

    @app.post("/api/projects/{project_id}/design/node")
    def design_node(project_id: str, body: DesignNode):
        store.get(project_id)
        return describe(body.source, body.line)

    # ---- builds
    @app.post("/api/projects/{project_id}/builds", status_code=202)
    def start_build(project_id: str, body: BuildRequest | None = None):
        r = compile_project(project_id, None)
        if not r.ok:
            raise ApiError(422, "source_invalid", "Fix the errors in your code before building.",
                           [d.to_dict() for d in r.diagnostics if d.severity == "error"])
        return builds.submit(project_id, r.ir, body.kind if body else "debug_apk", store.icon_path(project_id))

    @app.get("/api/projects/{project_id}/builds")
    def project_builds(project_id: str):
        store.get(project_id)
        return {"builds": builds.list_for_project(project_id)}

    def _build(build_id: str) -> dict:
        b = builds.get(build_id)
        if not b:
            raise NotFound("build")
        return b

    @app.get("/api/builds/{build_id}")
    def get_build(build_id: str):
        return _build(build_id)

    @app.get("/api/builds/{build_id}/logs")
    def build_logs(build_id: str, offset: int = 0):
        b = _build(build_id)
        text, nxt = builds.read_log(build_id, max(0, offset))
        return {"text": text, "next_offset": nxt, "done": b["status"] in ("succeeded", "failed")}

    @app.get("/api/builds/{build_id}/artifact")
    def build_artifact(build_id: str):
        b = _build(build_id)
        found = builds.artifact_file(build_id)
        if not found:
            raise ApiError(409 if b["status"] in ("queued", "running") else 404, "no_artifact",
                           "This build has no downloadable APK." if b["status"] != "succeeded"
                           else "The APK for this build is no longer available (old artifacts are pruned).")
        build, path = found
        media = "application/octet-stream" if path.suffix == ".aab" else "application/vnd.android.package-archive"
        return FileResponse(path, media_type=media, filename=build["artifact"]["name"])

    # ---- optional: serve the built Studio (npm run build) from the same origin
    dist = REPO_ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="studio")
    return app


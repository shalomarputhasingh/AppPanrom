export interface Project {
  id: string;
  name: string;
  app_id: string;
  version: string;
  theme: string;
  created_at: string;
  updated_at: string;
  files: string[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number;
  col: number;
  file: string;
  end_col: number | null;
  suggestion: string | null;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ir: any | null;
}

export interface PrereqCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export interface SystemStatus {
  version: string;
  android: { ok: boolean; checks: PrereqCheck[]; supported_output: string };
}

export interface Build {
  id: string;
  project_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  kind: string;
  signing: string;
  app_id: string | null;
  app_name: string | null;
  version: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  exit_code: number | null;
  failure_reason: string | null;
  message: string | null;
  artifact: { name: string; size: number; sha256: string } | null;
}

export interface LogLine {
  id: number;
  level: 'debug' | 'info' | 'warning' | 'error' | 'system';
  text: string;
  time: string;
}

export interface Spec {
  components: Record<string, { doc: string; container: boolean }>;
  functions: Record<string, { doc: string }>;
  config_functions: Record<string, { doc: string }>;
  styles: Record<string, { type: string; min?: number; max?: number; values?: string[] }>;
  style_groups: Record<string, string[]>;
  not_implemented: string[];
}

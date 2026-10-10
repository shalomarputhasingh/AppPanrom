export interface Project {
  id: string;
  name: string;
  app_id: string;
  version: string;
  theme: string;
  created_at: string;
  updated_at: string;
  files: string[];
  has_icon: boolean;
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
  ta?: string | null;
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
  signing: { configured: boolean; detail: string; fix: string };
}

export type BuildKind = 'debug_apk' | 'release_apk' | 'release_aab';

export interface AppPermission {
  permission: string;
  reason: string;
  used_by: string[];
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
  tanglish: { keywords: Record<string, string>; components: Record<string, string>; options: Record<string, string>; functions: Record<string, string> };
}

export interface AppInfo {
  code: { name: string | null; id: string | null; version: string | null; theme: string | null; start_screen: string | null };
  globals: { name: string; expr: string; line: number }[];
  screens: { name: string; line: number; used_by: number }[];
  functions: { name: string; params: number; line: number }[];
  style: 'english' | 'tanglish';
  bars: { navbar: string[]; tabbar: string[] };
}

export interface DesignTreeNode {
  c: string;
  line: number;
  label: string;
  children: DesignTreeNode[] | null;
}

export interface DesignTree {
  screen: string;
  screens: string[];
  title: string;
  children: DesignTreeNode[];
}

export interface DesignValue {
  expr: string;
  literal?: { type: 'str' | 'num' | 'bool'; value: string | number | boolean };
}

export interface DesignNodeInfo {
  kind: 'component' | 'screen';
  component: string;
  line: number;
  container: boolean;
  name?: string;
  props: Record<string, DesignValue>;
  events: Record<string, string>;
  style: Record<string, DesignValue>;
  style_dynamic: boolean;
  allowed: { props: { name: string; type: string; required: boolean }[]; events: string[]; style: string[] };
  handlers: string[];
  handler_lines: Record<string, number>;
}

export interface DropInfo {
  source: 'new' | 'move';
  type?: string;
  line?: number;
  target_line: number | null;
  position: 'before' | 'after' | 'inside';
  screen: string;
}

/** A value sent to the designer: a literal (typed control) or an expression (code). */
export type DesignInput = { literal: string | number | boolean } | { expr: string } | null;

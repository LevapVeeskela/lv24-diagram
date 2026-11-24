import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { errorMessage } from "../log.js";

const execFileAsync = promisify(execFile);

export interface BrainState {
  projectId?: string;
  goal?: string;
  nextAction?: string;
  active: string[];
  summary?: string;
}

export interface BrainNoteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface BrainClientOptions {
  project?: string;
  binary?: string;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Thin CLI adapter for lv24-brain. Deliberately not an MCP-in-MCP: brain is a local
 * binary, and its CLI already owns project resolution, redaction and storage.
 */
export class BrainClient {
  constructor(private readonly options: BrainClientOptions = {}) {}

  get binary(): string {
    return this.options.binary ?? process.env.LV24_DIAGRAM_BRAIN_BIN ?? "brain";
  }

  get project(): string | undefined {
    return this.options.project;
  }

  async #run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(this.binary, args, {
      cwd: this.options.cwd ?? process.cwd(),
      timeout: this.options.timeoutMs ?? 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr };
  }

  async available(): Promise<boolean> {
    try {
      await this.#run(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async open(): Promise<BrainState> {
    const { stdout } = await this.#run(["open", ".", "--json"]);
    const parsed = JSON.parse(stdout) as {
      data?: {
        project?: { id?: string };
        state?: { goal?: string; next_action?: string; active?: string[] };
        summary?: string;
      };
    };
    const data = parsed.data ?? {};
    return {
      ...(data.project?.id ? { projectId: data.project.id } : {}),
      ...(data.state?.goal ? { goal: data.state.goal } : {}),
      ...(data.state?.next_action ? { nextAction: data.state.next_action } : {}),
      active: Array.isArray(data.state?.active) ? data.state.active : [],
      ...(data.summary ? { summary: data.summary } : {}),
    };
  }

  /** Writes a note; returns the record id parsed from the CLI output. */
  async note(text: string, body?: string): Promise<BrainNoteResult> {
    try {
      const args = ["note", text];
      if (this.project) args.push("--project", this.project);
      if (body) args.push("--body", body);
      const { stdout } = await this.#run(args);
      const match = /^note\s+(\S+)/m.exec(stdout);
      return { ok: true, ...(match?.[1] ? { id: match[1] } : {}) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

/** Strips credentials from anything that might end up in a brain note. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/(password|passwd|pwd|token|secret|apikey|api_key)=([^\s&;]+)/gi, "$1=***");
}

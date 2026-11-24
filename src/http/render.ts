import { z } from "zod";

import { DEFAULT_BUDGET, lintMermaid, type LintFinding } from "../mermaid/lint.js";
import { renderMermaid, pngSize, type MermaidTheme } from "../mermaid/render.js";
import { fitPng } from "./png.js";

export const MAX_PNG_SIDE = 2400;
export const MAX_DIAGRAM_NODES = 40;
export const MIN_MERMAID_LENGTH = 10;
export const MAX_MERMAID_LENGTH = 4000;

const THEMES = ["default", "base", "dark", "forest", "neutral"] as const;

const requestSchema = z.object({
  mermaid: z.string().min(MIN_MERMAID_LENGTH).max(MAX_MERMAID_LENGTH),
  theme: z.enum(THEMES).optional(),
  title: z.string().min(1).max(80).optional(),
});

export interface RenderRequest {
  mermaid: string;
  theme: MermaidTheme;
  title?: string;
}

export interface RenderedPng {
  png: Buffer;
  width: number;
  height: number;
}

export type ValidationResult =
  | { ok: true; value: RenderRequest }
  | { ok: false; findings: LintFinding[] };

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: string; message: string }> = [
  {
    pattern: /%%\{/,
    rule: "security",
    message: "Mermaid init directives are not allowed over HTTP; they can override renderer security.",
  },
  {
    pattern: /^\s*click\s+/im,
    rule: "security",
    message: "click directives and links are not allowed over HTTP.",
  },
];

/** Renders a validated request into a PNG capped at MAX_PNG_SIDE pixels on the long side. */
export async function renderDiagramPng(request: RenderRequest): Promise<RenderedPng> {
  const rendered = await renderMermaid(request.mermaid, {
    png: true,
    theme: request.theme,
    backgroundColor: "#ffffff",
    fullWidth: true,
  });
  if (!rendered.png) throw new Error("Mermaid renderer returned no PNG");
  if (!pngSize(rendered.png)) throw new Error("Mermaid renderer returned an invalid PNG");

  const png = fitPng(rendered.png, MAX_PNG_SIDE);
  const size = pngSize(png);
  if (!size) throw new Error("scaled PNG is invalid");
  return { png, width: size.width, height: size.height };
}

/** Schema + readability + transport-security checks. Only `error` findings reject the request. */
export function validateRenderRequest(body: unknown): ValidationResult {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      findings: [{ rule: "request", severity: "error", message }],
    };
  }

  const { mermaid, theme, title } = parsed.data;
  const findings: LintFinding[] = [];

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(mermaid)) {
      findings.push({ rule: rule.rule, severity: "error", message: rule.message });
    }
  }

  const lint = lintMermaid(mermaid, { ...DEFAULT_BUDGET, maxNodesHard: MAX_DIAGRAM_NODES });
  findings.push(...lint.findings);

  if (!lint.ok || findings.some((finding) => finding.severity === "error")) {
    return { ok: false, findings };
  }

  return {
    ok: true,
    value: {
      mermaid,
      theme: theme ?? "default",
      ...(title ? { title } : {}),
    },
  };
}

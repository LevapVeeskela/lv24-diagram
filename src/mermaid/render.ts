import {
  createMermaidRenderer,
  type MermaidRenderer,
  type RenderResult,
} from "mermaid-isomorphic";

const THEMES = ["default", "base", "dark", "forest", "neutral"] as const;
export type MermaidTheme = (typeof THEMES)[number];

export function isMermaidTheme(value: string): value is MermaidTheme {
  return (THEMES as readonly string[]).includes(value);
}

export interface RenderOptions {
  /** Render a PNG screenshot (default true). */
  png?: boolean;
  theme?: MermaidTheme;
  backgroundColor?: string;
}

export interface RenderedDiagram {
  svg: string;
  png?: Buffer;
  width: number;
  height: number;
}

let renderer: MermaidRenderer | undefined;

function getRenderer(): MermaidRenderer {
  // createMermaidRenderer reuses one browser and closes it when idle.
  renderer ??= createMermaidRenderer();
  return renderer;
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export async function renderMermaid(
  source: string,
  options: RenderOptions = {},
): Promise<RenderedDiagram> {
  const wantPng = options.png !== false;
  const results = await getRenderer()([source], {
    screenshot: wantPng,
    mermaidConfig: {
      theme: options.theme ?? "default",
    },
    containerStyle: {
      backgroundColor: options.backgroundColor ?? "#ffffff",
    },
  });

  const first = results[0];
  if (!first) throw new Error("Mermaid renderer returned no result");
  if (first.status === "rejected") {
    throw new Error(`Mermaid render failed: ${reasonText(first.reason)}`);
  }

  const value: RenderResult = first.value;
  return {
    svg: value.svg,
    ...(wantPng && value.screenshot ? { png: value.screenshot } : {}),
    width: value.width,
    height: value.height,
  };
}

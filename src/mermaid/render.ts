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
  /**
   * Render at the intrinsic SVG size instead of shrinking wide diagrams to the page width.
   * The HTTP service uses this so a 40-node chart is downscaled once, deliberately, to 2400 px.
   */
  fullWidth?: boolean;
}

/** Mermaid defaults each diagram to width=100%, which clips wide charts to the page. */
const INTRINSIC_WIDTH_CONFIG = {
  flowchart: { useMaxWidth: false },
  sequence: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  gantt: { useMaxWidth: false },
  pie: { useMaxWidth: false },
  journey: { useMaxWidth: false },
  requirement: { useMaxWidth: false },
  c4: { useMaxWidth: false },
} as const;

export interface RenderedDiagram {
  svg: string;
  png?: Buffer;
  /** Pixel width of the PNG when rendered, otherwise the SVG layout width. */
  width: number;
  /** Pixel height of the PNG when rendered, otherwise the SVG layout height. */
  height: number;
  /** Layout width of the rendered SVG (CSS units), not the screenshot size. */
  layoutWidth: number;
  layoutHeight: number;
  /** Actual PNG pixel size, parsed from the IHDR chunk. */
  pngWidth?: number;
  pngHeight?: number;
}

const PNG_SIGNATURE = "89504e470d0a1a0a";

/** Reads the real pixel size from the PNG IHDR chunk (bytes 16..23). */
export function pngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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
      securityLevel: "strict",
      ...(options.fullWidth ? INTRINSIC_WIDTH_CONFIG : {}),
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
  const size = wantPng && value.screenshot ? pngSize(value.screenshot) : undefined;
  return {
    svg: value.svg,
    ...(wantPng && value.screenshot ? { png: value.screenshot } : {}),
    width: size?.width ?? value.width,
    height: size?.height ?? value.height,
    layoutWidth: value.width,
    layoutHeight: value.height,
    ...(size ? { pngWidth: size.width, pngHeight: size.height } : {}),
  };
}

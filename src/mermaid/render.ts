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

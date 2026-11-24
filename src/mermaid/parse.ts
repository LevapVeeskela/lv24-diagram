export type DiagramType = "flowchart" | "sequence" | "er" | "class" | "state" | "unknown";

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ParsedDiagram {
  type: DiagramType;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const ID_STICKY = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/uy;

const FLOW_SKIP = /^(?:subgraph\b|end\b|direction\b|style\b|classDef\b|class\b|linkStyle\b|click\b|accTitle\b|accDescr\b|%%|\{)/;

const OPERATORS = ["<-.->", "<-->", "-.->", "==>", "-->", "---", "--o", "--x", "~~~", "->"] as const;

function skipSpaces(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  return i;
}

function stripFrontMatter(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return source;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return source;
  return lines.slice(end + 1).join("\n");
}

function stripComments(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface NodeRef {
  id: string;
  label: string;
  next: number;
}

function readLabel(text: string, index: number): { label?: string; next: number } {
  const rest = text.slice(index);
  const pairs: Array<[string, string]> = [
    ["[[", "]]"],
    ["((", "))"],
    ["[(", ")]"],
    ["{{", "}}"],
    ["[/", "/]"],
    ["[\\", "\\]"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
    [">", "]"],
  ];
  for (const [open, close] of pairs) {
    if (!rest.startsWith(open)) continue;
    const end = text.indexOf(close, index + open.length);
    if (end < 0) return { next: index };
    return { label: unquote(text.slice(index + open.length, end)), next: end + close.length };
  }
  return { next: index };
}

function readNodeRef(text: string, index: number): NodeRef | undefined {
  const start = skipSpaces(text, index);
  ID_STICKY.lastIndex = start;
  const match = ID_STICKY.exec(text);
  if (!match) return undefined;
  const id = match[0];
  const afterId = start + id.length;
  const { label, next } = readLabel(text, afterId);
  // `A:::className` or `A@{}` decorations are not labels.
  let cursor = next;
  if (cursor === afterId) {
    while (text[cursor] === ":" || text[cursor] === "@") {
      cursor += 1;
      ID_STICKY.lastIndex = cursor;
      const decoration = ID_STICKY.exec(text);
      if (!decoration) break;
      cursor += decoration[0].length;
    }
  }
  return { id, label: label ?? id, next: cursor };
}

function readOperator(text: string, index: number): { next: number } | undefined {
  for (const operator of OPERATORS) {
    if (text.startsWith(operator, index)) return { next: index + operator.length };
  }
  return undefined;
}

function splitStatements(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of line) {
    if ("[({".includes(char)) depth += 1;
    if ("])}".includes(char)) depth = Math.max(0, depth - 1);
    if (char === ";" && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

interface Collector {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

function addNode(collector: Collector, node: GraphNode): void {
  const existing = collector.nodes.get(node.id);
  if (!existing) {
    collector.nodes.set(node.id, node);
    return;
  }
  if (existing.label === existing.id && node.label !== node.id) {
    collector.nodes.set(node.id, node);
  }
}

function parseFlowchartLine(line: string, collector: Collector): void {
  for (const statement of splitStatements(line)) {
    if (FLOW_SKIP.test(statement)) continue;
    const first = readNodeRef(statement, 0);
    if (!first) continue;
    let current = first;
    let linked = false;
    for (;;) {
      const operator = readOperator(statement, skipSpaces(statement, current.next));
      if (!operator) break;
      linked = true;
      let cursor = skipSpaces(statement, operator.next);
      let label: string | undefined;
      if (statement[cursor] === "|") {
        const end = statement.indexOf("|", cursor + 1);
        if (end > cursor) {
          label = statement.slice(cursor + 1, end).trim();
          cursor = end + 1;
        }
      }
      const next = readNodeRef(statement, cursor);
      if (!next) break;
      addNode(collector, { id: current.id, label: current.label });
      addNode(collector, { id: next.id, label: next.label });
      collector.edges.push({
        from: current.id,
        to: next.id,
        ...(label ? { label } : {}),
      });
      current = next;
    }
    if (!linked) addNode(collector, { id: first.id, label: first.label });
  }
}

const SEQUENCE_SKIP =
  /^(?:%%|autonumber\b|title\b|note\b|loop\b|alt\b|else\b|opt\b|par\b|and\b|critical\b|break\b|rect\b|activate\b|deactivate\b|end\b)/;

const SEQUENCE_MESSAGE =
  /^(\S+?)\s*(?:-->>|->>|-->|->|--\)|-\)|--x|-x)\s*[+-]?\s*(\S+?)\s*:\s*(.*)$/;

function parseSequence(lines: string[]): ParsedDiagram {
  const collector: Collector = { nodes: new Map(), edges: [] };
  for (const line of lines) {
    if (SEQUENCE_SKIP.test(line)) continue;
    const participant = /^(?:participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(line);
    if (participant) {
      const id = participant[1] ?? "";
      addNode(collector, { id, label: unquote(participant[2] ?? id) });
      continue;
    }
    const message = SEQUENCE_MESSAGE.exec(line);
    if (!message) continue;
    const from = message[1] ?? "";
    const to = message[2] ?? "";
    addNode(collector, { id: from, label: from });
    addNode(collector, { id: to, label: to });
    const label = (message[3] ?? "").trim();
    collector.edges.push({ from, to, ...(label ? { label } : {}) });
  }
  return { type: "sequence", nodes: [...collector.nodes.values()], edges: collector.edges };
}

const ER_RELATION =
  /^(\w+)\s+([|o}{-]{1,4}(?:--|\.\.)[|o}{-]{1,4})\s+(\w+)\s*:\s*("?)(.+?)\4\s*$/;

function parseEr(lines: string[]): ParsedDiagram {
  const collector: Collector = { nodes: new Map(), edges: [] };
  for (const line of lines) {
    const relation = ER_RELATION.exec(line);
    if (relation) {
      const from = relation[1] ?? "";
      const to = relation[3] ?? "";
      addNode(collector, { id: from, label: from });
      addNode(collector, { id: to, label: to });
      const label = (relation[5] ?? "").trim();
      collector.edges.push({ from, to, ...(label ? { label } : {}) });
      continue;
    }
    const entity = /^(\w+)\s*\{\s*$/.exec(line);
    if (entity) {
      const id = entity[1] ?? "";
      addNode(collector, { id, label: id });
      continue;
    }
  }
  return { type: "er", nodes: [...collector.nodes.values()], edges: collector.edges };
}

const CLASS_RELATION = /^(\w+)\s*(<\|--|--\|>|\*--|--\*|o--|--o|\.\.\|>|<\|\.\.|-->|--|\.\.>)\s*(\w+)/;

function parseClass(lines: string[]): ParsedDiagram {
  const collector: Collector = { nodes: new Map(), edges: [] };
  for (const line of lines) {
    const declaration = /^class\s+(\w+)(?:\s+as\s+(.+))?/.exec(line);
    if (declaration) {
      const id = declaration[1] ?? "";
      addNode(collector, { id, label: unquote(declaration[2] ?? id) });
      continue;
    }
    const relation = CLASS_RELATION.exec(line);
    if (relation) {
      const from = relation[1] ?? "";
      const to = relation[3] ?? "";
      addNode(collector, { id: from, label: from });
      addNode(collector, { id: to, label: to });
      collector.edges.push({ from, to });
    }
  }
  return { type: "class", nodes: [...collector.nodes.values()], edges: collector.edges };
}

function parseState(lines: string[]): ParsedDiagram {
  const collector: Collector = { nodes: new Map(), edges: [] };
  for (const line of lines) {
    const declaration = /^state\s+"?(.+?)"?\s+as\s+(\w+)$/.exec(line);
    if (declaration) {
      addNode(collector, { id: declaration[2] ?? "", label: declaration[1] ?? "" });
      continue;
    }
    const transition = /^(\S+)\s*-->\s*(\S+?)(?:\s*:\s*(.*))?$/.exec(line);
    if (!transition) continue;
    const from = transition[1] ?? "";
    const to = transition[2] ?? "";
    addNode(collector, { id: from, label: from });
    addNode(collector, { id: to, label: to });
    const label = (transition[3] ?? "").trim();
    collector.edges.push({ from, to, ...(label ? { label } : {}) });
  }
  return { type: "state", nodes: [...collector.nodes.values()], edges: collector.edges };
}

export function detectDiagramType(source: string): DiagramType {
  for (const line of stripComments(stripFrontMatter(source))) {
    if (/^(?:flowchart|graph)\b/.test(line)) return "flowchart";
    if (/^sequenceDiagram\b/.test(line)) return "sequence";
    if (/^erDiagram\b/.test(line)) return "er";
    if (/^classDiagram\b/.test(line)) return "class";
    if (/^stateDiagram(?:-v2)?\b/.test(line)) return "state";
    if (/^(?:gantt|pie|journey|mindmap|timeline|quadrantChart|gitGraph|C4Context|block-beta|sankey-beta|xychart-beta|packet-beta|architecture-beta)\b/.test(line)) {
      return "unknown";
    }
  }
  return "unknown";
}

/**
 * Parses the common subset of Mermaid used for review: node/edge structure and labels.
 * Exotic syntax (custom shapes with nested brackets, `-- long label -->`, styling) is
 * intentionally ignored; the linter only needs topology and label sizes.
 */
export function parseMermaid(source: string): ParsedDiagram {
  const body = stripFrontMatter(source);
  const type = detectDiagramType(body);
  const lines = stripComments(body);

  switch (type) {
    case "flowchart": {
      const collector: Collector = { nodes: new Map(), edges: [] };
      for (const line of lines.slice(1)) parseFlowchartLine(line, collector);
      return { type, nodes: [...collector.nodes.values()], edges: collector.edges };
    }
    case "sequence":
      return parseSequence(lines.slice(1));
    case "er":
      return parseEr(lines.slice(1));
    case "class":
      return parseClass(lines.slice(1));
    case "state":
      return parseState(lines.slice(1));
    default:
      return { type: "unknown", nodes: [], edges: [] };
  }
}

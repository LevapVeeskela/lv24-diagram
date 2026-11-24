import { parseMermaid, type DiagramType, type ParsedDiagram } from "./parse.js";

export type Severity = "error" | "warning" | "info";

export interface LintFinding {
  rule: string;
  severity: Severity;
  message: string;
}

export interface LintBudget {
  maxNodes: number;
  maxNodesHard: number;
  maxDepth: number;
  maxLabelLength: number;
  maxUnlabeledRatio: number;
  maxSequenceParticipants: number;
  maxErEntities: number;
}

export interface LintStats {
  type: DiagramType;
  nodes: number;
  edges: number;
  depth: number;
  cycles: number;
  unlabeledEdges: number;
  longestLabel: number;
}

export interface LintResult {
  ok: boolean;
  stats: LintStats;
  findings: LintFinding[];
}

export const DEFAULT_BUDGET: LintBudget = {
  maxNodes: 15,
  maxNodesHard: 25,
  maxDepth: 3,
  maxLabelLength: 40,
  maxUnlabeledRatio: 0.5,
  maxSequenceParticipants: 8,
  maxErEntities: 12,
};

function buildAdjacency(parsed: ParsedDiagram): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of parsed.nodes) adjacency.set(node.id, []);
  for (const edge of parsed.edges) {
    const bucket = adjacency.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  return adjacency;
}

/** Returns the nodes of the first cycle found, or an empty array for a DAG. */
export function findCycle(parsed: ParsedDiagram): string[] {
  const adjacency = buildAdjacency(parsed);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start === -1 ? 0 : start), next];
      }
      if (seen === 0) {
        const found = visit(next);
        if (found.length > 0) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return [];
  };

  for (const node of adjacency.keys()) {
    if ((state.get(node) ?? 0) !== 0) continue;
    const found = visit(node);
    if (found.length > 0) return found;
  }
  return [];
}

/** Longest path in a DAG (in edges); 0 when the graph has a cycle or no edges. */
export function graphDepth(parsed: ParsedDiagram): number {
  if (findCycle(parsed).length > 0) return 0;
  const adjacency = buildAdjacency(parsed);
  const memo = new Map<string, number>();
  const depthOf = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    const children = adjacency.get(node) ?? [];
    const depth = children.length === 0 ? 0 : 1 + Math.max(...children.map(depthOf));
    memo.set(node, depth);
    return depth;
  };
  let best = 0;
  for (const node of adjacency.keys()) best = Math.max(best, depthOf(node));
  return best;
}

export function lintMermaid(source: string, budget: LintBudget = DEFAULT_BUDGET): LintResult {
  const parsed = parseMermaid(source);
  const findings: LintFinding[] = [];
  const unlabeledEdges = parsed.edges.filter((edge) => !edge.label).length;
  const longestLabel = parsed.nodes.reduce(
    (max, node) => Math.max(max, node.label.length),
    0,
  );
  const cycle = findCycle(parsed);
  const depth = graphDepth(parsed);

  if (parsed.type === "unknown") {
    findings.push({
      rule: "diagram-type",
      severity: "warning",
      message:
        "Diagram type is not recognised by the linter; only structure-aware checks are skipped.",
    });
  }

  if (parsed.nodes.length === 0) {
    findings.push({
      rule: "empty",
      severity: "error",
      message: "No nodes were parsed — the diagram is empty or uses unsupported syntax.",
    });
  }

  if (parsed.nodes.length > budget.maxNodesHard) {
    findings.push({
      rule: "node-budget",
      severity: "error",
      message: `${parsed.nodes.length} nodes exceed the hard limit of ${budget.maxNodesHard}; split the diagram.`,
    });
  } else if (parsed.nodes.length > budget.maxNodes) {
    findings.push({
      rule: "node-budget",
      severity: "warning",
      message: `${parsed.nodes.length} nodes is above the recommended ${budget.maxNodes} for an overview diagram.`,
    });
  }

  if (parsed.type === "sequence" && parsed.nodes.length > budget.maxSequenceParticipants) {
    findings.push({
      rule: "participants",
      severity: "warning",
      message: `${parsed.nodes.length} participants exceed the recommended ${budget.maxSequenceParticipants}.`,
    });
  }

  if (parsed.type === "er" && parsed.nodes.length > budget.maxErEntities) {
    findings.push({
      rule: "entities",
      severity: "warning",
      message: `${parsed.nodes.length} entities exceed the recommended ${budget.maxErEntities}; filter tables.`,
    });
  }

  if (cycle.length > 0) {
    findings.push({
      rule: "cycle",
      severity: "warning",
      message: `Cycle detected: ${cycle.join(" → ")}. Cycles make flow diagrams hard to read; break the loop or move it to a state diagram.`,
    });
  }

  if (depth > budget.maxDepth) {
    findings.push({
      rule: "depth",
      severity: "warning",
      message: `Graph depth is ${depth} levels (recommended ≤ ${budget.maxDepth}). Collapse details into a second diagram.`,
    });
  }

  if (longestLabel > budget.maxLabelLength) {
    findings.push({
      rule: "label-length",
      severity: "warning",
      message: `A node label is ${longestLabel} characters (recommended ≤ ${budget.maxLabelLength}). Move long paths into a table.`,
    });
  }

  const ratio = parsed.edges.length === 0 ? 0 : unlabeledEdges / parsed.edges.length;
  if (ratio > budget.maxUnlabeledRatio) {
    findings.push({
      rule: "edge-labels",
      severity: "warning",
      message: `${unlabeledEdges} of ${parsed.edges.length} edges have no label; add short labels (HTTPS, push, issue).`,
    });
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    stats: {
      type: parsed.type,
      nodes: parsed.nodes.length,
      edges: parsed.edges.length,
      depth,
      cycles: cycle.length > 0 ? 1 : 0,
      unlabeledEdges,
      longestLabel,
    },
    findings,
  };
}

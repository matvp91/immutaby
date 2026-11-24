/** Pure builders for generated code. */
import type * as Ast from "./ast.ts";

/** Namespace the runtime is imported as. */
export const RUNTIME = "__imm";
/** Name of a block's runtime context, and prefix for the block's other generated variables. */
export const CONTEXT = "__imm_c";

/** A piece of generated code: text, or a source node kept in place (so its own edits and sourcemap survive). */
export type Part = string | Ast.Node;

/** Replace the source range [start, end) with `parts`. */
export interface Edit {
  start: number;
  end: number;
  parts: Part[];
}

/**
 * One key of a state path: a string literal (`'"name"'`) or other code made by
 * the compiler, a computed key node (`[node]`), or several parts for a `find` key.
 */
export type PathKey = Part[];

/**
 * A local that points into state, compiled away: reads become the location
 * `root` plus `keys`, and writes go to that location. Keys are code: string
 * literals, or expressions over variables the compiler controls (an index
 * parameter, or a holder array with keys captured when the alias was created).
 */
export interface Alias {
  root: string;
  keys: string[];
}

/** A key that is plain code (no source node), so it can be repeated freely. */
export const isPlainKey = (key: PathKey): key is [string] => key.length === 1 && typeof key[0] === "string";

/** `base.name` when `key` is a string literal holding a valid identifier, else `base[key]`. */
export function member(base: string, key: string): string {
  const name = key.startsWith('"') ? JSON.parse(key) : undefined;
  return typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${key}]`;
}

/** Code reading an alias's location in the current state. */
export const aliasRead = (alias: Alias): string => alias.keys.reduce(member, alias.root);

export const joinArguments = (nodes: Part[]): Part[] => nodes.flatMap((node, i) => (i ? [", ", node] : [node]));
export const joinKeys = (keys: PathKey[]): Part[] => keys.flatMap((key, i) => (i ? [", ", ...key] : key));

/**
 * A helper call that rebinds the root: `root = helper(..., root)` as a
 * statement, or `(root = helper(..., root), context.slot)` as an expression.
 */
export function helperWrite(root: string, helperCall: Part[], asExpression: boolean, resultSlot: "result" | "previousValue"): Part[] {
  const write = [`${root} = ${RUNTIME}.`, ...helperCall, `, ${root})`];
  return asExpression ? ["(", ...write, `, ${CONTEXT}.${resultSlot})`] : write;
}

export type InlineWrite =
  | { kind: "set"; value: Ast.Node }
  | { kind: "compound"; operator: string; value: Ast.Node }
  | { kind: "update"; operator: string }
  | { kind: "delete" };

/** Allocates the variables inline writes need. */
export interface InlineVariables {
  /** The variable holding the block's copy of the node at `path` (named by source, e.g. `s["user"]`). */
  copyOf(path: string): string;
  /** A fresh variable for a computed key. */
  nextKey(): string;
}

/**
 * A statement-level write to `root` plus `keys`, compiled to inline copies:
 *
 *   s.user.name = v  →  { const v' = v; if (!isUnchanged(s.user, "name", v')) {
 *                         if (s !== c0) s = c0 = shallowCopy(s);
 *                         if (s.user !== c1) s.user = c1 = shallowCopy(s.user);
 *                         s.user.name = v'; } }
 *
 * `c0`/`c1` hold the block's copies, so each node is copied once; the identity
 * check keeps that correct through loops, branches and anything else that
 * rebinds the root.
 */
export function inlineWrite(root: string, keys: PathKey[], write: InlineWrite, sourceOf: (node: Ast.Node) => string, variables: InlineVariables): Part[] {
  const code: Part[] = ["{ "];
  // Code reading each node on the path (root first), and the source-based name of its copy variable.
  const nodes = [root];
  const names = [root];
  let lastKey = "";
  keys.forEach(([key], i) => {
    if (typeof key === "string") lastKey = key;
    else {
      lastKey = variables.nextKey();
      code.push(`const ${lastKey} = `, key, "; ");
    }
    if (i === keys.length - 1) return;
    nodes.push(member(nodes[i], lastKey));
    names.push(`${names[i]}[${typeof key === "string" ? key : sourceOf(key)}]`);
  });

  const parent = nodes[nodes.length - 1];
  const target = member(parent, lastKey);
  const value = `${CONTEXT}_v`;
  if (write.kind === "set") code.push(`const ${value} = `, write.value, "; ");
  if (write.kind === "compound") code.push(`const ${value} = ${target} ${write.operator} (`, write.value, "); ");
  if (write.kind === "update") code.push(`let ${value} = ${target}; ${value}${write.operator}; `);

  const copies = nodes
    .map((node, i) => {
      const copy = variables.copyOf(names[i]);
      return `if (${node} !== ${copy}) ${node} = ${copy} = ${RUNTIME}.shallowCopy(${node}); `;
    })
    .join("");
  if (write.kind === "delete") code.push(`if (${lastKey} in ${parent}) { ${copies}delete ${target}; } }`);
  else code.push(`if (!${RUNTIME}.isUnchanged(${parent}, ${lastKey}, ${value})) { ${copies}${target} = ${value}; } }`);
  return code;
}

export interface BlockWrapperInput {
  usesContext: boolean;
  copyVariables: string[];
  /** Roots that lent state to opaque calls: sharing is restored when the block ends. */
  lentRoots: string[];
  /** Roots deep-frozen when the block ends. */
  frozenRoots: string[];
}

/** Code opening and closing a compiled block's body. */
export function blockWrapper({ usesContext, copyVariables, lentRoots, frozenRoots }: BlockWrapperInput): { open: string; close: string } {
  const open: string[] = [];
  if (usesContext) open.push(`const ${CONTEXT} = ${RUNTIME}.createContext();`);
  if (copyVariables.length) open.push(`let ${copyVariables.join(", ")};`);
  if (!lentRoots.length && !frozenRoots.length) return { open: open.join(" "), close: "" };

  const base = (root: string) => `${CONTEXT}_base_${root}`;
  if (lentRoots.length) open.push(`const ${lentRoots.map((root) => `${base(root)} = ${root}`).join(", ")};`);
  open.push("try {");
  const atEnd = [
    ...lentRoots.map((root) => `${root} = ${RUNTIME}.restoreSharing(${CONTEXT}, ${root}, ${base(root)});`),
    ...frozenRoots.map((root) => `${RUNTIME}.deepFreeze(${root});`),
  ];
  return { open: open.join(" "), close: ` } finally { ${atEnd.join(" ")} }` };
}

export const runtimeImport = (specifier: string): string => `import * as ${RUNTIME} from ${JSON.stringify(specifier)};\n`;

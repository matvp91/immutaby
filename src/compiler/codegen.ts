import type * as Ast from "./ast.ts";

// The only module that knows the shape of generated code: the runtime's
// namespace and helpers, and the names of generated variables. Every function
// is pure except the allocator `createNames` returns.

// Namespace the runtime is imported as.
const RUNTIME = "__imm";

// Name of a block's runtime context, and prefix for the block's other
// generated variables.
const CONTEXT = "__imm_c";

/**
 * A piece of generated code: text, or a source node kept in place (so its own
 * edits and sourcemap survive).
 */
export type Part = string | Ast.Node;

/**
 * Replace the source range [start, end) with `parts`.
 */
export interface Edit {
  start: number;
  end: number;
  parts: Part[];
}

/**
 * One key of a state path: a string literal (`'"name"'`) or other code made by
 * the compiler, a computed key node (`[node]`), or several parts for a `find`
 * key.
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

/**
 * A key that is plain code (no source node), so it can be repeated freely.
 */
export const isPlainKey = (key: PathKey): key is [string] =>
  key.length === 1 && typeof key[0] === "string";

/**
 * `base.name` when `key` is a string literal holding a valid identifier, else
 * `base[key]`.
 */
export function member(base: string, key: string): string {
  const name = key.startsWith('"') ? JSON.parse(key) : undefined;
  return typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name)
    ? `${base}.${name}`
    : `${base}[${key}]`;
}

/**
 * Code reading an alias's location in the current state.
 */
export const aliasRead = (alias: Alias): string =>
  alias.keys.reduce(member, alias.root);

// `parts` separated by commas, as in an argument list.
const joinArguments = (nodes: Part[]): Part[] =>
  nodes.flatMap((node, i) => (i ? [", ", node] : [node]));

// `keys` as an array literal of path keys.
const keyArray = (keys: PathKey[]): Part[] => [
  "[",
  ...keys.flatMap((key, i) => (i ? [", ", ...key] : key)),
  "]",
];

/**
 * Allocates a pass's generated variables.
 */
export interface Names {
  /**
   * The variable holding the block's copy of the node at `path` (named by
   * source, e.g. `s["user"]`).
   */
  copyOf(path: string): string;

  /**
   * A fresh variable for a computed key.
   */
  nextKey(): string;

  /**
   * A fresh variable for an index parameter added to a callback.
   */
  nextIndex(): string;

  /**
   * The copy variables allocated so far, declared when the block opens.
   */
  copies(): string[];
}

export function createNames(): Names {
  const copies = new Map<string, string>();
  let counter = 0;
  return {
    copyOf(path) {
      let variable = copies.get(path);
      if (!variable) {
        variable = `${CONTEXT}_${copies.size}`;
        copies.set(path, variable);
      }
      return variable;
    },
    nextKey: () => `${CONTEXT}_k${++counter}`,
    nextIndex: () => `${CONTEXT}_i${++counter}`,
    copies: () => [...copies.values()],
  };
}

/**
 * A path key resolved at runtime: the index the find-index `method` gives for
 * the predicate in `args` (`s.todos.find(p)`).
 */
export const findKey = (method: string, args: Part[]): PathKey => [
  `${RUNTIME}.Path.findIndexKey(${JSON.stringify(method)}, `,
  ...joinArguments(args),
  ")",
];

/**
 * The value an alias's holder is initialised with: its path's keys, captured
 * now, with any `find` key resolved once against `root`.
 */
export function pathHolder(
  root: string,
  keys: PathKey[],
  hasFindKey: boolean,
): Part[] {
  return hasFindKey
    ? [`${RUNTIME}.Path.resolve(`, ...keyArray(keys), `, ${root})`]
    : keyArray(keys);
}

/**
 * `for (const item of list)` as an index loop over `list`, which must be an
 * array.
 */
export function indexLoopHeader(item: string, list: string): string {
  const start = `(${RUNTIME}.Path.assertArray(${list}), 0)`;
  return `for (let ${item} = ${start}; ${item} < ${list}.length; ${item}++) `;
}

/**
 * The paths of the elements of the array at `root` plus `keys`, for a
 * `for...of` over a path that isn't plain.
 */
export const elementsCall = (root: string, keys: PathKey[]): Part[] => [
  `${RUNTIME}.Path.elements(() => ${root}, `,
  ...keyArray(keys),
  ")",
];

/**
 * A callback's element parameter followed by an added index parameter.
 */
export const withIndexParam = (
  element: Ast.Node,
  index: string,
  hasParens: boolean,
): Part[] =>
  hasParens ? [element, `, ${index}`] : ["(", element, `, ${index})`];

/**
 * An iteration method call on the array at `root` plus `keys` whose callback
 * gets element paths instead of elements.
 */
export const iterateCall = (
  root: string,
  keys: PathKey[],
  method: string,
  args: Part[],
): Part[] => [
  `${RUNTIME}.Path.iterate(`,
  ...keyArray(keys),
  `, ${JSON.stringify(method)}, [`,
  ...joinArguments(args),
  `], ${root})`,
];

/**
 * Lends a deep copy of the state at `root` plus `keys` to an opaque call: the
 * root is rebound and the copy is the expression's value.
 */
export const lendCall = (root: string, keys: PathKey[]): Part[] => [
  `(${root} = ${RUNTIME}.Lending.lend(${CONTEXT}, `,
  ...keyArray(keys),
  `, ${root}), ${CONTEXT}.result)`,
];

export type HelperWrite =
  | { kind: "set"; value: Ast.Node }
  | { kind: "compound"; operator: string; value: Ast.Node }
  | { kind: "increment"; delta: 1 | -1; prefix: boolean }
  | { kind: "remove" }

  /**
   * `method` is a string literal, or the computed key node.
   */
  | { kind: "callMethod"; method: Part; args: Ast.Node[] };

function helperCall(root: string, keys: PathKey[], write: HelperWrite): Part[] {
  const path = keyArray(keys);
  switch (write.kind) {
    case "set":
      return [`Path.write(${CONTEXT}, `, ...path, ", ", write.value];
    case "compound":
      return [
        `Path.write(${CONTEXT}, ${CONTEXT}.compoundPath = `,
        ...path,
        `, ${RUNTIME}.Path.read(${root}, ${CONTEXT}.compoundPath) `,
        `${write.operator} (`,
        write.value,
        ")",
      ];
    case "increment":
      return [`Path.increment(${CONTEXT}, `, ...path, `, ${write.delta}`];
    case "remove":
      return [`Path.remove(${CONTEXT}, `, ...path];
    case "callMethod":
      return [
        `Path.callMethod(${CONTEXT}, `,
        ...path,
        ", ",
        write.method,
        ", [",
        ...joinArguments(write.args),
        "]",
      ];
  }
}

/**
 * A write to `root` plus `keys` through a runtime helper that rebinds the
 * root: `root = helper(..., root)` as a statement, or `(root = helper(...,
 * root), context.result)` as an expression. The root is passed last so it is
 * read after the right-hand side has run, which keeps writes nested in the
 * right-hand side.
 */
export function helperWrite(
  root: string,
  keys: PathKey[],
  write: HelperWrite,
  asExpression: boolean,
): Part[] {
  const code = [
    `${root} = ${RUNTIME}.`,
    ...helperCall(root, keys, write),
    `, ${root})`,
  ];
  if (!asExpression) {
    return code;
  }
  const slot =
    write.kind === "increment" && !write.prefix ? "previousValue" : "result";
  return ["(", ...code, `, ${CONTEXT}.${slot})`];
}

export type InlineWrite =
  | { kind: "set"; value: Ast.Node }
  | { kind: "compound"; operator: string; value: Ast.Node }
  | { kind: "update"; operator: string }
  | { kind: "delete" };

/**
 * A statement-level write to `root` plus `keys`, compiled to inline copies.
 * `s.user.name = v` becomes:
 *
 *   {
 *     const v' = v;
 *     if (!Path.isUnchanged(s.user, "name", v')) {
 *       if (s !== c0) s = c0 = Draft.shallowCopy(s);
 *       if (s.user !== c1) s.user = c1 = Draft.shallowCopy(s.user);
 *       s.user.name = v';
 *     }
 *   }
 *
 * `c0`/`c1` hold the block's copies, so each node is copied once; the identity
 * check keeps that correct through loops, branches and anything else that
 * rebinds the root.
 */
export function inlineWrite(
  root: string,
  keys: PathKey[],
  write: InlineWrite,
  sourceOf: (node: Ast.Node) => string,
  names: Names,
): Part[] {
  const code: Part[] = ["{ "];

  // Code reading each node on the path (root first), and the source-based name
  // of its copy variable.
  const nodes = [root];
  const paths = [root];
  let lastKey = "";
  keys.forEach(([key], i) => {
    if (typeof key === "string") {
      lastKey = key;
    } else {
      lastKey = names.nextKey();
      code.push(`const ${lastKey} = `, key, "; ");
    }
    if (i === keys.length - 1) {
      return;
    }
    nodes.push(member(nodes[i], lastKey));
    paths.push(`${paths[i]}[${typeof key === "string" ? key : sourceOf(key)}]`);
  });

  const parent = nodes[nodes.length - 1];
  const target = member(parent, lastKey);
  const value = `${CONTEXT}_v`;
  if (write.kind === "set") {
    code.push(`const ${value} = `, write.value, "; ");
  }
  if (write.kind === "compound") {
    code.push(
      `const ${value} = ${target} ${write.operator} (`,
      write.value,
      "); ",
    );
  }
  if (write.kind === "update") {
    code.push(`let ${value} = ${target}; ${value}${write.operator}; `);
  }

  const copies = nodes
    .map((node, i) => {
      const copy = names.copyOf(paths[i]);
      const shallowCopy = `${RUNTIME}.Draft.shallowCopy(${node})`;
      return `if (${node} !== ${copy}) ${node} = ${copy} = ${shallowCopy}; `;
    })
    .join("");
  if (write.kind === "delete") {
    code.push(`if (${lastKey} in ${parent}) { ${copies}delete ${target}; } }`);
  } else {
    const args = `${parent}, ${lastKey}, ${value}`;
    const isUnchanged = `${RUNTIME}.Path.isUnchanged(${args})`;
    code.push(`if (!${isUnchanged}) { ${copies}${target} = ${value}; } }`);
  }
  return code;
}

export interface BlockWrapperInput {
  usesContext: boolean;
  copyVariables: string[];

  /**
   * Roots that lent state to opaque calls: sharing is restored when the block
   * ends.
   */
  lentRoots: string[];

  /**
   * Roots deep-frozen when the block ends.
   */
  frozenRoots: string[];
}

/**
 * Code opening and closing a compiled block's body.
 */
export function blockWrapper({
  usesContext,
  copyVariables,
  lentRoots,
  frozenRoots,
}: BlockWrapperInput): {
  open: string;
  close: string;
} {
  const open: string[] = [];
  if (usesContext) {
    open.push(`const ${CONTEXT} = ${RUNTIME}.Draft.createContext();`);
  }
  if (copyVariables.length) {
    open.push(`let ${copyVariables.join(", ")};`);
  }
  if (!lentRoots.length && !frozenRoots.length) {
    return { open: open.join(" "), close: "" };
  }

  const base = (root: string) => `${CONTEXT}_base_${root}`;
  if (lentRoots.length) {
    open.push(
      `const ${lentRoots.map((root) => `${base(root)} = ${root}`).join(", ")};`,
    );
  }
  open.push("try {");
  const atEnd = [
    ...lentRoots.map((root) => {
      const args = `${CONTEXT}, ${root}, ${base(root)}`;
      const restored = `${RUNTIME}.Lending.restoreSharing(${args})`;
      return `${root} = ${restored};`;
    }),
    ...frozenRoots.map((root) => `${RUNTIME}.Draft.freeze(${root});`),
  ];
  return { open: open.join(" "), close: ` } finally { ${atEnd.join(" ")} }` };
}

/**
 * The import of the runtime namespace, prepended to compiled modules.
 */
export const runtimeImport = (specifier: string): string =>
  `import * as ${RUNTIME} from ${JSON.stringify(specifier)};\n`;

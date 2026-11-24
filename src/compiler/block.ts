import type * as Options from "../options.ts";
import * as Aliases from "./aliases.ts";
import * as Ast from "./ast.ts";
import * as Calls from "./calls.ts";
import type { Alias, Edit, InlineVariables, Part } from "./codegen.ts";
import { CONTEXT } from "./codegen.ts";
import type { Warning } from "./errors.ts";
import type * as State from "./state.ts";
import * as Writes from "./writes.ts";

/** A scope inside the block. */
export interface Scope {
  bindings: ReadonlyMap<string, Ast.BindingKind>;
  /** Locals compiled to state locations. */
  aliases: Map<string, Alias>;
  /** Locals that may point into state, with their binding node when they can become an alias (else null). */
  maybeState: Map<string, Ast.Node | null>;
}

/** An inline callback of an iteration method on state: it runs synchronously, and its element may be an alias. */
export interface IterationCallback {
  receiver: State.Path;
  elementIndex: number;
  elementAlias?: Alias;
}

export interface Output {
  edits: Edit[];
  warnings: Warning[];
  /** Roots the block writes to (frozen at the end in dev builds). */
  writtenRoots: Set<string>;
  /** Roots that lent state to opaque calls (sharing is restored at the end). */
  lentRoots: Set<string>;
  /** Whether any helper uses the block's runtime context. */
  usesContext: boolean;
  /** Whether the block contains `break mut`, so the label must stay. */
  breaksOut: boolean;
  /** Copy variables of inline writes, by the source of the node they copy. */
  copyVariables: Map<string, string>;
}

export interface Input {
  code: string;
  options: Options.Resolved;
  /** Whether statement-level writes to direct paths are compiled inline. */
  inline: boolean;
  /** The ancestors of the `mut:` label, where roots are declared. */
  enclosing: readonly Ast.Node[];
  /** Bindings that earlier passes found written through: they are compiled as aliases. */
  promoted: WeakSet<Ast.Node>;
}

/**
 * The state of one analysis pass over a block, created per pass and passed explicitly to the
 * `Writes`, `Aliases` and `State` functions.
 */
export interface Context extends Readonly<Input> {
  readonly scopes: Scope[];
  /** Nodes whose source an enclosing edit replaces; they must not get edits of their own. */
  readonly replaced: WeakSet<Ast.Node>;
  readonly iterationCallbacks: WeakMap<Ast.Node, IterationCallback>;
  /** Iteration callbacks on a local that isn't an alias yet: writing through the element promotes that local first. */
  readonly callbacksPromotingReceiver: WeakMap<Ast.Node, { binding: Ast.Node; elementIndex: number }>;
  /** Other functions passed to calls that touch state: their parameters may point into state. */
  readonly callbacksWithStateParams: WeakSet<Ast.Node>;
  readonly variables: InlineVariables & { nextIndex(): string };
  readonly output: Output;

  /** Replaces `node`'s source with `parts`. */
  emit(node: Ast.Node, parts: Part[]): void;
  /** Replaces the source range [start, end) with `parts`. */
  emitRange(start: number, end: number, parts: Part[]): void;
  markReplaced(nodes: readonly Ast.Node[]): void;
  sourceOf(node: Ast.Node): string;
}

function createContext(input: Input): Context {
  const output: Output = {
    edits: [],
    warnings: [],
    writtenRoots: new Set(),
    lentRoots: new Set(),
    usesContext: false,
    breaksOut: false,
    copyVariables: new Map(),
  };
  const replaced = new WeakSet<Ast.Node>();
  let counter = 0;
  return {
    ...input,
    scopes: [],
    replaced,
    iterationCallbacks: new WeakMap(),
    callbacksPromotingReceiver: new WeakMap(),
    callbacksWithStateParams: new WeakSet(),
    variables: {
      copyOf(path) {
        const existing = output.copyVariables.get(path);
        if (existing) {
          return existing;
        }
        const variable = `${CONTEXT}_${output.copyVariables.size}`;
        output.copyVariables.set(path, variable);
        return variable;
      },
      nextKey: () => `${CONTEXT}_k${++counter}`,
      nextIndex: () => `${CONTEXT}_i${++counter}`,
    },
    output,
    emit: (node, parts) => output.edits.push({ start: node.start, end: node.end, parts }),
    emitRange: (start, end, parts) => output.edits.push({ start, end, parts }),
    markReplaced: (nodes) => {
      for (const node of nodes) {
        replaced.add(node);
      }
    },
    sourceOf: (node) => input.code.slice(node.start, node.end),
  };
}

function compileCall(context: Context, call: Ast.Node, parent: Ast.Node, depth: number): void {
  const method = Ast.methodName(call);
  const mayMutateReceiver = method === null || (method !== undefined && Calls.isMutating(method));
  if (mayMutateReceiver) {
    Writes.mutatingCall(context, call, method, depth, parent);
  } else if (!Aliases.registerCallback(context, call, method, depth)) {
    Writes.opaqueCall(context, call, depth);
  }
  Aliases.markCallbackParams(context, call);
}

function compileNode(context: Context, node: Ast.Node, parent: Ast.Node, depth: number): void {
  switch (node.type) {
    case "Identifier":
      Aliases.read(context, node);
      return;
    case "Property":
      Aliases.shorthandRead(context, node);
      return;
    case "BreakStatement":
      if (node.label?.name === "mut") {
        context.output.breaksOut = true;
      }
      return;
    case "AssignmentExpression":
      Writes.assignment(context, node, parent, depth);
      return;
    case "UpdateExpression":
      Writes.update(context, node, parent, depth);
      return;
    case "UnaryExpression":
      Writes.remove(context, node, parent, depth);
      return;
    case "CallExpression":
      compileCall(context, node, parent, depth);
      return;
    case "NewExpression":
      Writes.opaqueCall(context, node, depth);
      return;
    case "VariableDeclarator":
      Aliases.declarator(context, node, depth);
      return;
    case "ForOfStatement":
      Aliases.forOf(context, node, depth);
      return;
  }
}

// `depth` counts the functions between the block and `node`, other than inline iteration
// callbacks (which run synchronously): writes inside them would happen after the block ends.
function visit(context: Context, node: Ast.Node, parent: Ast.Node, depth: number): void {
  if (Ast.isTypeOnly(node)) {
    return;
  }
  const bindings = Ast.scopeBindings(node);
  if (bindings) {
    context.scopes.push({ bindings, aliases: new Map(), maybeState: new Map() });
    if (Ast.isFunction(node)) {
      Aliases.bindParams(context, node);
    }
  }
  const innerDepth = Ast.isFunction(node) && !context.iterationCallbacks.has(node) ? depth + 1 : depth;
  if (!context.replaced.has(node)) {
    compileNode(context, node, parent, innerDepth);
  }
  for (const child of Ast.references(node)) {
    visit(context, child, node, innerDepth);
  }
  if (bindings) {
    context.scopes.pop();
  }
}

/** Analyses the body of the `mut:` statement `label`. Throws `PromoteToAlias` when a local must become an alias. */
export function analyse(label: Ast.Node, input: Input): Output {
  const context = createContext(input);
  visit(context, label.body, label, 0);
  return context.output;
}

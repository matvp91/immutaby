import type { ResolvedOptions } from "../options.ts";
import * as Aliases from "./aliases.ts";
import * as Ast from "./ast.ts";
import * as Codegen from "./codegen.ts";
import type { Warning } from "./errors.ts";
import { MutError, PromoteToAlias } from "./errors.ts";
import type { Scope, Scopes, StatePath } from "./resolve.ts";
import * as Writes from "./writes.ts";

/**
 * An inline callback of an iteration method on state: it runs synchronously,
 * and its element may be an alias.
 */
export interface IterationCallback {
  receiver: StatePath;
  elementIndex: number;
  elementAlias?: Codegen.Alias;
}

/**
 * An iteration callback on a local that isn't an alias yet: writing through
 * the element promotes that local first.
 */
export interface PromotingCallback {
  binding: Ast.Node;
  elementIndex: number;
}

export interface CompiledBlock {
  edits: Codegen.Edit[];
  warnings: Warning[];

  /**
   * Roots the block writes to (frozen at the end in dev builds).
   */
  writtenRoots: Set<string>;

  /**
   * Roots that lent state to opaque calls (sharing is restored at the end).
   */
  lentRoots: Set<string>;

  /**
   * Whether any helper uses the block's runtime context.
   */
  usesContext: boolean;

  /**
   * Whether the block contains `break mut`, so the label must stay.
   */
  breaksOut: boolean;

  /**
   * Copy variables of inline writes, declared when the block opens.
   */
  copyVariables: string[];
}

/**
 * What the handlers in aliases.ts and writes.ts see of one analysis pass:
 * lookups, and methods recording what they found. All of the pass's state is
 * owned here; handlers change it only through these methods.
 */
export interface Context extends Scopes {
  readonly code: string;
  readonly options: ResolvedOptions;

  /**
   * Whether statement-level writes to direct paths are compiled inline.
   */
  readonly inline: boolean;

  /**
   * Bindings that earlier passes found written through: they are compiled as
   * aliases.
   */
  readonly promoted: Pick<WeakSet<Ast.Node>, "has">;
  readonly names: Codegen.Names;
  readonly iterationCallbacks: Lookup<IterationCallback>;
  readonly promotingCallbacks: Lookup<PromotingCallback>;

  /**
   * Other functions passed to calls that touch state: their parameters may
   * point into state.
   */
  readonly callbacksWithStateParams: Pick<WeakSet<Ast.Node>, "has">;
  sourceOf(node: Ast.Node): string;

  /**
   * Replaces `node`'s source with `parts`.
   */
  emit(node: Ast.Node, parts: Codegen.Part[]): void;

  /**
   * Replaces the source range [start, end) with `parts`.
   */
  emitRange(start: number, end: number, parts: Codegen.Part[]): void;

  /**
   * Nodes whose source an enclosing edit replaces; they get no edits of their
   * own.
   */
  markReplaced(nodes: readonly Ast.Node[]): void;

  /**
   * Records that the local `name` may point into state; `promotable` is its
   * binding node if it can become an alias.
   */
  markMaybeState(name: string, promotable: Ast.Node | null): void;

  /**
   * Compiles the local bound by `binding` as `alias`; its declaration and the
   * `replaced` nodes get no edits of their own.
   */
  declareAlias(
    binding: Ast.Node,
    alias: Codegen.Alias,
    replaced?: readonly Ast.Node[],
  ): void;
  registerIterationCallback(fn: Ast.Node, callback: IterationCallback): void;
  registerPromotingCallback(fn: Ast.Node, callback: PromotingCallback): void;
  markStateParams(fn: Ast.Node): void;

  /**
   * Records a write to `root`, through a helper (which uses the block's
   * runtime context) or inline.
   */
  recordWrite(root: string, viaHelper: boolean): void;

  /**
   * Records that `root` lent state to an opaque call.
   */
  recordLend(root: string): void;
  warn(message: string, pos: number): void;
}

type Lookup<T> = Pick<WeakMap<Ast.Node, T>, "get" | "has">;

interface Input {
  code: string;
  options: ResolvedOptions;
  inline: boolean;
  enclosing: readonly Ast.Node[];
  promoted: WeakSet<Ast.Node>;
}

interface LocalScope extends Scope {
  readonly aliases: Map<string, Codegen.Alias>;
  readonly maybeState: Map<string, Ast.Node | null>;
}

// One analysis pass: the handlers' view, and the state behind it that only
// this module touches.
interface Pass {
  context: Context;
  scopes: LocalScope[];
  replaced: WeakSet<Ast.Node>;
  output: CompiledBlock;
}

function createPass({ code, options, inline, enclosing, promoted }: Input) {
  const output: CompiledBlock = {
    edits: [],
    warnings: [],
    writtenRoots: new Set(),
    lentRoots: new Set(),
    usesContext: false,
    breaksOut: false,
    copyVariables: [],
  };
  const scopes: LocalScope[] = [];
  const replaced = new WeakSet<Ast.Node>();
  const iterationCallbacks = new WeakMap<Ast.Node, IterationCallback>();
  const promotingCallbacks = new WeakMap<Ast.Node, PromotingCallback>();
  const callbacksWithStateParams = new WeakSet<Ast.Node>();
  const scopeDeclaring = (name: string) =>
    scopes.findLast((scope) => scope.bindings.has(name));
  const markReplaced = (nodes: readonly Ast.Node[]) => {
    for (const node of nodes) {
      replaced.add(node);
    }
  };

  const context: Context = {
    code,
    options,
    inline,
    enclosing,
    promoted,
    scopes,
    names: Codegen.createNames(),
    iterationCallbacks,
    promotingCallbacks,
    callbacksWithStateParams,
    sourceOf: (node) => code.slice(node.start, node.end),
    emit: (node, parts) =>
      output.edits.push({ start: node.start, end: node.end, parts }),
    emitRange: (start, end, parts) => output.edits.push({ start, end, parts }),
    markReplaced,
    markMaybeState(name, promotable) {
      scopeDeclaring(name)?.maybeState.set(name, promotable);
    },
    declareAlias(binding, alias, replacedNodes = []) {
      scopeDeclaring(binding.name)?.aliases.set(binding.name, alias);
      markReplaced([binding, ...replacedNodes]);
    },
    registerIterationCallback: (fn, callback) =>
      iterationCallbacks.set(fn, callback),
    registerPromotingCallback: (fn, callback) =>
      promotingCallbacks.set(fn, callback),
    markStateParams: (fn) => callbacksWithStateParams.add(fn),
    recordWrite(root, viaHelper) {
      output.writtenRoots.add(root);
      output.usesContext ||= viaHelper;
    },
    recordLend(root) {
      output.lentRoots.add(root);
      output.writtenRoots.add(root);
      output.usesContext = true;
    },
    warn: (message, pos) =>
      output.warnings.push({ message: `mut: ${message}`, pos }),
  };
  return { context, scopes, replaced, output };
}

function compileCall(
  context: Context,
  call: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  const method = Ast.methodName(call);
  const mayMutateReceiver =
    method === null || (method !== undefined && Ast.isMutatingMethod(method));
  if (mayMutateReceiver) {
    Writes.mutatingCall(context, call, method, depth, parent);
  } else if (!Aliases.registerCallback(context, call, method, depth)) {
    Writes.opaqueCall(context, call, depth);
  }
  Aliases.markCallbackParams(context, call);
}

function compileNode(
  { context, output }: Pass,
  node: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  switch (node.type) {
    case "Identifier":
      Aliases.read(context, node);
      return;
    case "Property":
      Aliases.shorthand(context, node);
      return;
    case "BreakStatement":
      if (node.label?.name === "mut") {
        output.breaksOut = true;
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

// `depth` counts the functions between the block and `node`, other than inline
// iteration callbacks (which run synchronously): writes inside them would
// happen after the block ends.
function visit(
  pass: Pass,
  node: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  if (Ast.isTypeOnly(node)) {
    return;
  }
  const { context } = pass;
  const bindings = Ast.scopeBindings(node);
  if (bindings) {
    pass.scopes.push({
      bindings,
      aliases: new Map(),
      maybeState: new Map(),
    });
    if (Ast.isFunction(node)) {
      Aliases.bindParams(context, node);
    }
  }
  const innerDepth =
    Ast.isFunction(node) && !context.iterationCallbacks.has(node)
      ? depth + 1
      : depth;
  if (!pass.replaced.has(node)) {
    compileNode(pass, node, parent, innerDepth);
  }
  for (const child of Ast.references(node)) {
    visit(pass, child, node, innerDepth);
  }
  if (bindings) {
    pass.scopes.pop();
  }
}

// One pass over the body of the `mut:` statement `label`. Throws
// `PromoteToAlias` when a local must become an alias.
function analyse(label: Ast.Node, input: Input): CompiledBlock {
  const pass = createPass(input);
  visit(pass, label.body, label, 0);
  pass.output.copyVariables = pass.context.names.copies();
  return pass.output;
}

/**
 * Compiles the `mut:` statement `label`, or returns null if it needs no edits.
 * Each pass may find a local that is written through; it is then promoted to
 * an alias and the block is analysed again, until a pass completes.
 */
export function compileBlock(
  code: string,
  label: Ast.Node,
  enclosing: readonly Ast.Node[],
  options: ResolvedOptions,
): CompiledBlock | null {
  const promoted = new WeakSet<Ast.Node>();
  for (;;) {
    try {
      const input = { code, options, enclosing, promoted };
      let output = analyse(label, { ...input, inline: options.inline });

      // Restoring sharing only knows the helpers' copies, so blocks that lend
      // state use helpers throughout.
      if (output.lentRoots.size && options.inline) {
        output = analyse(label, { ...input, inline: false });
      }
      return output.edits.length ? output : null;
    } catch (error) {
      if (!(error instanceof PromoteToAlias)) {
        throw error;
      }
      const { binding } = error;
      if (promoted.has(binding)) {
        throw new MutError(
          `can't track writes through \`${binding.name}\``,
          binding.start,
        );
      }
      promoted.add(binding);
    }
  }
}

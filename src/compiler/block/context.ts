/**
 * The state of analysing one `mut:` block. It is created per pass and passed
 * explicitly to the analysis functions, which read the scopes and add to the
 * output.
 */
import type { ResolvedOptions } from "../../options.ts";
import type { AstNode } from "../ast.ts";
import { CONTEXT, type Alias, type InlineVariables, type Part } from "../codegen.ts";
import type { Edit } from "../edits.ts";
import type { Warning } from "../errors.ts";
import type { BindingKind } from "../scope.ts";
import type { StatePath } from "./state-path.ts";

/** A scope inside the block. */
export interface Scope {
  bindings: ReadonlyMap<string, BindingKind>;
  /** Locals compiled to state locations. */
  aliases: Map<string, Alias>;
  /** Locals that may point into state, with their binding node when they can become an alias (else null). */
  maybeState: Map<string, AstNode | null>;
}

/** An inline callback of an iteration method on state: it runs synchronously, and its element may be an alias. */
export interface IterationCallback {
  receiver: StatePath;
  elementIndex: number;
  elementAlias?: Alias;
}

export interface BlockOutput {
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

export interface BlockContext {
  readonly code: string;
  readonly options: ResolvedOptions;
  /** Whether statement-level writes to direct paths are compiled inline. */
  readonly inline: boolean;
  /** The ancestors of the `mut:` label, where roots are declared. */
  readonly enclosing: readonly AstNode[];
  /** Bindings that earlier passes found written through: they are compiled as aliases. */
  readonly promoted: WeakSet<AstNode>;
  readonly scopes: Scope[];
  /** Nodes whose source an enclosing edit replaces; they must not get edits of their own. */
  readonly replaced: WeakSet<AstNode>;
  readonly iterationCallbacks: WeakMap<AstNode, IterationCallback>;
  /** Iteration callbacks on a local that isn't an alias yet: writing through the element promotes that local first. */
  readonly callbacksPromotingReceiver: WeakMap<AstNode, { binding: AstNode; elementIndex: number }>;
  /** Other functions passed to calls that touch state: their parameters may point into state. */
  readonly callbacksWithStateParams: WeakSet<AstNode>;
  readonly variables: InlineVariables & { nextIndex(): string };
  readonly output: BlockOutput;
}

export interface BlockInput {
  code: string;
  options: ResolvedOptions;
  inline: boolean;
  enclosing: readonly AstNode[];
  promoted: WeakSet<AstNode>;
}

export function createBlockContext(input: BlockInput): BlockContext {
  const copyVariables = new Map<string, string>();
  let counter = 0;
  return {
    ...input,
    scopes: [],
    replaced: new WeakSet(),
    iterationCallbacks: new WeakMap(),
    callbacksPromotingReceiver: new WeakMap(),
    callbacksWithStateParams: new WeakSet(),
    variables: {
      copyOf(path) {
        if (!copyVariables.has(path)) copyVariables.set(path, `${CONTEXT}_${copyVariables.size}`);
        return copyVariables.get(path)!;
      },
      nextKey: () => `${CONTEXT}_k${++counter}`,
      nextIndex: () => `${CONTEXT}_i${++counter}`,
    },
    output: {
      edits: [],
      warnings: [],
      writtenRoots: new Set(),
      lentRoots: new Set(),
      usesContext: false,
      breaksOut: false,
      copyVariables,
    },
  };
}

export const sourceOf = (context: BlockContext, node: AstNode): string => context.code.slice(node.start, node.end);

/** Replaces `node`'s source with `parts`. */
export function emit(context: BlockContext, node: AstNode, parts: Part[]): void {
  context.output.edits.push({ start: node.start, end: node.end, parts });
}

/** Replaces the source range [start, end) with `parts`. */
export function emitRange(context: BlockContext, start: number, end: number, parts: Part[]): void {
  context.output.edits.push({ start, end, parts });
}

export function markReplaced(context: BlockContext, nodes: readonly AstNode[]): void {
  for (const node of nodes) context.replaced.add(node);
}

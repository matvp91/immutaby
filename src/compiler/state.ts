import * as Ast from "./ast.ts";
import type * as Block from "./block.ts";
import * as Calls from "./calls.ts";
import type { Alias, PathKey } from "./codegen.ts";
import { isPlainKey, joinArguments, RUNTIME } from "./codegen.ts";
import { MutError, PromoteToAlias } from "./errors.ts";

export type Binding =
  /**
   * Declared outside the block: writes through it are state updates.
   */
  | { kind: "root"; declaredAs: Ast.BindingKind }

  /**
   * A local compiled to a state location.
   */
  | { kind: "alias"; alias: Alias }

  /**
   * A local that may point into state; `promotable` is its binding node if it
   * can become an alias.
   */
  | { kind: "maybeState"; promotable: Ast.Node | null }

  /**
   * A local that doesn't hold state.
   */
  | { kind: "local" }

  /**
   * Not declared in this module.
   */
  | { kind: "global" };

/**
 * What `name` refers to at the current point of the block.
 */
export function resolve(context: Block.Context, name: string): Binding {
  for (let i = context.scopes.length - 1; i >= 0; i--) {
    const scope = context.scopes[i];
    if (!scope.bindings.has(name)) {
      continue;
    }
    const alias = scope.aliases.get(name);
    if (alias) {
      return { kind: "alias", alias };
    }
    if (scope.maybeState.has(name)) {
      return { kind: "maybeState", promotable: scope.maybeState.get(name) };
    }
    return { kind: "local" };
  }
  for (let i = context.enclosing.length - 1; i >= 0; i--) {
    const declaredAs = Ast.scopeBindings(context.enclosing[i])?.get(name);
    if (declaredAs) {
      return { kind: "root", declaredAs };
    }
  }
  return { kind: "global" };
}

const scopeDeclaring = (
  context: Block.Context,
  name: string,
): Block.Scope | undefined =>
  context.scopes.findLast((scope) => scope.bindings.has(name));

/**
 * Records that the local `name` may point into state; `promotable` is its
 * binding node if it can become an alias.
 */
export function markMaybeState(
  context: Block.Context,
  name: string,
  promotable: Ast.Node | null,
): void {
  scopeDeclaring(context, name)?.maybeState.set(name, promotable);
}

/**
 * Compiles the local bound by `binding` as `alias`; its declaration and the
 * `replaced` nodes get no edits of their own.
 */
export function declareAlias(
  context: Block.Context,
  binding: Ast.Node,
  alias: Alias,
  replaced: readonly Ast.Node[] = [],
): void {
  scopeDeclaring(context, binding.name)?.aliases.set(binding.name, alias);
  context.markReplaced([binding, ...replaced]);
}

/**
 * For a member path on a local that may become an alias (`u.address`), that
 * local's binding: writing through something derived from it must promote it
 * first.
 */
export function promotableBase(
  context: Block.Context,
  expression: Ast.Node,
): Ast.Node | null {
  const base = Ast.chainBase(expression);
  const binding = base && resolve(context, base.name);
  return binding?.kind === "maybeState" ? binding.promotable : null;
}

/**
 * Whether `node` (outside nested functions) reads anything that may hold state.
 */
export function touches(context: Block.Context, node: Ast.Node): boolean {
  if (!node || Ast.isFunction(node) || Ast.isTypeOnly(node)) {
    return false;
  }
  if (node.type === "Identifier") {
    const { kind } = resolve(context, node.name);
    return kind !== "local" && kind !== "global";
  }

  // Calling a plain function doesn't read state by itself; its arguments might.
  if (
    (node.type === "CallExpression" || node.type === "NewExpression") &&
    node.callee.type === "Identifier"
  ) {
    return node.arguments.some((argument: Ast.Node) =>
      touches(context, argument),
    );
  }
  return Ast.references(node).some((child) => touches(context, child));
}

/**
 * A state location: a root variable plus the keys leading to it.
 */
export interface Path {
  root: string;
  keys: PathKey[];

  /**
   * Source nodes the path's generated code replaces (they must not get edits of
   * their own).
   */
  replaces: Ast.Node[];

  /**
   * Whether a key is resolved at runtime (`find`).
   */
  hasFindKey: boolean;

  /**
   * Whether it is a root plus member keys, which inline writes can handle.
   */
  isDirect: boolean;
}

export interface PathQuery {
  /**
   * Nesting depth of functions (other than inline iteration callbacks) inside
   * the block.
   */
  depth: number;

  /**
   * Whether the location is about to be written.
   */
  forWrite: boolean;

  /**
   * What is being done, for error messages ("writes", "deletes", …).
   */
  verb?: string;
}

/**
 * The alias for a local bound to `path`. Plain keys are kept; the others are
 * read from `holder`, which must then hold the resolved path at runtime.
 */
export function aliasFor(
  path: Path,
  holder: string,
): { alias: Alias; needsHolder: boolean } {
  const keys = path.keys.map((key, i) =>
    isPlainKey(key) ? key[0] : `${holder}[${i}]`,
  );
  return {
    alias: { root: path.root, keys },
    needsHolder: !path.keys.every(isPlainKey),
  };
}

/**
 * Throws unless `root` can be rebound to an updated value from here.
 */
export function assertWritableRoot(
  context: Block.Context,
  root: string,
  at: Ast.Node,
  depth: number,
  verb: string,
): void {
  const binding = resolve(context, root);
  if (binding.kind !== "root") {
    return;
  }
  if (!Ast.isReassignable(binding.declaredAs)) {
    throw new MutError(
      `\`${root}\` can't be rebound (declared as ${binding.declaredAs}); ` +
        "use `let` so it can hold the new value",
      at.start,
    );
  }
  if (depth > 0) {
    throw new MutError(
      `${verb} to \`${root}\` inside a nested function aren't supported yet`,
      at.start,
    );
  }
}

/**
 * The state location `expression` denotes, or null if it isn't state. For a
 * write, anything that may be state but can't be tracked is an error, and a
 * local that may point into state is promoted to an alias.
 */
export function pathOf(
  context: Block.Context,
  expression: Ast.Node,
  query: PathQuery,
): Path | null {
  const { depth, forWrite, verb = "writes" } = query;
  const keys: PathKey[] = [];
  let node = Ast.unwrap(expression);

  for (;;) {
    if (
      node.type === "MemberExpression" &&
      node.property.type !== "PrivateIdentifier"
    ) {
      keys.unshift([
        node.computed ? node.property : JSON.stringify(node.property.name),
      ]);
      node = Ast.unwrap(node.object);
      continue;
    }
    const findIndexMethod =
      node.type === "CallExpression"
        ? Calls.findIndexFor(Ast.methodName(node) ?? "")
        : undefined;
    if (
      findIndexMethod &&
      !node.optional &&
      !Ast.unwrap(node.callee).optional &&
      node.arguments.length
    ) {
      const list = pathOf(context, Ast.unwrap(node.callee).object, query);
      if (!list) {
        return null;
      }
      const findKey = [
        `${RUNTIME}.Path.findIndexKey(${JSON.stringify(findIndexMethod)}, `,
        ...joinArguments(node.arguments),
        ")",
      ];
      return {
        ...list,
        keys: [...list.keys, findKey, ...keys],
        replaces: [...list.replaces, node],
        hasFindKey: true,
        isDirect: false,
      };
    }
    break;
  }

  if (node.type === "Identifier") {
    const binding = resolve(context, node.name);
    if (binding.kind === "local") {
      return null;
    }
    if (binding.kind === "alias" || binding.kind === "root") {
      const root = binding.kind === "alias" ? binding.alias.root : node.name;
      if (forWrite) {
        assertWritableRoot(context, root, node, depth, verb);
      }
      const fullKeys =
        binding.kind === "alias"
          ? [...binding.alias.keys.map((key) => [key]), ...keys]
          : keys;
      return {
        root,
        keys: fullKeys,
        replaces: [node],
        hasFindKey: false,
        isDirect: true,
      };
    }
    if (!forWrite) {
      return null;
    }
    if (binding.kind === "maybeState") {
      if (binding.promotable) {
        throw new PromoteToAlias(binding.promotable);
      }
      throw new MutError(
        `\`${node.name}\` may point into state but isn't a plain path ` +
          `(like \`s.a.b\`), so ${verb} through it can't be tracked`,
        node.start,
      );
    }
    throw new MutError(
      `\`${node.name}\` isn't declared in this module`,
      node.start,
    );
  }

  if (!forWrite) {
    return null;
  }
  if (node.type === "ThisExpression") {
    throw new MutError(
      `${verb} through \`this\` aren't supported; copy it into a \`let\` first`,
      node.start,
    );
  }
  if (touches(context, node)) {
    throw new MutError(
      `can't track ${verb} through this expression yet`,
      node.start,
    );
  }
  return null;
}

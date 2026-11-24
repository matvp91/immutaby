import * as Ast from "./ast.ts";
import * as Codegen from "./codegen.ts";
import { MutError, PromoteToAlias } from "./errors.ts";

// Read-only queries: what names and expressions refer to. Nothing here records
// anything; the only effect is throwing.

/**
 * A scope inside the block.
 */
export interface Scope {
  readonly bindings: ReadonlyMap<string, Ast.BindingKind>;

  /**
   * Locals compiled to state locations.
   */
  readonly aliases: ReadonlyMap<string, Codegen.Alias>;

  /**
   * Locals that may point into state, with their binding node when they can
   * become an alias (else null).
   */
  readonly maybeState: ReadonlyMap<string, Ast.Node | null>;
}

/**
 * What names are resolved against.
 */
export interface Scopes {
  /**
   * The scopes inside the block entered so far, innermost last.
   */
  readonly scopes: readonly Scope[];

  /**
   * The ancestors of the `mut:` label, where roots are declared.
   */
  readonly enclosing: readonly Ast.Node[];
}

export type Binding =
  /**
   * Declared outside the block: writes through it are state updates.
   */
  | { kind: "root"; declaredAs: Ast.BindingKind }

  /**
   * A local compiled to a state location.
   */
  | { kind: "alias"; alias: Codegen.Alias }

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
export function bindingOf(context: Scopes, name: string): Binding {
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

/**
 * For a member path on a local that may become an alias (`u.address`), that
 * local's binding: writing through something derived from it must promote it
 * first.
 */
export function promotableBaseOf(
  context: Scopes,
  expression: Ast.Node,
): Ast.Node | null {
  const base = Ast.chainBase(expression);
  const binding = base && bindingOf(context, base.name);
  return binding?.kind === "maybeState" ? binding.promotable : null;
}

/**
 * Whether `node` (outside nested functions) reads anything that may hold state.
 */
export function touchesState(context: Scopes, node: Ast.Node): boolean {
  if (!node || Ast.isFunction(node) || Ast.isTypeOnly(node)) {
    return false;
  }
  if (node.type === "Identifier") {
    const { kind } = bindingOf(context, node.name);
    return kind !== "local" && kind !== "global";
  }

  // Calling a plain function doesn't read state by itself; its arguments might.
  if (
    (node.type === "CallExpression" || node.type === "NewExpression") &&
    node.callee.type === "Identifier"
  ) {
    return node.arguments.some((argument: Ast.Node) =>
      touchesState(context, argument),
    );
  }
  return Ast.references(node).some((child) => touchesState(context, child));
}

/**
 * A state location: a root variable plus the keys leading to it.
 */
export interface StatePath {
  root: string;
  keys: Codegen.PathKey[];

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
 * Throws unless `root` can be rebound to an updated value from here.
 */
export function assertWritableRoot(
  context: Scopes,
  root: string,
  at: Ast.Node,
  depth: number,
  verb: string,
): void {
  const binding = bindingOf(context, root);
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
 * local that may point into state must be promoted to an alias first (this
 * throws `PromoteToAlias`).
 */
export function pathOf(
  context: Scopes,
  expression: Ast.Node,
  query: PathQuery,
): StatePath | null {
  const { depth, forWrite, verb = "writes" } = query;
  const keys: Codegen.PathKey[] = [];
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
        ? Ast.findIndexMethodFor(Ast.methodName(node) ?? "")
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
      return {
        ...list,
        keys: [
          ...list.keys,
          Codegen.findKey(findIndexMethod, node.arguments),
          ...keys,
        ],
        replaces: [...list.replaces, node],
        hasFindKey: true,
        isDirect: false,
      };
    }
    break;
  }

  if (node.type === "Identifier") {
    const binding = bindingOf(context, node.name);
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
  if (touchesState(context, node)) {
    throw new MutError(
      `can't track ${verb} through this expression yet`,
      node.start,
    );
  }
  return null;
}

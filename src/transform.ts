import MagicString, { type SourceMap } from "magic-string";
import { parseAst } from "rolldown/parseAst";

export interface Options {
  /** Module the generated code imports helpers from. */
  runtime?: string;
}

export class MutError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`mut: ${message}`);
    this.pos = pos;
  }
}

type Node = any;
/** Generated text, or a source node kept in place (so its own edits and sourcemap survive). */
type Part = string | Node;
type Kind = "var" | "let" | "const" | "param" | "catch" | "function" | "class" | "import";

/** A state location: a root variable plus the keys leading to it. */
interface StatePath {
  root: string;
  keys: Part[][];
  /** Source nodes the path's generated code replaces (they must not be edited separately). */
  consumes: Node[];
  /** Whether any key is resolved at runtime (`find`). */
  finds: boolean;
}

interface Scope {
  decls: Map<string, Kind>;
  /** Locals compiled to runtime paths into state, by root name. */
  aliases: Map<string, string>;
  /** Locals that may point into state, with their binding node if they can become an alias. */
  tainted: Map<string, Node | null>;
}

type Ref =
  | { kind: "root"; decl: Kind }
  | { kind: "alias"; root: string }
  | { kind: "tainted"; id: Node | null }
  | { kind: "local" }
  | { kind: "global" };

/** Thrown when a local must become an alias; the block is then analysed again. */
class Promote {
  readonly id: Node;
  constructor(id: Node) {
    this.id = id;
  }
}

const NS = "__imm";
const C = "__imm_c";

const MUTATING_METHODS = new Set([
  ...["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"],
  ...["set", "add", "delete", "clear"],
]);
const ITERATION_METHODS = new Set(["forEach", "map", "filter", "find", "findLast", "findIndex", "findLastIndex", "some", "every", "flatMap", "reduce", "reduceRight"]);
const FINDERS = new Map([
  ["find", "findIndex"],
  ["findLast", "findLastIndex"],
]);
const REASSIGNABLE = new Set<Kind>(["let", "var", "param", "catch"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const TS_EXPRESSIONS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"]);
const NON_CODE_KEYS = new Set(["type", "start", "end", "range", "loc", "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "implements", "decorators"]);

function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const key in n) {
    if (NON_CODE_KEYS.has(key)) continue;
    const value = n[key];
    if (Array.isArray(value)) for (const x of value) x && typeof x.type === "string" && out.push(x);
    else if (value && typeof value.type === "string") out.push(value);
  }
  return out;
}

/** Children that are code, skipping identifiers that aren't references (property names, labels). */
function referenceChildren(n: Node): Node[] {
  switch (n.type) {
    case "MemberExpression":
      return n.computed ? [n.object, n.property] : [n.object];
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return n.computed ? children(n) : children(n).filter((c) => c !== n.key);
    case "LabeledStatement":
      return [n.body];
    case "BreakStatement":
    case "ContinueStatement":
      return [];
    default:
      return children(n);
  }
}

const isTypeOnly = (n: Node) => n.type.startsWith("TS") && !TS_EXPRESSIONS.has(n.type) && n.type !== "TSInstantiationExpression";
const unwrap = (n: Node): Node => (n.type === "ParenthesizedExpression" || TS_EXPRESSIONS.has(n.type) ? unwrap(n.expression) : n);

/** The statically known method name of a call (`null` when computed), or undefined if it isn't a method call. */
function methodName(call: Node): string | null | undefined {
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed) return callee.property.name;
  return callee.property.type === "Literal" && typeof callee.property.value === "string" ? callee.property.value : null;
}

// ---------------------------------------------------------------- scopes

function bindingNames(pattern: Node, out: string[] = []): string[] {
  switch (pattern?.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) bindingNames(p.type === "RestElement" ? p.argument : p.value, out);
      break;
    case "ArrayPattern":
      for (const p of pattern.elements) bindingNames(p, out);
      break;
    case "AssignmentPattern":
      bindingNames(pattern.left, out);
      break;
    case "RestElement":
      bindingNames(pattern.argument, out);
      break;
    case "TSParameterProperty":
      bindingNames(pattern.parameter, out);
      break;
  }
  return out;
}

function declare(statement: Node, into: Map<string, Kind>) {
  switch (statement?.type) {
    case "VariableDeclaration":
      if (statement.kind === "var") break;
      for (const d of statement.declarations) for (const name of bindingNames(d.id)) into.set(name, statement.kind === "let" ? "let" : "const");
      break;
    case "FunctionDeclaration":
      if (statement.id) into.set(statement.id.name, "function");
      break;
    case "ClassDeclaration":
      if (statement.id) into.set(statement.id.name, "class");
      break;
    case "TSEnumDeclaration":
      into.set(statement.id.name, "const");
      break;
    case "ImportDeclaration":
      for (const s of statement.specifiers) into.set(s.local.name, "import");
      break;
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      declare(statement.declaration, into);
      break;
  }
}

function hoistVars(n: Node, into: Map<string, Kind>) {
  if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations) for (const name of bindingNames(d.id)) into.set(name, "var");
  for (const c of children(n)) if (!FUNCTIONS.has(c.type)) hoistVars(c, into);
}

const scopeCache = new WeakMap<Node, Map<string, Kind> | null>();

/** The bindings a node introduces, or null if it isn't a scope. */
function scopeOf(n: Node): Map<string, Kind> | null {
  if (scopeCache.has(n)) return scopeCache.get(n)!;
  let decls: Map<string, Kind> | null = new Map();
  switch (n.type) {
    case "Program":
      for (const s of n.body) declare(s, decls);
      hoistVars(n, decls);
      break;
    case "BlockStatement":
    case "StaticBlock":
      for (const s of n.body) declare(s, decls);
      break;
    case "SwitchStatement":
      for (const c of n.cases) for (const s of c.consequent) declare(s, decls);
      break;
    case "ForStatement":
      declare(n.init, decls);
      break;
    case "ForInStatement":
    case "ForOfStatement":
      declare(n.left, decls);
      break;
    case "CatchClause":
      for (const name of bindingNames(n.param)) decls.set(name, "catch");
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (n.type === "FunctionExpression" && n.id) decls.set(n.id.name, "const");
      for (const p of n.params) for (const name of bindingNames(p)) decls.set(name, "param");
      if (n.body.type === "BlockStatement") hoistVars(n.body, decls);
      break;
    default:
      decls = null;
  }
  scopeCache.set(n, decls);
  return decls;
}

// ---------------------------------------------------------------- transform

interface Edit {
  start: number;
  end: number;
  parts: Part[];
}

export function transform(code: string, id: string, options: Options = {}): { code: string; map: SourceMap } | null {
  if (!/\bmut\s*:/.test(code)) return null;
  const ast = parseAst(code, { lang: langOf(id), preserveParens: true }, id);
  const ms = new MagicString(code);
  let changed = false;

  const replace = (start: number, end: number, text: string) => {
    if (start < end) ms.overwrite(start, end, text, { contentOnly: true });
    else if (text) ms.appendLeft(start, text);
  };
  /** Rewrites [start, end) as `parts`; node parts keep their source in place. */
  const apply = ({ start, end, parts }: Edit) => {
    let pos = start;
    let text = "";
    for (const part of parts) {
      if (typeof part === "string") text += part;
      else {
        replace(pos, part.start, text);
        text = "";
        pos = part.end;
      }
    }
    replace(pos, end, text);
  };

  /** Declares the block's context, and drops the label unless `break mut` needs it. */
  const finishBlock = (label: Node, breaks: boolean) => {
    const body = label.body;
    const context = `const ${C} = /* @__PURE__ */ ${NS}.createContext();`;
    if (!breaks) ms.remove(label.start, body.start);
    if (body.type === "BlockStatement") ms.appendLeft(body.start + 1, ` ${context}`);
    else {
      ms.prependRight(body.start, `{ ${context} `);
      ms.appendLeft(body.end, " }");
    }
  };

  const compileBlock = (label: Node, outer: Node[]) => {
    const promoted = new WeakSet<Node>();
    for (;;) {
      try {
        const { edits, breaks } = analyse(label, outer, promoted);
        if (!edits.length) return;
        edits.forEach(apply);
        finishBlock(label, breaks);
        changed = true;
        return;
      } catch (error) {
        if (!(error instanceof Promote)) throw error;
        if (promoted.has(error.id)) throw new MutError(`can't track writes through \`${error.id.name}\``, error.id.start);
        promoted.add(error.id);
      }
    }
  };

  const find = (n: Node, ancestors: Node[]) => {
    if (n.type === "LabeledStatement" && n.label.name === "mut") return compileBlock(n, ancestors);
    ancestors.push(n);
    for (const c of children(n)) find(c, ancestors);
    ancestors.pop();
  };
  find(ast, []);

  if (!changed) return null;
  ms.prepend(`import * as ${NS} from ${JSON.stringify(options.runtime ?? "immutaby/runtime")};\n`);
  return { code: ms.toString(), map: ms.generateMap({ hires: true, source: id, includeContent: true }) };
}

/** Collects the edits for one `mut:` block. Throws `Promote` when a local has to become an alias. */
function analyse(label: Node, outer: Node[], promoted: WeakSet<Node>) {
  const edits: Edit[] = [];
  const stack: Scope[] = [];
  /** Nodes replaced by an enclosing edit; they must not get edits of their own. */
  const consumed = new WeakSet<Node>();
  /** Inline callbacks of iteration methods on state: they run synchronously, and their element param may alias. */
  const callbacks = new WeakMap<Node, { path: StatePath; element: number }>();
  /** Other functions passed to calls that touch state: their params may point into state. */
  const taintParams = new WeakSet<Node>();
  let breaks = false;

  const emit = (n: Node, parts: Part[]) => edits.push({ start: n.start, end: n.end, parts });

  const resolve = (name: string): Ref => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const scope = stack[i];
      if (!scope.decls.has(name)) continue;
      if (scope.aliases.has(name)) return { kind: "alias", root: scope.aliases.get(name)! };
      if (scope.tainted.has(name)) return { kind: "tainted", id: scope.tainted.get(name) };
      return { kind: "local" };
    }
    for (let i = outer.length - 1; i >= 0; i--) {
      const decl = scopeOf(outer[i])?.get(name);
      if (decl) return { kind: "root", decl };
    }
    return { kind: "global" };
  };
  const scopeDeclaring = (name: string) => stack.findLast((s) => s.decls.has(name));
  const taint = (name: string, id: Node | null) => scopeDeclaring(name)?.tainted.set(name, id);
  const makeAlias = (id: Node, path: StatePath) => {
    scopeDeclaring(id.name)?.aliases.set(id.name, path.root);
    consumed.add(id);
    for (const c of path.consumes) consumed.add(c);
  };

  /** Whether `n` (outside nested functions) reads anything that may hold state. */
  const touchesState = (n: Node): boolean => {
    if (!n || FUNCTIONS.has(n.type) || isTypeOnly(n)) return false;
    if (n.type === "Identifier") return !["local", "global"].includes(resolve(n.name).kind);
    // Calling a plain function doesn't read state by itself; its arguments might.
    if ((n.type === "CallExpression" || n.type === "NewExpression") && n.callee.type === "Identifier") return n.arguments.some(touchesState);
    return referenceChildren(n).some(touchesState);
  };

  const checkWritable = (root: string, at: Node, depth: number, verb: string) => {
    const ref = resolve(root);
    if (ref.kind !== "root") return;
    if (!REASSIGNABLE.has(ref.decl)) throw new MutError(`\`${root}\` can't be rebound (declared as ${ref.decl}); use \`let\` so it can hold the new value`, at.start);
    if (depth > 0) throw new MutError(`${verb} to \`${root}\` inside a nested function aren't supported yet`, at.start);
  };

  /**
   * The state location `expr` denotes, or null if it isn't state. When `strict`
   * (it is about to be written), anything that may be state but can't be
   * tracked is an error, and tainted locals are promoted to aliases.
   */
  const statePath = (expr: Node, depth: number, verb: string, strict: boolean): StatePath | null => {
    const keys: Part[][] = [];
    let n = unwrap(expr);
    for (;;) {
      if (n.type === "MemberExpression" && n.property.type !== "PrivateIdentifier") {
        keys.unshift([n.computed ? n.property : JSON.stringify(n.property.name)]);
        n = unwrap(n.object);
        continue;
      }
      const name = n.type === "CallExpression" ? methodName(n) : undefined;
      if (name && FINDERS.has(name) && !n.optional && !unwrap(n.callee).optional && n.arguments.length) {
        const inner = statePath(unwrap(n.callee).object, depth, verb, strict);
        if (!inner) return null;
        const finder = [`${NS}.finder(${JSON.stringify(FINDERS.get(name))}, `, ...commaList(n.arguments), ")"];
        return { ...inner, keys: [...inner.keys, finder, ...keys], consumes: [...inner.consumes, n], finds: true };
      }
      break;
    }

    if (n.type === "Identifier") {
      const ref = resolve(n.name);
      if (ref.kind === "local") return null;
      if (ref.kind === "alias" || ref.kind === "root") {
        const root = ref.kind === "alias" ? ref.root : n.name;
        if (strict) checkWritable(root, n, depth, verb);
        const full = ref.kind === "alias" ? [[`...${n.name}`], ...keys] : keys;
        return { root, keys: full, consumes: [n], finds: false };
      }
      if (!strict) return null;
      if (ref.kind === "tainted") {
        if (ref.id) throw new Promote(ref.id);
        throw new MutError(`\`${n.name}\` may point into state but isn't a plain path (like \`s.a.b\`), so ${verb} through it can't be tracked`, n.start);
      }
      throw new MutError(`\`${n.name}\` isn't declared in this module`, n.start);
    }
    if (!strict) return null;
    if (n.type === "ThisExpression") throw new MutError(`${verb} through \`this\` aren't supported; copy it into a \`let\` first`, n.start);
    if (touchesState(n)) throw new MutError(`can't track ${verb} through this expression yet`, n.start);
    return null;
  };

  /** Emits a helper call that rebinds the root: `root = helper(...)`, or `(root = helper(...), C.slot)` in expressions. */
  const write = (n: Node, parent: Node, path: StatePath, call: Part[], slot = "value") => {
    for (const c of path.consumes) consumed.add(c);
    const statement = parent.type === "ExpressionStatement";
    const open = statement ? "" : "(";
    const close = statement ? "" : `, ${C}.${slot})`;
    emit(n, [`${open}${path.root} = ${NS}.`, ...call, `, ${path.root})${close}`]);
  };

  const enterScope = (n: Node, decls: Map<string, Kind>) => {
    stack.push({ decls, aliases: new Map(), tainted: new Map() });
    if (taintParams.has(n)) for (const p of n.params) for (const name of bindingNames(p)) taint(name, null);
    const callback = callbacks.get(n);
    if (!callback) return;
    n.params.forEach((param: Node, i: number) => {
      if (i === callback.element && param.type === "Identifier") {
        if (promoted.has(param)) makeAlias(param, { ...callback.path, consumes: [] });
        else taint(param.name, param);
      } else if (i !== callback.element + 1) for (const name of bindingNames(param)) taint(name, null);
    });
  };

  const handle = (n: Node, parent: Node, depth: number) => {
    switch (n.type) {
      case "Identifier": {
        const ref = resolve(n.name);
        if (ref.kind === "alias") emit(n, [`${NS}.get(${ref.root}, ${n.name})`]);
        break;
      }
      case "Property": {
        const ref = n.shorthand && n.value.type === "Identifier" ? resolve(n.value.name) : null;
        if (ref?.kind === "alias") {
          consumed.add(n.value);
          emit(n, [`${n.value.name}: ${NS}.get(${ref.root}, ${n.value.name})`]);
        }
        break;
      }
      case "BreakStatement":
        if (n.label?.name === "mut") breaks = true;
        break;

      case "AssignmentExpression": {
        const left = unwrap(n.left);
        if (left.type === "MemberExpression") {
          const path = statePath(left, depth, "writes", true);
          if (!path) break;
          const keys = keyList(path.keys);
          if (n.operator === "=") write(n, parent, path, [`set(${C}, [`, ...keys, "], ", n.right]);
          else {
            const operator = n.operator.slice(0, -1);
            write(n, parent, path, [`set(${C}, ${C}.path = [`, ...keys, `], ${NS}.get(${path.root}, ${C}.path) ${operator} (`, n.right, ")"]);
          }
        } else if (left.type === "Identifier") {
          const ref = resolve(left.name);
          if (ref.kind === "alias") throw new MutError(`\`${left.name}\` refers into state and can't be reassigned`, left.start);
          if (ref.kind === "tainted" || touchesState(n.right)) taint(left.name, null);
        } else if (touchesState(n.right)) for (const name of bindingNames(left)) taint(name, null);
        break;
      }
      case "UpdateExpression": {
        if (unwrap(n.argument).type !== "MemberExpression") break;
        const path = statePath(n.argument, depth, "writes", true);
        const delta = n.operator === "++" ? 1 : -1;
        if (path) write(n, parent, path, [`increment(${C}, [`, ...keyList(path.keys), `], ${delta}`], n.prefix ? "value" : "previous");
        break;
      }
      case "UnaryExpression": {
        if (n.operator !== "delete" || unwrap(n.argument).type !== "MemberExpression") break;
        const path = statePath(n.argument, depth, "deletes", true);
        if (path) write(n, parent, path, [`remove(${C}, [`, ...keyList(path.keys), "]"]);
        break;
      }

      case "CallExpression": {
        const name = methodName(n);
        const callee = unwrap(n.callee);
        if (name === null || (name && MUTATING_METHODS.has(name))) {
          if (callee.optional || n.optional) {
            if (touchesState(callee.object)) throw new MutError("optional mutating calls on state aren't supported yet", n.start);
          } else {
            const path = statePath(callee.object, depth, "mutating calls", true);
            const method = callee.computed ? callee.property : JSON.stringify(name);
            if (path) write(n, parent, path, [`callMethod(${C}, [`, ...keyList(path.keys), "], ", method, ", [", ...commaList(n.arguments), "]"]);
          }
        } else if (name && ITERATION_METHODS.has(name) && FUNCTIONS.has(n.arguments[0]?.type)) {
          const path = statePath(callee.object, depth, "", false);
          if (path) {
            const element = name.startsWith("reduce") ? 1 : 0;
            const callback = n.arguments[0];
            callbacks.set(callback, { path, element });
            if (promoted.has(callback.params[element])) {
              for (const c of path.consumes) consumed.add(c);
              emit(n, [`${NS}.iterate([`, ...keyList(path.keys), `], ${JSON.stringify(name)}, [`, ...commaList(n.arguments), `], ${path.root})`]);
            }
          }
        }
        if (touchesState(n.callee) || n.arguments.some(touchesState))
          for (const a of n.arguments) if (FUNCTIONS.has(a.type) && !callbacks.has(a)) taintParams.add(a);
        break;
      }

      case "VariableDeclarator": {
        if (!n.init) break;
        const path = n.id.type === "Identifier" ? statePath(n.init, depth, "", false) : null;
        if (!path) {
          if (touchesState(n.init)) for (const name of bindingNames(n.id)) taint(name, null);
        } else if (promoted.has(n.id)) {
          makeAlias(n.id, path);
          const keys = ["[", ...keyList(path.keys), "]"];
          emit(n.init, path.finds ? [`${NS}.resolve(`, ...keys, `, ${path.root})`] : keys);
        } else taint(n.id.name, n.id);
        break;
      }
      case "ForOfStatement": {
        const declarator = n.left.type === "VariableDeclaration" ? n.left.declarations[0] : null;
        const path = declarator?.id.type === "Identifier" ? statePath(n.right, depth, "", false) : null;
        if (!path) {
          if (touchesState(n.right)) for (const name of bindingNames(declarator ? declarator.id : n.left)) taint(name, null);
        } else if (promoted.has(declarator.id)) {
          makeAlias(declarator.id, path);
          emit(n.right, [`${NS}.each(() => ${path.root}, [`, ...keyList(path.keys), "])"]);
        } else taint(declarator.id.name, declarator.id);
        break;
      }
    }
  };

  const visit = (n: Node, parent: Node, depth: number) => {
    if (isTypeOnly(n)) return;
    const decls = scopeOf(n);
    if (decls) enterScope(n, decls);
    // Inline iteration callbacks run synchronously, so writes in them are fine.
    const inner = FUNCTIONS.has(n.type) && !callbacks.has(n) ? depth + 1 : depth;
    if (!consumed.has(n)) handle(n, parent, inner);
    for (const c of referenceChildren(n)) visit(c, n, inner);
    if (decls) stack.pop();
  };

  visit(label.body, label, 0);
  return { edits, breaks };
}

const commaList = (nodes: Node[]): Part[] => nodes.flatMap((n, i) => (i ? [", ", n] : [n]));
const keyList = (keys: Part[][]): Part[] => keys.flatMap((k, i) => (i ? [", ", ...k] : k));

function langOf(id: string): "js" | "jsx" | "ts" | "tsx" {
  const ext = /\.([cm]?[jt]sx?)(?:$|\?)/.exec(id)?.[1] ?? "js";
  return ext.endsWith("tsx") ? "tsx" : ext.endsWith("jsx") ? "jsx" : ext.includes("t") ? "ts" : "js";
}

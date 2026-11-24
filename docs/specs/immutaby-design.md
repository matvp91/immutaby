# immutaby — design

Date: 2026-11-24
Status: draft, awaiting approval

## 1. Intent

immutaby lets you write immutable updates the way you write mutations, and pays
for them at **build time** instead of runtime. It is a Rolldown plugin that
rewrites code inside a `mut: { ... }` labeled block into plain copy-on-write
code with structural sharing.

It aims for the same capabilities as immer (`produce`), but:

- **No Proxies, no per-access overhead.** Generated code should look like the
  object/array spreads a careful person would write by hand.
- **A tiny runtime helper** (`immutaby/runtime`) handles only what must be
  decided at runtime.
- **A simpler API:** there is no `produce`, no draft objects and no recipe
  callbacks. A labeled block marks the region, and ordinary variables are the
  state.

Background: the TC39 Records & Tuples proposal (value-semantics immutable data)
was withdrawn in 2025. immutaby does **not** try to replace that. Its goal is
ergonomic immutable *updates* with reference equality, which is what React,
selectors and memoization rely on.

## 2. Goals, non-goals, anti-goals

**Goals**

- Behavioural parity with immer's `produce` for everything listed in §5. The
  result must deep-equal immer's result, and every unchanged subtree must be
  `===` to the base (at least as much structural sharing as immer).
- Output cost close to hand-written spreads for straight-line code.
- Build cost: files without `mut:` are skipped before any JS runs (Rolldown hook
  filter). Files with `mut:` are parsed once with Rolldown's own parser.
- Valid JS/TS source. Editors, `tsc`, ESLint, Prettier and test runners keep
  working with no plugins of their own.
- Accurate sourcemaps.

**Non-goals**

- Value semantics, `===` across equal structures, interning (the R&T model).
- A runtime-only mode (no `produce()` fallback that works without the plugin).
- immer's `createDraft`/`finishDraft` (drafts that live across function
  boundaries). This is a runtime-object concept with no block-scoped equivalent.
- Babel, webpack or esbuild support in v1. The core is kept parser-agnostic
  (ESTree) so a Vite or unplugin wrapper is cheap later.

**Anti-goals** (these count as failures even if the code "works")

- Proxies, or any per-read cost on state.
- Hidden heavy work. Wherever the slow path (copy-in/reconcile-out, §5.7) is
  used, the build must say so.
- Silent mutation of the base state.
- A runtime helper that grows into a second immer. Budget: **≤ 2 KB min+gzip**
  for everything a typical app imports (enforced by a test).

## 3. Constraints

- **TypeScript everywhere**, using the latest release (TypeScript 7.0.x,
  the native compiler). Plugin, runtime, tests and examples are all `.ts`.
  The package ships ESM JS and `.d.ts`.
- Rolldown 1.3.x. Use `rolldown/parseAst` (oxc, ESTree + TS-ESTree),
  `RolldownMagicString` for edits, and `transform.filter` for skipping files.
- The plugin has **no type information**. `s.tags.add(x)` could be a Set, a Map
  or a class instance, so anything type-dependent is dispatched at runtime by
  the helper.
- Node ≥ 22. Package manager: pnpm.
- The plugin must also work as a Vite plugin in Rolldown-based Vite (8.x),
  because that is how most apps and Vitest suites will run it. The builder
  verifies this.

## 4. Approaches considered

**Surface syntax**

| Option | Verdict |
|---|---|
| immer-style `produce(state, d => {...})` | Familiar, but keeps the callback and draft concepts the user wants to drop. |
| Real custom syntax (`:=`, `#{}`) | Breaks TS, editors, linters and formatters. Rejected. |
| `set(state.a.b, v)` path-as-argument | Hard to type in TS (the return type must be the root). |
| `let s = edit(state)` marker | The draft region ends implicitly, which surprises people. |
| **`mut: { ... }` labeled block** | **Chosen.** Valid JS/TS, explicit region, zero tooling cost. |

**Mutation inside code the compiler can't see** (e.g. `rename(s.user)`)

| Option | Verdict |
|---|---|
| Build error, require return-a-new-value helpers | Fastest, but not immer parity. |
| **Copy-in, reconcile-out** | **Chosen.** Parity with immer, cost confined to those call sites, a warning at each. |
| Compile helpers across modules | Possible future improvement on top. Can't cover npm callbacks or dynamic calls alone. |

**Plugin implementation**

| Option | Verdict |
|---|---|
| **JS/TS plugin on Rolldown's parser + MagicString** | **Chosen.** Lowest build cost without Rust; the core stays portable. |
| Babel plugin wrapped for Rolldown | Second slow parse and a heavy dependency. |
| Native Rust / oxc transformer | Rolldown can't load third-party Rust plugins. |

**Generated code**: a **two-layer** design, chosen.
1. A *general path*: every write lowers to runtime-helper calls. This is the
   correct baseline and is built first.
2. An *inline layer*: statically analysable writes (straight-line code, static
   keys, known copy state) are emitted as inline spreads/copies. The general
   path remains for dynamic cases.

Both layers must pass the same test suite (§8).

## 5. Semantics of `mut:`

### 5.1 Recognising a block

- A `LabeledStatement` whose label is `mut`. The body is usually a block, but
  any statement is accepted (`mut: s.a = 1;`).
- `break mut;` exits early. Writes made before the break stay applied.
- The label is removed from the output unless `break mut` needs it.
- A `mut:` nested inside another `mut:` is merged into the outer one.
- Detection is purely syntactic. A variable or import named `mut` is irrelevant.

### 5.2 Roots

- A **root** is an identifier declared *outside* the block that is the base of a
  write path inside the block (`s` in `s.user.name = x`).
- A root must be reassignable: `let`, `var` or a function parameter. A root
  declared with `const`, an import, or an undeclared/global identifier is a
  **build error** with a code frame and a suggested fix.
- Writing through `this` (`this.state.x = 1`) is a build error in v1. The fix it
  suggests is `let s = this.state; mut: {...}; this.state = s;` *(builder may
  revisit)*.
- The base value is **never mutated**. The root variable is reassigned to the new
  root **eagerly**, at the first copy. If the block throws or returns midway,
  the root holds the writes applied so far and the base is untouched.
  *(Difference from immer, which discards everything on throw. Our call: the
  block reads as ordinary sequential code.)*
- Identifiers declared *inside* the block are ordinary locals and mutate
  normally, unless they are aliases (§5.4).

### 5.3 Writes

All of these, when the target path starts at a root or an alias:

- `=`, compound assignment (`+=` etc.), logical assignment (`||=`, `&&=`, `??=`)
- `++` / `--`
- `delete path.key`
- Static (`.a`) and computed (`[k]`) keys. Computed keys and the right-hand side
  are evaluated exactly once, in source order (preserve JS evaluation order).

Copy-on-write rules:

- Each node on the path is shallow-copied **at most once per block**. Later
  writes go into the copy.
- **No-op writes don't copy.** If `Object.is(current, next)`, nothing changes,
  so a block where nothing actually changes leaves the root `===` to the base.
- What gets copied: plain objects (prototype preserved), arrays, `Map`, `Set`, and
  class instances marked draftable via `Symbol.for("immer-draftable")` (the same
  symbol immer uses, re-exported as `immerable`). Other objects are **not copied**,
  like immer's non-draftables: writes go straight through, with a
  dev-mode warning.
- Reads inside the block see the updated values.

### 5.4 Aliases

- `const u = s.user;` (or `let`) inside a block makes `u` an alias of path
  `s.user`. Writing through `u` copies along `s.user` and rebinds `u` to the copy.
- Aliases chain (`const a = u.address`).
- An alias is compiled to the **path** it was read from, with computed keys (and
  `find` results) captured when it is created. Reads become `get(root, path)`. As a
  consequence, an alias follows its *position*: after `s.todos.splice(0, 1)`, an
  alias of `s.todos[1]` points at what is now at index 1.
- Locals become aliases only when the block writes through them; read-only locals
  and callbacks compile to plain code with no overhead.
- Conditional and logical aliases (`cond ? s.a : s.b`, `s.a ?? s.b`) are allowed
  when every branch is a path. The compiler emits a runtime ref per branch.
- An alias initialised from anything else (a call result, an `await`) is not an
  alias. A call that receives a tree node is an opaque call (§5.7).

### 5.5 Methods on tree nodes

All method calls on a root/alias path go through runtime dispatch (no type info).

- **Mutating methods:**
  - Array `push pop shift unshift splice sort reverse fill copyWithin`
  - Map `set delete clear`
  - Set `add delete clear`

  The receiver is copied once, then the method runs on the copy. Return values
  match the native ones.
- **Subset-returning reads** become *views*, so writes through the result land in
  the original structure: Array `find findLast filter slice at`, indexing
  `arr[i]`, Map `get`, iteration (`for...of`, `entries`, `values`).
  Example: `s.todos.find(t => t.id === id).title = "x"`.
- **Inline callbacks** to array methods (`forEach map filter find findLast some
  every reduce reduceRight flatMap findIndex findLastIndex`) are compiled. The
  element parameter is an alias of `arr[i]`, so `s.todos.forEach(t => { t.done = true })`
  works and untouched elements stay shared. *(immer's own `enableArrayMethods`
  mode does not allow writes in `filter` callbacks; we do, because it falls out
  of the same alias mechanism.)*
- **Primitive-returning reads** (`indexOf includes join some every`, `size`,
  `has` …) run on the current value, with nothing to track.
- **Non-subset transforms** (`map concat flat flatMap` results, `toSorted`, `with`)
  return new, unaliased values, as in immer.
- **Unknown methods** on a node (e.g. `s.cart.addItem(x)`) are opaque calls (§5.7)
  on the receiver.

### 5.6 Control flow

- `if`, `switch`, `for`, `for...of`, `for...in`, `while`, `do`, `try`,
  `await` and `yield` are all allowed inside a block. Where the compiler can't
  prove the copy state statically, the runtime tracks it per block (a small
  context object).
- `for (const t of s.todos)` binds `t` as an alias to each element.
- Function expressions created inside the block that write to roots:
  - passed directly as an inline callback to a §5.5 array method → compiled;
  - called immediately (IIFE) → compiled;
  - anything else (stored, passed to unknown functions, scheduled) → **build
    error**, because the write would happen after the block ends.

### 5.7 Opaque calls: copy-in, reconcile-out

An **opaque call** is any call the compiler can't see into, when an argument (or
the receiver) is a tree node reached from a root or alias:
`rename(s.user)`, `helper(u)`, `s.cart.addItem(x)`.

1. **Copy-in:** if the value is an object at runtime (primitives skip all of
   this), deep-copy it using the §5.3 copy rules, put the copy into the tree at
   that path, and mark that subtree as *owned*. Later writes to it in the block
   mutate it directly.
2. The call runs with the copy, which it may mutate freely. Values it returns
   that point into the copy stay valid.
3. **Reconcile-out** at block end: walk each owned subtree against its base and
   reuse every base node that is structurally equal (own enumerable keys,
   `Object.is` on leaves, same prototype, same Map/Set contents). Unchanged
   parts become `===` to the base again.

Rules around it:

- **Every opaque call site produces a build warning** (`IMMUTABY_OPAQUE_CALL`)
  naming the file and line. A plugin option `opaqueCalls: "warn" | "error" | "allow"`
  defaults to `"warn"`.
- **Built-in allowlist** of known read-only globals that never trigger
  copy-in: `JSON.stringify`, `Object.keys/values/entries`, `Array.isArray`,
  `structuredClone`, `String`, `Number`, `Boolean`, `console.*`, `Math.*`, and
  `Object.is`. The user can extend it through a plugin option (`readonlyCalls`).
- A per-call opt-out comment marks a call read-only (e.g.
  `/* @immutaby-readonly */ format(s.user)`). The exact spelling is the builder's
  call.

### 5.8 Utilities (compiled away or tiny)

Exported from `immutaby`, valid only inside a `mut:` block (a build error
elsewhere):

- `original(path)`: the base value at that path.
- `current(path)`: the current value. Trivial, since values are always real
  objects. Kept for immer familiarity.
- `isModified(path)`: whether the path's current value `!==` its base.
- `nothing` is not needed (assign `s = undefined`), and returning a new value is
  plain assignment (`s = { ...fresh }`).

### 5.9 Freezing

Plugin option `freeze: "dev" | "always" | "never"`, default `"dev"`. When
freezing is on, new nodes produced by a block are deep-frozen at block end, so
mutation outside `mut:` throws (strict mode), as with immer's auto-freeze.
"dev" means `NODE_ENV !== "production"` at build time (Vite and Vitest set it;
plain Rolldown production builds should too). Freezing walks from each written
root and stops at already-frozen nodes, so after the first block only new nodes
are visited. Frozen Map/Set get throwing `set`/`add`/`delete`/`clear`.
Non-draftable class instances are not frozen.

### 5.10 Patches (opt-in, last milestone)

`mut.patches` (exact API is the builder's call, but it must stay a valid labeled
block or an import) emits immer-compatible `{ op, path, value }` patches and
inverse patches. `applyPatches` is exported from the runtime. The cost is paid
only when used.

## 6. TypeScript users

- Inside `mut:`, writes are ordinary assignments, so state types must be
  writable from TS's point of view. Users with `readonly`/`Immutable<T>` state
  types bind a writable view: `let s: Draft<State> = state;`.
- The package exports type-only `Draft<T>` and `Immutable<T>`, which are compatible
  with immer's semantics. No runtime cost.
- The plugin runs after TS syntax is present or stripped. Labels survive
  either way. The builder confirms the hook order under Rolldown's built-in TS
  transform.

## 7. Package and project layout

Single package `immutaby`, ESM-only:

```
immutaby/
  src/
    plugin/        # Rolldown plugin: filter, parse, analyse, emit (ESTree core is parser-agnostic)
    runtime/       # immutaby/runtime: COW helpers, dispatch, views, reconcile, freeze, patches
    index.ts       # plugin export (default) + types + compile-time utilities
  test/
    fixtures/      # input .ts → expected output snapshots
    parity/        # differential tests against immer
  bench/
  examples/        # a small app built with Rolldown (and one with Vite)
  docs/
```

Exports: `immutaby` (the plugin factory and types) and `immutaby/runtime` (the helper,
auto-imported by the plugin). Tooling: TypeScript 7.0.x, Rolldown 1.3.x, Vitest,
pnpm.

## 8. Testing and success criteria

- **Differential parity tests (the main oracle).** Each case is written twice:
  as a `mut:` block, and as the equivalent immer `produce` recipe. Assert the
  results deep-equal, and that every subtree unchanged in immer's result is also
  `===` to the base in ours. Cover every item in §5, including no-op writes,
  aliases, views, inline callbacks, loops, Map/Set, draftable classes and opaque
  calls. Consider property-based generation of random update sequences.
- **Base never mutated**: deep-freeze the base in every parity test.
- **Both output layers** (general path only, and with inlining) run the full
  suite.
- **Fixture snapshots** of compiled output, so regressions in generated code are
  visible.
- **Build diagnostics** tests for every error and warning (const root, escaping
  closure, opaque call, `this` root, utility used outside a block).
- **Runtime size budget**: ≤ 2 KB min+gzip, enforced in CI.
- **Benchmarks** (`bench/`) comparing hand-written spreads, immutaby and immer
  (default and `enableArrayMethods`). Target: straight-line updates within ~1.2×
  of hand-written spreads. Report the opaque-call path separately.
- **Sourcemaps**: errors thrown inside a block map back to the original line.

## 9. Milestones (ordering is our call; the builder may adjust)

1. Project scaffold, plugin skeleton (filter, parse, MagicString,
   runtime injection), parity harness against immer.
2. General path: roots, writes, no-op detection, eager rebinding, objects and
   arrays, diagnostics.
3. Aliases, views, array methods and inline callbacks, loops and control flow.
4. Opaque calls: copy-in, reconcile-out, warnings, allowlist.
5. Map/Set, draftable classes, freezing, utilities.
6. Inline layer (performance) and benchmarks.
7. Patches.

## 10. Left to the builder

- Internal representation of the analysis (scope tracking, path IR).
- Exact runtime helper names and the injected import shape.
- How the per-block runtime context tracks copy state (flags vs. `Map<base, copy>`).
- Spelling of the read-only opt-out comment and the patches API, within the
  constraints above.
- How "dev" mode is detected for freezing.
- The deep-equality details of reconciliation, as long as §5.7 holds.
- Whether to use property-based testing and which library.

## 11. Known risks

- **A `mut:` block that runs without the plugin silently mutates.** A label is
  inert JS. Mitigations: clear docs; Vite/Vitest integration in examples; a
  possible later ESLint rule or a dev-build check. The builder should flag
  any cheap detection idea.
- **Reconcile cost** on large subtrees passed to opaque calls. Mitigated by the
  warnings, the allowlist and the opt-out comment.
- **Dispatch without types** makes `s.items.push` cost one runtime type check.
  The inline layer can't remove that without type info.

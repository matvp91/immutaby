# immutaby

Write immutable updates as plain mutations. A bundler plugin compiles them at build time into copy-on-write code with structural sharing: no Proxies, no wrapper objects, and only a small runtime helper.

```ts
let s = state;
mut: {
  s.user.name = "Ada";
  s.todos.push({ id: 2, done: false });
}
// `s` is a new object, `state` is untouched,
// and everything that didn't change is shared: s.settings === state.settings
```

## Install

```sh
pnpm add -D immutaby
```

There is a plugin for each bundler [unplugin](https://github.com/unjs/unplugin) supports: `rolldown`, `vite`, `rollup`, `esbuild`, `webpack`, `rspack`, `rsbuild`, `farm`, `bun` and `unloader`.

```ts
// rolldown.config.ts
import { defineConfig } from "rolldown";
import { rolldown as immutaby } from "immutaby";

export default defineConfig({
  input: "src/index.ts",
  plugins: [immutaby()],
});
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { vite as immutaby } from "immutaby";

export default defineConfig({
  plugins: [immutaby()],
});
```

To compile without a bundler, call `transform(code, id, options)` from `immutaby` directly.

## Usage

A `mut:` block is a labeled block, so it is valid JavaScript and TypeScript. Inside it, writes to state are compiled into updates.

**State is any variable declared outside the block.** It must be a `let`, `var` or parameter, because it is reassigned to the updated value. Variables declared inside the block are ordinary locals.

```ts
function rename(state: State, name: string): State {
  mut: {
    state.user.name = name; // a parameter is fine
  }
  return state;
}
```

**Supported writes:** `=`, compound and logical assignment (`+=`, `??=`, …), `++`/`--`, `delete`, array mutators (`push`, `splice`, `sort`, …) and Map/Set mutators (`set`, `add`, `delete`, `clear`). A write that changes nothing copies nothing, so the result is the original object.

**Locals, loops and callbacks** that point into state can be written through:

```ts
mut: {
  const user = s.user;
  user.name = "Ada";

  for (const todo of s.todos) {
    todo.done = false;
  }

  s.todos.forEach((todo) => {
    todo.title = todo.title.trim();
  });

  const todo = s.todos.find((item) => item.id === id);
  if (!todo) {
    break mut; // leaves the block, keeping earlier writes
  }
  todo.done = true;
}
```

**Helper functions** that mutate what they receive work too: `rename(s.user)` passes a deep copy, and unchanged parts are shared again when the block ends. This costs more than a direct write, so the build warns at each such call. List functions that don't mutate their arguments in `readonlyCalls` to skip it.

**Classes** are copied only when marked with `immerable` (the same symbol as immer's). Other class instances are shared, and writes to them go straight through.

```ts
import { immerable } from "immutaby";

class Todo {
  static [immerable] = true;
}
```

**Freezing:** in development builds, state written in a block is deep-frozen when the block ends, so accidental mutation outside `mut:` throws. Production builds (`NODE_ENV=production`) skip it.

## How it compiles

Statement-level writes become inline copies. Each node is copied once per block, and an identity check keeps that correct through loops and branches:

```js
// s.user.name = "Ada"; (generated variable names simplified)
{
  const v = "Ada";
  if (!__imm_isUnchanged(s.user, "name", v)) {
    if (s !== c0) s = c0 = __imm_shallowCopy(s);
    if (s.user !== c1) s.user = c1 = __imm_shallowCopy(s.user);
    s.user.name = v;
  }
}
```

Other writes call small helpers from `immutaby/runtime` (under 2 KB min+gzip; only the helpers a module uses are bundled).

## Options

```ts
immutaby({
  freeze: "dev", // "dev" | "always" | "never"
  opaqueCalls: "warn", // "warn" | "error" | "allow": calls that get a deep copy
  readonlyCalls: ["format", "log.debug"], // functions that don't mutate their arguments
  runtime: "immutaby/runtime", // module the generated code imports
});
```

## Linters and TypeScript

Linters see `mut:` blocks before the plugin does, so turn off rules that remove labels or change `let` to `const`:

- Biome: `correctness/noUnusedLabels`, `suspicious/noConfusingLabels`, `style/useConst`
- ESLint: `no-unused-labels`, `no-labels`, `prefer-const`
- TypeScript: don't set `allowUnusedLabels: false`

Writes inside a block must type-check, so state types can't be `readonly` there.

## Limitations

- Without the plugin, a `mut:` block is ordinary code and mutates in place.
- A local that points into state follows its position: after `s.todos.splice(0, 1)`, a local read from `s.todos[1]` points at what is now at index 1.
- Not tracked yet (build error): writes through `filter` results, through destructured locals (`const { user } = s`), and inside functions that run after the block (e.g. a `setTimeout` callback).

## Performance

Measured against hand-written spreads (`pnpm bench`, lower is better):

| Update                         | immutaby | immer |
| ------------------------------ | -------- | ----- |
| Nested write                   | 1.6×     | 18×   |
| Update by index in 1000 items  | 1.1×     | 6×    |
| Find by id and update          | 1.0×     | 48×   |
| Toggle all 1000 with `forEach` | 3.4×     | 41×   |

## Development

```sh
pnpm test      # Vitest; test files contain `mut:` blocks compiled by the plugin
pnpm bench     # benchmarks against hand-written spreads and immer
pnpm format    # Biome: format, sort imports, apply safe fixes
pnpm build     # emit dist/
```

Examples: [examples/basic](examples/basic) (Rolldown) and [examples/react](examples/react) (a todo list with `useReducer`; run `pnpm build`, then `pnpm --filter immutaby-example-react dev`).

The design is described in [docs/immutaby-design.md](docs/immutaby-design.md).

## License

MIT

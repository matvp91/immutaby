import { produce, setAutoFreeze } from "immer";
import { Bench } from "tinybench";
import type { State, Todo } from "./state.ts";
import { createState } from "./state.ts";

setAutoFreeze(false);

const small = createState(10);
const large = createState(1000);
const target = 500;
const todo: Todo = { id: -1, title: "new", done: false, tags: [] };

const rename = (user: State["user"]) => {
  user.name = "Grace";
};

/**
 * Results are stored here so neither the bundler nor the JIT can drop the work.
 */
let sink: unknown;

const suites: Record<
  string,
  Record<"spread" | "immutaby" | "immer", () => void>
> = {
  "nested write": {
    spread: () => {
      const s = small;
      sink = {
        ...s,
        user: {
          ...s.user,
          profile: { ...s.user.profile, visits: s.user.profile.visits + 1 },
        },
      };
    },
    immutaby: () => {
      let s = small;
      mut: {
        s.user.profile.visits++;
      }
      sink = s;
    },
    immer: () => {
      sink = produce(small, (d) => {
        d.user.profile.visits++;
      });
    },
  },
  "three writes on one path": {
    spread: () => {
      const s = small;
      sink = {
        ...s,
        user: {
          ...s.user,
          name: "Grace",
          profile: { ...s.user.profile, email: "g@example.com", visits: 1 },
        },
      };
    },
    immutaby: () => {
      let s = small;
      mut: {
        s.user.name = "Grace";
        s.user.profile.email = "g@example.com";
        s.user.profile.visits = 1;
      }
      sink = s;
    },
    immer: () => {
      sink = produce(small, (d) => {
        d.user.name = "Grace";
        d.user.profile.email = "g@example.com";
        d.user.profile.visits = 1;
      });
    },
  },
  "push onto 1000 items": {
    spread: () => {
      const s = large;
      sink = { ...s, todos: [...s.todos, todo] };
    },
    immutaby: () => {
      let s = large;
      mut: {
        s.todos.push(todo);
      }
      sink = s;
    },
    immer: () => {
      sink = produce(large, (d) => {
        d.todos.push(todo);
      });
    },
  },
  "update by index in 1000": {
    spread: () => {
      const s = large;
      const todos = s.todos.slice();
      todos[target] = { ...todos[target], done: !todos[target].done };
      sink = { ...s, todos };
    },
    immutaby: () => {
      let s = large;
      mut: {
        s.todos[target].done = !s.todos[target].done;
      }
      sink = s;
    },
    immer: () => {
      sink = produce(large, (d) => {
        d.todos[target].done = !d.todos[target].done;
      });
    },
  },
  "find by id and update in 1000": {
    spread: () => {
      const s = large;
      sink = {
        ...s,
        todos: s.todos.map((t) =>
          t.id === target ? { ...t, title: "found" } : t,
        ),
      };
    },
    immutaby: () => {
      let s = large;
      mut: {
        (s.todos.find((t) => t.id === target) as Todo).title = "found";
      }
      sink = s;
    },
    immer: () => {
      sink = produce(large, (d) => {
        (d.todos.find((t) => t.id === target) as Todo).title = "found";
      });
    },
  },
  "toggle all 1000 (forEach)": {
    spread: () => {
      const s = large;
      sink = { ...s, todos: s.todos.map((t) => ({ ...t, done: !t.done })) };
    },
    immutaby: () => {
      let s = large;
      mut: {
        s.todos.forEach((t) => {
          t.done = !t.done;
        });
      }
      sink = s;
    },
    immer: () => {
      sink = produce(large, (d) => {
        d.todos.forEach((t) => {
          t.done = !t.done;
        });
      });
    },
  },
  "helper mutates its argument": {
    spread: () => {
      const s = small;
      sink = { ...s, user: { ...s.user, name: "Grace" } };
    },
    immutaby: () => {
      let s = small;
      mut: {
        rename(s.user);
      }
      sink = s;
    },
    immer: () => {
      sink = produce(small, (d) => {
        rename(d.user);
      });
    },
  },
};

const rows: Record<string, Record<string, string>> = {};

for (const [name, variants] of Object.entries(suites)) {
  const bench = new Bench({ time: 300 });
  for (const [variant, fn] of Object.entries(variants)) {
    bench.add(variant, fn);
  }
  await bench.run();
  const opsPerSecond = (variant: string) => {
    const task = bench.getTask(variant);
    if (!task) {
      throw new Error(`no benchmark task named "${variant}"`);
    }
    const { result } = task;
    return "throughput" in result ? result.throughput.mean : NaN;
  };
  const spread = opsPerSecond("spread");
  const format = (variant: string) => {
    const ops = opsPerSecond(variant);
    return `${(ops / 1e6).toFixed(2)}M ops/s (${(spread / ops).toFixed(1)}×)`;
  };
  rows[name] = {
    spread: `${(spread / 1e6).toFixed(2)}M ops/s`,
    immutaby: format("immutaby"),
    immer: format("immer"),
  };
}

console.table(rows);
console.log("(× = times slower than hand-written spread)", typeof sink);

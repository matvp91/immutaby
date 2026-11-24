import { expect, it } from "vitest";
import { freeze } from "./freeze.ts";

const state = freeze({
  user: { name: "x", age: 1, address: { city: "Gent" } },
  todos: [
    { id: 1, done: false },
    { id: 2, done: true },
  ],
  settings: { theme: "dark" } as { theme?: string },
  count: 0,
});

it("copies the written path and shares the rest", () => {
  let s = state;
  mut: {
    s.user.name = "Ada";
  }
  expect(s.user).toEqual({ name: "Ada", age: 1, address: { city: "Gent" } });
  expect(s).not.toBe(state);
  expect(s.user.address).toBe(state.user.address);
  expect(s.todos).toBe(state.todos);
  expect(state.user.name).toBe("x");
});

it("copies each node once across several writes", () => {
  let s = state;
  let first: unknown;
  mut: {
    s.user.name = "Ada";
    first = s.user;
    s.user.age = 2;
  }
  expect(s.user).toBe(first);
  expect(s.user).toEqual({ name: "Ada", age: 2, address: state.user.address });
});

it("returns the same root when nothing changes", () => {
  let s = state;
  mut: {
    s.user.name = "x";
    s.count = 0;
  }
  expect(s).toBe(state);
});

it("compound, logical and update operators", () => {
  let s: typeof state & { user: { nick?: string } } = state;
  mut: {
    s.count += 5;
    s.user.age *= 3;
    s.user.nick ??= "n";
    s.user.name ||= "never";
    s.count++;
    --s.user.age;
  }
  expect([s.count, s.user.age, s.user.nick, s.user.name]).toEqual([6, 2, "n", "x"]);
});

it("computed keys and array indexes", () => {
  let s = state;
  const key = "theme";
  mut: {
    s.settings[key] = "light";
    s.todos[1].done = false;
  }
  expect(s.settings.theme).toBe("light");
  expect(s.todos[1]).toEqual({ id: 2, done: false });
  expect(s.todos[0]).toBe(state.todos[0]);
});

it("delete", () => {
  let s = state;
  mut: {
    delete s.settings.theme;
  }
  expect(s.settings).toEqual({});
  expect(state.settings.theme).toBe("dark");
});

it("writes inside if and for", () => {
  let s = state;
  mut: {
    for (let i = 0; i < s.todos.length; i++) {
      if (s.todos[i].done) {
        s.todos[i].done = false;
      }
    }
  }
  expect(s.todos.map((t) => t.done)).toEqual([false, false]);
  expect(s.todos[0]).toBe(state.todos[0]);
});

it("break mut keeps earlier writes", () => {
  let s = state;
  mut: {
    s.count = 1;
    if (s.count) {
      break mut;
    }
    s.count = 2;
  }
  expect(s.count).toBe(1);
});

it("writes used as expressions return their JS value", () => {
  let s = state;
  let out: unknown[] = [];
  mut: {
    out.push((s.count = 3), s.count++, ++s.count, delete s.settings.theme, (s.user.age += 1));
  }
  expect(out).toEqual([3, 3, 5, true, 2]);
});

it("keeps writes nested in the right-hand side", () => {
  let s = state;
  mut: {
    s.user.name = ((s.count = 7), "y");
  }
  expect([s.count, s.user.name]).toEqual([7, "y"]);
});

it("works on parameters and single statements", () => {
  const rename = (s: typeof state, name: string) => {
    mut: s.user.name = name;
    return s;
  };
  expect(rename(state, "Ada").user.name).toBe("Ada");
});

it("handles TypeScript syntax in paths", () => {
  let s: { a: { b: number } | null } = freeze({ a: { b: 1 } });
  mut: {
    // biome-ignore lint/style/noNonNullAssertion: this test checks that the plugin handles `!` in a write path.
    s.a!.b = 2;
    (s.a as Record<string, number>).c = 3;
  }
  expect(s).toEqual({ a: { b: 2, c: 3 } });
});

it("locals declared inside the block mutate normally", () => {
  let s = state;
  mut: {
    const item = { id: 3, done: false };
    item.done = true;
    s.todos.push(item);
  }
  expect(s.todos[2]).toEqual({ id: 3, done: true });
});

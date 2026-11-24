import { expect, it } from "vitest";
import { freeze } from "./freeze.ts";

const state = freeze({
  user: { name: "x", address: { city: "Gent" } },
  todos: [
    { id: 1, title: "a", done: false },
    { id: 2, title: "b", done: false },
    { id: 3, title: "c", done: true },
  ],
  lists: [{ items: [1] }, { items: [2] }],
});
type Todo = (typeof state.todos)[number];

it("writes through a local alias", () => {
  let s = state;
  mut: {
    const user = s.user;
    user.name = "Ada";
    const address = user.address;
    address.city = "Brussel";
  }
  expect(s.user).toEqual({ name: "Ada", address: { city: "Brussel" } });
  expect(s.todos).toBe(state.todos);
});

it("captures computed keys when the alias is created", () => {
  let s = state;
  mut: {
    let i = 1;
    const todo = s.todos[i];
    i = 0;
    todo.done = true;
  }
  expect(s.todos.map((t) => t.done)).toEqual([false, true, true]);
});

it("method calls through an alias", () => {
  let s = state;
  mut: {
    const items = s.lists[1].items;
    items.push(3);
  }
  expect(s.lists[1].items).toEqual([2, 3]);
  expect(s.lists[0]).toBe(state.lists[0]);
});

it("for...of over state", () => {
  let s = state;
  mut: {
    for (const todo of s.todos) {
      if (!todo.done) {
        todo.title = todo.title.toUpperCase();
      }
    }
  }
  expect(s.todos.map((t) => t.title)).toEqual(["A", "B", "c"]);
  expect(s.todos[2]).toBe(state.todos[2]);
});

it("forEach callbacks", () => {
  let s = state;
  mut: {
    s.todos.forEach((todo, i) => {
      if (i < 2) {
        todo.done = true;
      }
    });
  }
  expect(s.todos.map((t) => t.done)).toEqual([true, true, true]);
  expect(s.todos[2]).toBe(state.todos[2]);
});

it("reduce callbacks get the element second", () => {
  let s = state;
  let total = 0;
  mut: {
    total = s.todos.reduce((sum, todo) => {
      todo.done = false;
      return sum + todo.id;
    }, 0);
  }
  expect(total).toBe(6);
  expect(s.todos.every((t) => !t.done)).toBe(true);
});

it("writes through find", () => {
  let s = state;
  mut: {
    (s.todos.find((t) => t.id === 2) as Todo).title = "B";
  }
  expect(s.todos[1].title).toBe("B");
  expect(s.todos[0]).toBe(state.todos[0]);
});

it("an alias of a find result", () => {
  let s = state;
  mut: {
    const todo = s.todos.findLast((t) => !t.done);
    if (todo) {
      todo.done = true;
      todo.title += "!";
    }
  }
  expect(s.todos[1]).toEqual({ id: 2, title: "b!", done: true });
});

it("read-only aliases and callbacks stay plain", () => {
  let s = state;
  let ids: number[] = [];
  mut: {
    const todos = s.todos;
    ids = todos.filter((t) => t.done).map((t) => t.id);
  }
  expect(ids).toEqual([3]);
  expect(s).toBe(state);
});

it("callbacks without parentheses or an index parameter", () => {
  let s = state;
  mut: {
    s.todos.forEach((todo) => (todo.title = "x"));
    s.todos.forEach((todo) => {
      todo.done = true;
    });
  }
  expect(s.todos.map((t) => [t.title, t.done])).toEqual([
    ["x", true],
    ["x", true],
    ["x", true],
  ]);
});

it("falls back to runtime paths when keys aren't static", () => {
  let s = state;
  const j = 1;
  mut: {
    s.lists[j].items.forEach((item, i, list) => {
      void list;
      s.lists[j].items[i] = item * 10;
    });
    for (const item of s.lists[j].items) {
      void item;
    }
    const items = s.lists[j].items;
    for (const [index] of items.entries()) {
      items[index]++;
    }
  }
  expect(s.lists[1].items).toEqual([21]);
  expect(s.lists[0]).toBe(state.lists[0]);
});

it("nested aliases inside callbacks and loops", () => {
  let s = freeze({
    groups: [
      { todos: [{ done: false }, { done: false }] },
      { todos: [{ done: true }] },
    ],
  });
  mut: {
    for (const group of s.groups) {
      group.todos.forEach((todo) => {
        todo.done = !todo.done;
      });
    }
  }
  expect(s.groups.map((g) => g.todos.map((t) => t.done))).toEqual([
    [true, true],
    [false],
  ]);
});

it("for...of over a non-array state value throws", () => {
  let s = { tags: new Set(["a"]) as unknown as { label: string }[] };
  expect(() => {
    mut: {
      for (const tag of s.tags) {
        tag.label = "x";
      }
    }
  }).toThrow(/arrays only/);
});

it("writes only through a derived alias", () => {
  let s = state;
  mut: {
    const user = s.user;
    const address = user.address;
    address.city = "Brussel";
  }
  expect(s.user.address.city).toBe("Brussel");
  expect(state.user.address.city).toBe("Gent");
});

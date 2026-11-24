import { expect, it } from "vitest";
import { immerable } from "../src/index.ts";
import { freeze } from "./freeze.ts";

const state = freeze({
  user: { name: "x", address: { city: "Gent" }, tags: ["a"] },
  todos: [
    { id: 1, done: false },
    { id: 2, done: false },
  ],
  other: { deep: { value: 1 } },
});

type User = typeof state.user;

function rename(user: User, name: string) {
  user.name = name;
}

function touchNothing(user: User) {
  user.name = user.name;
}

it("helpers can mutate what they are given", () => {
  let s = state;
  mut: {
    rename(s.user, "Ada");
  }
  expect(s.user.name).toBe("Ada");
  expect(state.user.name).toBe("x");
});

it("reconciles: untouched parts of the lent value are shared again", () => {
  let s = state;
  mut: {
    rename(s.user, "Ada");
  }
  expect(s.user.address).toBe(state.user.address);
  expect(s.user.tags).toBe(state.user.tags);
  expect(s.other).toBe(state.other);
});

it("reconciles back to the original root when nothing changed", () => {
  let s = state;
  mut: {
    touchNothing(s.user);
  }
  expect(s).toBe(state);
});

it("works with aliases, callbacks and Object.assign", () => {
  let s = state;
  mut: {
    const user = s.user;
    Object.assign(user, { name: "Ada" });
    s.todos.forEach((todo) => {
      Object.assign(todo, { done: todo.id === 2 });
    });
  }
  expect(s.user.name).toBe("Ada");
  expect(s.todos.map((t) => t.done)).toEqual([false, true]);
  expect(s.todos[0]).toBe(state.todos[0]);
});

it("lends the receiver of unknown methods", () => {
  class Counter {
    static [immerable] = true;
    count = 0;
    bump() {
      this.count++;
    }
  }
  const base = freeze({ counter: new Counter() });
  let s = base;
  mut: {
    s.counter.bump();
  }
  expect(s.counter.count).toBe(1);
  expect(s.counter).toBeInstanceOf(Counter);
  expect(base.counter.count).toBe(0);
});

it("leaves read-only calls alone", () => {
  let s = state;
  let text = "";
  mut: {
    text =
      JSON.stringify(s.user) +
      s.user.name.toUpperCase() +
      Object.keys(s.todos).join();
  }
  expect(text).toContain("X");
  expect(s).toBe(state);
});

it("reconciles after break mut", () => {
  let s = state;
  mut: {
    rename(s.user, "Ada");
    break mut;
  }
  expect(s.user.name).toBe("Ada");
  expect(s.user.address).toBe(state.user.address);
});

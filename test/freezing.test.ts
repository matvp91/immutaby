import { expect, it } from "vitest";
import { transform } from "../src/index.ts";

it("freezes the result deeply, including new values", () => {
  let s = { user: { name: "x" }, todos: [] as { id: number }[] };
  mut: {
    s.user.name = "Ada";
    s.todos.push({ id: 1 });
  }
  expect(Object.isFrozen(s)).toBe(true);
  expect(Object.isFrozen(s.user)).toBe(true);
  expect(Object.isFrozen(s.todos[0])).toBe(true);
  expect(() => {
    s.user.name = "outside";
  }).toThrow(TypeError);
});

it("makes frozen Map and Set mutators throw", () => {
  let s = { tags: new Set(["a"]), index: new Map([["k", 1]]) };
  mut: {
    s.tags.add("b");
  }
  expect(() => s.tags.add("c")).toThrow(/frozen/);
  expect(() => s.index.set("k", 2)).toThrow(/frozen/);
  expect(s.tags.has("b")).toBe(true);
});

it("frozen state can still be updated in the next block", () => {
  let s = { tags: new Set(["a"]), list: [1] };
  mut: {
    s.list.push(2);
  }
  mut: {
    s.tags.add("b");
    s.list.push(3);
  }
  expect([...s.tags]).toEqual(["a", "b"]);
  expect(s.list).toEqual([1, 2, 3]);
});

it("leaves class instances that aren't draftable alone", () => {
  class Box {
    value = 1;
  }
  let s = { box: new Box(), n: 0 };
  mut: {
    s.n = 1;
  }
  expect(Object.isFrozen(s.box)).toBe(false);
});

it("can be turned off", () => {
  const source = `let s = {}; mut: { s.a = 1; }`;
  expect(transform(source, "a.ts", { freeze: "never" })?.code).not.toContain("freeze");
  expect(transform(source, "a.ts", { freeze: "always" })?.code).toContain("__imm.deepFreeze(s)");
});

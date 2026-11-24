import { expect, it } from "vitest";
import { freeze } from "./freeze.ts";

it("array mutators copy the array once", () => {
  let s = freeze({ list: [3, 1, 2], other: {} });
  mut: {
    s.list.push(4);
    s.list.sort();
    s.list.splice(0, 1);
  }
  expect(s.list).toEqual([2, 3, 4]);
  expect(s.other).toBe(s.other);
});

it("method calls return their value", () => {
  let s = freeze({ list: [1] });
  let length = 0;
  mut: {
    length = s.list.push(2);
  }
  expect(length).toBe(2);
});

it("Map and Set mutators", () => {
  const state = { tags: new Set(["a"]), index: new Map([["k", 1]]) };
  let s = state;
  mut: {
    s.tags.add("b");
    s.index.set("k", 2);
  }
  expect([...s.tags]).toEqual(["a", "b"]);
  expect(s.index.get("k")).toBe(2);
  expect([...state.tags]).toEqual(["a"]);
  expect(state.index.get("k")).toBe(1);
});

it("calls that change nothing keep the root", () => {
  const state = { tags: new Set(["a"]), index: new Map([["k", 1]]) };
  let s = state;
  mut: {
    s.tags.add("a");
    s.index.set("k", 1);
    s.index.delete("missing");
  }
  expect(s).toBe(state);
});

it("replacing the root is a plain assignment", () => {
  let s = freeze({ count: 1, other: {} });
  mut: {
    s = { ...s, count: 9 };
  }
  expect(s.count).toBe(9);
});

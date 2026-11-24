import { expect, it } from "vitest";
import { transform } from "../src/index.ts";

const compile = (source: string) => transform(source, "entry.ts")?.code;
const rejects = (source: string, message: RegExp) =>
  expect(() => compile(source)).toThrow(message);

it("leaves reads alone", () => {
  expect(
    compile(`let s = {}; mut: { const ids = s.todos.map((t) => t.id); }`),
  ).toBeUndefined();
});

it("leaves locals alone", () => {
  expect(compile(`mut: { const x = {}; x.a = 1; }`)).toBeUndefined();
});

it("rejects roots that can't be rebound", () => {
  rejects(`const s = {}; mut: { s.a = 1; }`, /declared as const/);
  rejects(`import s from "x"; mut: { s.a = 1; }`, /declared as import/);
  rejects(`mut: { s.a = 1; }`, /isn't declared/);
  rejects(`class A { m() { mut: { this.a.b = 1; } } }`, /this/);
});

it("rejects writes it can't track yet", () => {
  rejects(
    `let s = {}; mut: { const f = () => { s.a = 1; }; }`,
    /nested function/,
  );
  rejects(
    `let s = {}; mut: {
      const open = s.todos.filter((t) => t.done);
      open[0].done = true;
    }`,
    /isn't a plain path/,
  );
  rejects(
    `let s = {}; mut: { let u = s.user; u.name = 1; u = {}; }`,
    /can't be reassigned/,
  );
  rejects(
    `let s = {}; mut: { const { user } = s; user.name = "x"; }`,
    /isn't a plain path/,
  );
  rejects(
    `let s = {}; mut: { setTimeout(() => { s.a = 1; }); }`,
    /nested function/,
  );
});

it("drops the label unless the block breaks out of it", () => {
  expect(compile(`let s = {}; mut: { s.a = 1; }`)).not.toMatch(/mut:/);
  expect(compile(`let s = {}; mut: { s.a = 1; break mut; }`)).toMatch(/mut:/);
});

it("warns at each opaque call", () => {
  const result = transform(
    `let s = {}; mut: {
      rename(s.user); format(s.todos); console.log(s.user);
    }`,
    "entry.ts",
  );
  expect(result?.warnings.map((w) => w.message)).toEqual([
    expect.stringMatching(/`rename` may change state/),
    expect.stringMatching(/`format` may change state/),
  ]);
  const quiet = transform(`let s = {}; mut: { format(s.todos); }`, "entry.ts", {
    readonlyCalls: ["format"],
  });
  expect(quiet).toBeNull();
  expect(() =>
    transform(`let s = {}; mut: { rename(s.user); }`, "entry.ts", {
      opaqueCalls: "error",
    }),
  ).toThrow(/rename/);
});

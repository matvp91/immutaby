import type { SourceMap } from "magic-string";
import MagicString from "magic-string";
import { parseAst } from "rolldown/parseAst";
import * as Options from "../options.ts";
import * as Ast from "./ast.ts";
import * as Block from "./block.ts";
import * as Codegen from "./codegen.ts";
import type { Warning } from "./errors.ts";
import { MutError, PromoteToAlias } from "./errors.ts";

export interface TransformResult {
  code: string;
  map: SourceMap;
  warnings: Warning[];
}

/**
 * Cheap check before parsing: could the code contain a `mut:` label? (Also the
 * plugin's hook filter.)
 */
export const MAY_CONTAIN_MUT_BLOCK = /\bmut\s*:/;

/**
 * Compiles the `mut:` blocks in `code` (module `id`), or returns null if there
 * is nothing to compile.
 */
export function transform(
  code: string,
  id: string,
  input: Options.Input = {},
): TransformResult | null {
  if (!MAY_CONTAIN_MUT_BLOCK.test(code)) {
    return null;
  }
  const options = Options.resolve(input);
  const ast = parseAst(
    code,
    { lang: languageOf(id), preserveParens: true },
    id,
  );
  const magic = new MagicString(code);
  const warnings: Warning[] = [];

  let changed = false;
  for (const { label, enclosing } of mutBlocks(ast)) {
    const output = compileBlock(code, label, enclosing, options);
    if (!output) {
      continue;
    }
    for (const edit of output.edits) {
      applyEdit(magic, edit);
    }
    wrapBlock(magic, label, output, options.freeze);
    warnings.push(...output.warnings);
    changed = true;
  }
  if (!changed) {
    return null;
  }

  magic.prepend(Codegen.runtimeImport(options.runtime));
  return {
    code: magic.toString(),
    map: magic.generateMap({ hires: true, source: id, includeContent: true }),
    warnings,
  };
}

// Only the outermost `mut:` statements: nested ones are compiled as part of
// their outer block.
function* mutBlocks(
  node: Ast.Node,
  ancestors: Ast.Node[] = [],
): Generator<{ label: Ast.Node; enclosing: Ast.Node[] }> {
  if (node.type === "LabeledStatement" && node.label.name === "mut") {
    yield { label: node, enclosing: [...ancestors] };
    return;
  }
  ancestors.push(node);
  for (const child of Ast.children(node)) {
    yield* mutBlocks(child, ancestors);
  }
  ancestors.pop();
}

// Each pass may find a local that is written through; it is then promoted to an
// alias and the block is analysed again, until a pass completes.
function compileBlock(
  code: string,
  label: Ast.Node,
  enclosing: Ast.Node[],
  options: Options.Resolved,
): Block.Output | null {
  const promoted = new WeakSet<Ast.Node>();
  for (;;) {
    try {
      const input = { code, options, enclosing, promoted };
      let output = Block.analyse(label, { ...input, inline: options.inline });

      // Restoring sharing only knows the helpers' copies, so blocks that lend
      // state use helpers throughout.
      if (output.lentRoots.size && options.inline) {
        output = Block.analyse(label, { ...input, inline: false });
      }
      return output.edits.length ? output : null;
    } catch (error) {
      if (!(error instanceof PromoteToAlias)) {
        throw error;
      }
      const { binding } = error;
      if (promoted.has(binding)) {
        throw new MutError(
          `can't track writes through \`${binding.name}\``,
          binding.start,
        );
      }
      promoted.add(binding);
    }
  }
}

function replaceRange(
  magic: MagicString,
  start: number,
  end: number,
  text: string,
): void {
  if (start < end) {
    magic.overwrite(start, end, text, { contentOnly: true });
  } else if (text) {
    magic.appendLeft(start, text);
  }
}

// Node parts are kept in place rather than copied, so their own edits and
// sourcemap survive.
function applyEdit(
  magic: MagicString,
  { start, end, parts }: Codegen.Edit,
): void {
  let position = start;
  let text = "";
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    replaceRange(magic, position, part.start, text);
    text = "";
    position = part.end;
  }
  replaceRange(magic, position, end, text);
}

// The label is only kept when `break mut` needs it.
function wrapBlock(
  magic: MagicString,
  label: Ast.Node,
  output: Block.Output,
  freeze: boolean,
): void {
  const { open, close } = Codegen.blockWrapper({
    usesContext: output.usesContext,
    copyVariables: [...output.copyVariables.values()],
    lentRoots: [...output.lentRoots],
    frozenRoots: freeze ? [...output.writtenRoots] : [],
  });
  const body = label.body;
  if (!output.breaksOut) {
    magic.remove(label.start, body.start);
  }
  if (body.type === "BlockStatement") {
    magic.appendLeft(body.start + 1, ` ${open}`);
    magic.appendLeft(body.end - 1, `${close} `);
  } else {
    magic.prependRight(body.start, `{ ${open} `);
    magic.appendLeft(body.end, `${close} }`);
  }
}

function languageOf(id: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = /\.([cm]?[jt]sx?)(?:$|\?)/.exec(id)?.[1] ?? "js";
  if (extension.endsWith("tsx")) {
    return "tsx";
  }
  if (extension.endsWith("jsx")) {
    return "jsx";
  }
  return extension.includes("t") ? "ts" : "js";
}

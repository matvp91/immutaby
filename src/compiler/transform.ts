/**
 * Compiles the `mut: { ... }` blocks of a module into copy-on-write updates.
 *
 * Each block is analysed (possibly several times, as locals written through
 * are promoted to aliases), and the resulting edits are applied with
 * MagicString so untouched code and sourcemaps stay intact.
 */
import MagicString, { type SourceMap } from "magic-string";
import { parseAst } from "rolldown/parseAst";
import { resolveOptions, type Options, type ResolvedOptions } from "../options.ts";
import { childNodes, type AstNode } from "./ast.ts";
import { analyseBlock } from "./block/analyse.ts";
import type { BlockOutput } from "./block/context.ts";
import { blockWrapperCode, runtimeImportCode } from "./codegen.ts";
import { applyEdit } from "./edits.ts";
import { MutError, PromoteToAlias, type Warning } from "./errors.ts";

export interface TransformResult {
  code: string;
  map: SourceMap;
  warnings: Warning[];
}

const MAY_CONTAIN_MUT_BLOCK = /\bmut\s*:/;

/** Compiles the `mut:` blocks in `code` (module `id`), or returns null if there is nothing to compile. */
export function transform(code: string, id: string, options: Options = {}): TransformResult | null {
  if (!MAY_CONTAIN_MUT_BLOCK.test(code)) return null;
  const resolved = resolveOptions(options);
  const ast = parseAst(code, { lang: languageOf(id), preserveParens: true }, id);
  const magic = new MagicString(code);
  const warnings: Warning[] = [];

  let changed = false;
  for (const { label, enclosing } of mutBlocks(ast)) {
    const output = compileBlock(code, label, enclosing, resolved);
    if (!output) continue;
    for (const edit of output.edits) applyEdit(magic, edit);
    wrapBlock(magic, label, output, resolved.freeze);
    warnings.push(...output.warnings);
    changed = true;
  }
  if (!changed) return null;

  magic.prepend(runtimeImportCode(resolved.runtime));
  return { code: magic.toString(), map: magic.generateMap({ hires: true, source: id, includeContent: true }), warnings };
}

/** The outermost `mut:` statements, each with its ancestors (where roots are declared). */
function* mutBlocks(node: AstNode, ancestors: AstNode[] = []): Generator<{ label: AstNode; enclosing: AstNode[] }> {
  if (node.type === "LabeledStatement" && node.label.name === "mut") {
    yield { label: node, enclosing: [...ancestors] };
    return;
  }
  ancestors.push(node);
  for (const child of childNodes(node)) yield* mutBlocks(child, ancestors);
  ancestors.pop();
}

/**
 * Analyses a block until no more locals need promoting to aliases. Returns
 * null when the block doesn't write state.
 */
function compileBlock(code: string, label: AstNode, enclosing: AstNode[], options: ResolvedOptions): BlockOutput | null {
  const promoted = new WeakSet<AstNode>();
  for (;;) {
    try {
      const input = { code, options, enclosing, promoted };
      let output = analyseBlock(label, { ...input, inline: options.inline });
      // Restoring sharing only knows the helpers' copies, so blocks that lend state use helpers throughout.
      if (output.lentRoots.size && options.inline) output = analyseBlock(label, { ...input, inline: false });
      return output.edits.length ? output : null;
    } catch (error) {
      if (!(error instanceof PromoteToAlias)) throw error;
      const { binding } = error;
      if (promoted.has(binding)) throw new MutError(`can't track writes through \`${binding.name}\``, binding.start);
      promoted.add(binding);
    }
  }
}

/** Opens and closes the block's body with its setup and end-of-block code; drops the label unless `break mut` needs it. */
function wrapBlock(magic: MagicString, label: AstNode, output: BlockOutput, freeze: boolean): void {
  const { open, close } = blockWrapperCode({
    usesContext: output.usesContext,
    copyVariables: [...output.copyVariables.values()],
    lentRoots: [...output.lentRoots],
    frozenRoots: freeze ? [...output.writtenRoots] : [],
  });
  const body = label.body;
  if (!output.breaksOut) magic.remove(label.start, body.start);
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
  if (extension.endsWith("tsx")) return "tsx";
  if (extension.endsWith("jsx")) return "jsx";
  return extension.includes("t") ? "ts" : "js";
}

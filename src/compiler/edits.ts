import type MagicString from "magic-string";
import type { Part } from "./codegen.ts";

/** Replace source range [start, end) with `parts`; node parts keep their source (and its own edits) in place. */
export interface Edit {
  start: number;
  end: number;
  parts: Part[];
}

function replaceRange(magic: MagicString, start: number, end: number, text: string): void {
  if (start < end) magic.overwrite(start, end, text, { contentOnly: true });
  else if (text) magic.appendLeft(start, text);
}

export function applyEdit(magic: MagicString, { start, end, parts }: Edit): void {
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

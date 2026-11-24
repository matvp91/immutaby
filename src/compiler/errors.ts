import type * as Ast from "./ast.ts";

export interface Warning {
  message: string;

  /**
   * Offset in the source.
   */
  pos: number;
}

/**
 * A build error at `pos` in the source.
 */
export class MutError extends Error {
  readonly pos: number;

  constructor(message: string, pos: number) {
    super(`mut: ${message}`);
    this.pos = pos;
  }
}

/**
 * Thrown during analysis when a local that may point into state turns out to
 * be written through. The block is then analysed again with that local
 * compiled as an alias.
 */
export class PromoteToAlias {
  readonly binding: Ast.Node;

  constructor(binding: Ast.Node) {
    this.binding = binding;
  }
}

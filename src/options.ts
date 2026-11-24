export interface Options {
  /** Module the generated code imports helpers from (default "immutaby/runtime"). */
  runtime?: string;
  /**
   * What to do at calls that may change state the compiler can't see into
   * (e.g. `rename(s.user)`). They work by deep-copying the argument, so by
   * default each one is reported.
   */
  opaqueCalls?: "warn" | "error" | "allow";
  /** Functions known not to change their arguments, e.g. `["format", "log.debug"]`. */
  readonlyCalls?: string[];
  /**
   * Deep-freeze state written in a block when it ends, so mutation outside
   * `mut:` throws. "dev" (the default) freezes unless `NODE_ENV` is
   * "production" at build time.
   */
  freeze?: "dev" | "always" | "never";
  /**
   * Compile statement-level writes to plain paths into inline copies instead
   * of helper calls (default true). Turned off to test the helper path alone.
   */
  inline?: boolean;
}

export interface ResolvedOptions {
  runtime: string;
  opaqueCalls: "warn" | "error" | "allow";
  readonlyCalls: readonly string[];
  freeze: boolean;
  inline: boolean;
}

export function resolveOptions(options: Options = {}, nodeEnv = process.env.NODE_ENV): ResolvedOptions {
  const freeze = options.freeze ?? "dev";
  return {
    runtime: options.runtime ?? "immutaby/runtime",
    opaqueCalls: options.opaqueCalls ?? "warn",
    readonlyCalls: options.readonlyCalls ?? [],
    freeze: freeze === "always" || (freeze === "dev" && nodeEnv !== "production"),
    inline: options.inline ?? true,
  };
}

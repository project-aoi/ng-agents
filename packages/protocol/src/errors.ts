export type NgErrorCode =
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "duplicate"
  | "stale_epoch"
  | "bounds_violation"
  | "tx_misuse"
  | "schema"
  | "unsupported";

/** Error carrying a stable machine-readable code; use it for contract-level failures that callers branch on. */
export class NgError extends Error {
  readonly code: NgErrorCode;
  readonly details?: unknown;

  constructor(code: NgErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "NgError";
    this.code = code;
    this.details = details;
  }
}

export function isNgError(e: unknown, code?: NgErrorCode): e is NgError {
  return e instanceof NgError && (code === undefined || e.code === code);
}

/** Strip ANSI escape sequences (CSI / OSC / single-char ESC) so terminal error output stays readable on cards and logs. */
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

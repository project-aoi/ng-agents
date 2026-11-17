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

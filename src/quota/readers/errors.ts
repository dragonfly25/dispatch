/** Typed failures of the quota readers; the quota core records their messages in reader health. */

/** Base class of reader failures. */
export class QuotaReaderError extends Error {
  override readonly name: string = "QuotaReaderError";
  constructor(
    readonly readerId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The channel answered, but not in the shape this reader version understands. */
export class QuotaFormatError extends QuotaReaderError {
  override readonly name = "QuotaFormatError";
  constructor(readerId: string, detail: string, options?: { cause?: unknown }) {
    super(readerId, `format changed (${readerId}): ${detail}`, options);
  }
}

/** The provider CLI is not logged in (or its login expired). */
export class QuotaAuthError extends QuotaReaderError {
  override readonly name = "QuotaAuthError";
  constructor(readerId: string, detail: string) {
    super(readerId, `not authenticated (${readerId}): ${detail}`);
  }
}

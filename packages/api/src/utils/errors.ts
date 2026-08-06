// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    // Optional structured payload included verbatim in the error
    // response body. Lets callers attach machine-readable context
    // (e.g., tag-usage counts on a 409) without stringifying into
    // the message. Serialized as `error.details` by the error handler.
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code?: string) {
    return new AppError(400, message, code);
  }

  static unauthorized(message: string = 'Unauthorized', code: string = 'UNAUTHORIZED') {
    return new AppError(401, message, code);
  }

  static forbidden(message: string = 'Forbidden', code: string = 'FORBIDDEN') {
    return new AppError(403, message, code);
  }

  static notFound(message: string = 'Not found') {
    return new AppError(404, message, 'NOT_FOUND');
  }

  static tooManyRequests(message: string = 'Too many requests') {
    return new AppError(429, message, 'TOO_MANY_REQUESTS');
  }

  static conflict(message: string, code?: string, details?: Record<string, unknown>) {
    return new AppError(409, message, code, details);
  }

  // 423 Locked — a closed accounting period (or similar resource lock)
  // rejects the mutation. Client-portal callers get this hard; firm
  // callers can retry with `overrideConfirmed: true` (ADR-TB-04).
  static locked(message: string, code: string = 'TB_PERIOD_LOCKED', details?: Record<string, unknown>) {
    return new AppError(423, message, code, details);
  }

  static unprocessableEntity(message: string, code?: string, details?: Record<string, unknown>) {
    return new AppError(422, message, code, details);
  }

  static internal(message: string = 'Internal server error') {
    return new AppError(500, message, 'INTERNAL_ERROR');
  }
}

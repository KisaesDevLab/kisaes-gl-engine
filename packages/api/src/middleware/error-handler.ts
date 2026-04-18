// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

// Body-parser throws a custom error with `.type === 'entity.too.large'`
// when a request exceeds express.json()'s `limit`. Without this case
// the handler fell through to the generic 500, so clients couldn't
// distinguish a misbehaving server from an oversize request.
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
      },
    });
    return;
  }

  const bpErr = err as BodyParserError;
  if (bpErr.type === 'entity.too.large') {
    res.status(413).json({
      error: { message: 'Request body exceeds the size limit.', code: 'PAYLOAD_TOO_LARGE' },
    });
    return;
  }
  if (bpErr.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { message: 'Request body could not be parsed as JSON.', code: 'INVALID_JSON' },
    });
    return;
  }

  if (err instanceof ZodError) {
    // Surface the first field-level error so the client can show something
    // useful instead of a generic "Validation error". The full list of
    // issues is still available under `details`.
    const first = err.errors[0];
    const fieldPath = first?.path?.length ? first.path.join('.') : null;
    const message = first
      ? (fieldPath ? `${fieldPath}: ${first.message}` : first.message)
      : 'Validation error';
    res.status(400).json({
      error: {
        message,
        code: 'VALIDATION_ERROR',
        details: err.errors,
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
  });
}

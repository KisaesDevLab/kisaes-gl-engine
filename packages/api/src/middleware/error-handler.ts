import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

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

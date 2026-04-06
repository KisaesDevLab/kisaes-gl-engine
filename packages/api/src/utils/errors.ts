export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code?: string) {
    return new AppError(400, message, code);
  }

  static unauthorized(message: string = 'Unauthorized') {
    return new AppError(401, message, 'UNAUTHORIZED');
  }

  static forbidden(message: string = 'Forbidden') {
    return new AppError(403, message, 'FORBIDDEN');
  }

  static notFound(message: string = 'Not found') {
    return new AppError(404, message, 'NOT_FOUND');
  }

  static tooManyRequests(message: string = 'Too many requests') {
    return new AppError(429, message, 'TOO_MANY_REQUESTS');
  }

  static conflict(message: string, code?: string) {
    return new AppError(409, message, code);
  }

  static internal(message: string = 'Internal server error') {
    return new AppError(500, message, 'INTERNAL_ERROR');
  }
}

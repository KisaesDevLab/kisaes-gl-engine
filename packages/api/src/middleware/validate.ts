// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { attachOpenApiMeta } from './describe.js';

export function validate(schema: ZodSchema) {
  // The attached metadata is read only by the OpenAPI export; request
  // handling is unchanged.
  return attachOpenApiMeta(
    (req: Request, _res: Response, next: NextFunction) => {
      req.body = schema.parse(req.body);
      next();
    },
    { body: schema },
  );
}

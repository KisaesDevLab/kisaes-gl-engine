// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';

// entities router — mounted by tax-estimator.routes.ts AFTER its guard chain (flag, resource, firm scope).
export const entitiesRouter = Router();

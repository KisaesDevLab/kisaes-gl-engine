// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bundled OFL font files for the financial-statement live preview. Public
// (no auth): the preview renders in a sandboxed iframe whose CSS font
// requests can't carry the bearer token, and the files are freely
// licensed. Only catalog files are served.

import { Router } from 'express';
import { FS_FONT_FILES } from '@kis-books/shared';
import { fsFontBytes } from '../services/tb/fs/fs-fonts.js';

export const fsFontsPublicRouter = Router();

fsFontsPublicRouter.get('/:file', (req, res) => {
  const file = String(req.params['file']);
  if (!FS_FONT_FILES.has(file)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'font/ttf');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(fsFontBytes(file));
});

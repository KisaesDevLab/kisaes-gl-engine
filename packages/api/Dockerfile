FROM node:20-alpine

WORKDIR /app

# This Dockerfile builds a single image used by both the `api` and `worker`
# services. The image therefore needs the shared, api, AND worker workspaces
# installed. Each service overrides the CMD in docker-compose.yml to pick
# which entry point to run.

# Chromium for Puppeteer (PDF generation: invoices, checks, reports).
# Puppeteer's bundled Chromium is built for glibc and won't run on alpine
# (musl libc). Install Chromium from apk and tell Puppeteer to use it
# instead of downloading its own. The font packages are required for
# Chromium to render text — without them PDFs render as empty boxes.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy root workspace files
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
COPY packages/worker/package.json ./packages/worker/

# Install dependencies for all three workspaces. PUPPETEER_SKIP_DOWNLOAD
# (set above) prevents npm install from pulling the broken-on-alpine
# bundled Chromium.
RUN npm install \
    --workspace=@kis-books/shared \
    --workspace=@kis-books/api \
    --workspace=@kis-books/worker

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/api/ ./packages/api/
COPY packages/worker/ ./packages/worker/

# Build shared package
RUN npm run build --workspace=@kis-books/shared

EXPOSE 3001

CMD ["npx", "tsx", "packages/api/src/bootstrap.ts"]

FROM node:20-alpine

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/

# Install dependencies
RUN npm install --workspace=@kis-books/shared --workspace=@kis-books/api

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/api/ ./packages/api/

# Build shared package
RUN npm run build --workspace=@kis-books/shared

EXPOSE 3001

CMD ["npx", "tsx", "packages/api/src/index.ts"]

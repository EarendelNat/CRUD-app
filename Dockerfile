# Deploys as-is to Railway, Render, Fly.io or any Docker host.
FROM node:24-alpine

WORKDIR /app

# Install deps first so this layer is cached between code changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The SQLite file lives here. Mount a persistent volume at /app/data or the
# database is wiped on every redeploy.
ENV DB_PATH=/app/data/app.db
ENV NODE_ENV=production
ENV PORT=3000
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

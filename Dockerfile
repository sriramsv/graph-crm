FROM node:20-slim

# Prisma's query engine needs OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

# All stateful data (SQLite db, session store, generated secrets) lives here.
# Mount a volume at this path so it survives rebuilds/restarts.
ENV DATA_DIR=/app/data
ENV DATABASE_URL=file:/app/data/crm.db
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]

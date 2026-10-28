# The desk keeper. Node 22 (the Meteora and pons SDKs need >=20), slim base, non-root.
FROM node:22-slim

# some Solana/EVM deps build native modules
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]

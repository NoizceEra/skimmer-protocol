FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Env: PORT (provided by Railway), RPC_URL, PROGRAM_ID, TREASURY
# Helius webhook posts SWAP batches to /webhook/tx. Health: /health.
CMD ["node", "dist/server.js"]

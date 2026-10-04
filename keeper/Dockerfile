FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Env: PORT (provided by Railway), RPC_URL, PROGRAM_ID, TREASURY
# Keeper hot keypair: mount via volume (/app/keys) or secret env. Fund with ~0.5 SOL gas.
# Health: /health.
CMD ["node", "dist/server.js"]

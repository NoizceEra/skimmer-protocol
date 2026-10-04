FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Env: TELEGRAM_BOT_TOKEN, TREASURY, RPC_URL, PROGRAM_ID, PROTOCOL_FEE_BPS
# Persist /app/data (users.json) on a Railway volume.
CMD ["node", "dist/bot.js"]

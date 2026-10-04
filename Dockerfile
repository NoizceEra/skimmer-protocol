# Skim v1 single-process (bot + webhook listener + keeper). Build from repo root.
FROM node:22-slim
WORKDIR /srv
COPY programs ./programs
COPY sdk ./sdk
COPY keeper ./keeper
COPY listener ./listener
COPY bots/telegram ./bots/telegram
COPY app ./app
RUN for p in sdk keeper listener bots/telegram app; do \
      npm --prefix $p ci --no-audit --no-fund && npm --prefix $p run build || exit 1; done
ENV USER_STORE_PATH=/data/users.json KEEPER_STATE_DIR=/data/v1-state
# Railway injects PORT; the app reads WEBHOOK_PORT.
CMD ["sh", "-c", "umask 077; printf %s \"$KEEPER_KEYPAIR_JSON\" > /tmp/keeper.json; export KEEPER_KEYPAIR=/tmp/keeper.json; WEBHOOK_PORT=${PORT:-4000} exec node app/dist/index.js"]

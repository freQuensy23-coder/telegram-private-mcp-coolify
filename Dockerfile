FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production \
    PORT=3000 \
    TGCLI_STORE=/data \
    TGCLI_HOST=127.0.0.1 \
    TGCLI_PORT=8080

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]

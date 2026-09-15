FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node src ./src
COPY --chown=node:node server.js ./server.js
USER node

EXPOSE 8788
CMD ["node", "server.js"]

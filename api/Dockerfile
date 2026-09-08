FROM node:22-alpine

WORKDIR /srv/api
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY api ./
COPY odh-map/layers/sao_boundary_wgs84.geojson /srv/odh-map/layers/sao_boundary_wgs84.geojson

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.js"]

FROM node:22-alpine

WORKDIR /srv/notify
COPY notify ./

ENV NODE_ENV=production
EXPOSE 8790
CMD ["node", "src/server.js"]

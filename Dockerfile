FROM node:22-alpine AS build

WORKDIR /app

COPY app/package*.json ./
RUN npm install

COPY app/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3030
ENV DATA_DIR=/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3030

CMD ["npm", "run", "start"]

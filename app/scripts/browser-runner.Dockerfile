# Node major matches the production image; Debian supports Playwright browsers.
FROM node:22-bookworm
WORKDIR /workspace
COPY app/package*.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --include=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY app/ ./
RUN npm run build
ENV NODE_ENV=test
USER node

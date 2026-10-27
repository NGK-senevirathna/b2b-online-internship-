FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY controllers ./controllers
COPY frontend ./frontend
COPY middleware ./middleware
COPY migrations ./migrations
COPY models ./models
COPY routes ./routes
COPY scripts ./scripts
COPY services ./services
COPY utils ./utils
COPY server.js ./

USER node
EXPOSE 5000

CMD ["npm", "start"]

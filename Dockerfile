FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 MOONGLE_DATA_DIR=/var/data/moongle
COPY lib ./lib
COPY deploy ./deploy
COPY server.js index.html app.js style.css login.html login.js ./
RUN mkdir -p /var/data/moongle && chown -R node:node /var/data /app
EXPOSE 10000
CMD ["node", "deploy/start.js"]

FROM node:20-alpine
RUN apk add --no-cache ffmpeg git
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npm install -g pm2
COPY . .
CMD ["pm2-runtime", "ecosystem.config.js"]
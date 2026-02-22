FROM node:18-alpine

# Install OS dependencies required by Baileys/Canvas/FFMPEG
RUN apk add --no-cache ffmpeg git

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npm install -g pm2

COPY . .

RUN npx prisma generate

CMD ["pm2-runtime", "ecosystem.config.js"]
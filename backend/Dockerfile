FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install

COPY . .

EXPOSE 3000

# Para que el backend no se apague, necesitamos que el código tenga un server o un loop
CMD ["node", "index.js"]
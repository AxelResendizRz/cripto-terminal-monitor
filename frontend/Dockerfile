FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

# Copiamos solo los archivos de dependencias primero
COPY package.json pnpm-lock.yaml ./

# Instalamos dependencias forzando que no use enlaces simbólicos (shamefully-hoist)
# Esto crea un node_modules tradicional que Docker entiende mejor
RUN pnpm install --shamefully-hoist

# Copiamos el resto del código
COPY . .

EXPOSE 4321

# Usamos directamente la ruta del binario para evitar fallos de resolución
CMD ["./node_modules/.bin/astro", "dev", "--host"]
FROM node:22-alpine
WORKDIR /app
COPY . .
CMD ["node", "bin/astack.mjs", "doctor"]

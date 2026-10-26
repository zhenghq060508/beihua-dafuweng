FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8899
CMD ["npm", "start"]

## Cypress Testing for https://github.com/wavelog/wavelog

# Requirements:

- Node.js
- npm
- git
- Docker
- Docker Compose

# Dependencies:
```bash
sudo apt update
sudo apt install -y libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libcups2 libnss3 xvfb
```

# Prepare:
```bash
curl -L https://github.com/wavelog/wavelog/archive/refs/heads/dev.tar.gz | tar xz --strip-components=1
docker compose -f cypress_testserver.yml up -d
npm install
```

# Run:
```bash
npx cypress run
```

# Run with GUI
```bash
npx cypress open
```

# Destroy after test
```bash
docker compose -f cypress_testserver.yml down
```

## Cypress Testing for https://github.com/wavelog/wavelog

This pipeline gets triggered by a webhook

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
# Set manually a random Pipeline ID
export CI_PIPELINE_ID=26328
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
curl -L https://github.com/wavelog/wavelog/archive/refs/heads/dev.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}
docker compose -f cypress_testserver.yml build
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
rm -rf /tmp/wavelog-${CI_PIPELINE_ID}
docker image rm wavelog-web:${CI_PIPELINE_ID}
```

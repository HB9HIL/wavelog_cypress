## Cypress Testing for https://github.com/wavelog/wavelog

This pipeline runs isolated tests using Docker containers.

# Requirements:

- Node.js
- npm
- git
- Docker

# Dependencies on linux
```bash
sudo apt update
sudo apt install -y libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libcups2 libnss3 xvfb
```

# Use the run_once.sh script:
```bash
chmod +x run_once.sh
# Default run: Dockerfile untouched, MariaDB 11.8
./run_once.sh
```

The script is parametrizable via environment variables, so you can run
individual DB / PHP combinations from the CI matrix manually:

| Variable   | Default          | Description                                             |
|------------|------------------|---------------------------------------------------------|
| `DATABASE` | `mariadb:11.8`   | DB image to test against (e.g. `mysql:8.4`, `mariadb:11.4`) |
| `PHP`      | *(empty)*        | PHP version to pin (e.g. `8.3`); empty keeps the Dockerfile's default |
| `REPO`     | `wavelog/wavelog`| Wavelog repo to pull                                    |
| `BRANCH`   | `dev`            | Wavelog branch to pull                                  |

```bash
# MySQL 8.4 with PHP 8.3
DATABASE=mysql:8.4 PHP=8.3 ./run_once.sh

# MariaDB 11.4, PHP left at the Dockerfile default
DATABASE=mariadb:11.4 ./run_once.sh
```

# If you want to run the tests manually, you can do so by following these steps:
## Prepare:
```bash
# Set manually a random Pipeline ID
export CI_PIPELINE_ID=$((RANDOM + 10000))
echo "Using Pipeline ID: $CI_PIPELINE_ID"

# Download and extract Wavelog
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
curl -L https://github.com/wavelog/wavelog/archive/refs/heads/dev.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}

# Create Docker network
docker network create wavelog_testnet_${CI_PIPELINE_ID}

# Start database container
docker run -d \
  --name wavelog-db-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  --network-alias wavelog-db \
  -e MARIADB_RANDOM_ROOT_PASSWORD=yes \
  -e MARIADB_DATABASE=wavelog \
  -e MARIADB_USER=wavelog \
  -e MARIADB_PASSWORD=wavelog \
  mariadb:11.8

# Build and start web container
docker build -t wavelog-web:${CI_PIPELINE_ID} /tmp/wavelog-${CI_PIPELINE_ID}
docker run -d \
  --name wavelog-web-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  -p $((8000 + (${CI_PIPELINE_ID} % 1000))):80 \
  wavelog-web:${CI_PIPELINE_ID}

# Install npm dependencies
npm install

# Show the final port
echo "Wavelog is running on: http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
```

## Run:
```bash
# Set the correct base URL for Cypress
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
npx cypress run
```

## Run with GUI:
```bash
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
npx cypress open
```

## Destroy after test:
```bash
# Stop and remove containers
docker stop wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID}
docker rm wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID}

# Remove image and network
docker rmi wavelog-web:${CI_PIPELINE_ID}
docker network rm wavelog_testnet_${CI_PIPELINE_ID}

# Clean up temp files
rm -rf /tmp/wavelog-${CI_PIPELINE_ID}
```

#!/bin/bash

# Set manually a random Pipeline ID
export CI_PIPELINE_ID=$((RANDOM + 10000))
echo "Using Pipeline ID: $CI_PIPELINE_ID"

############################
REPO="wavelog/wavelog"
BRANCH="dev"
DATABASE="mariadb:11.8"
############################

# Download and extract Wavelog
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
curl -L https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}

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
  ${DATABASE}

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

# Set the correct base URL for Cypress
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
npx cypress run

# Stop and remove containers
docker stop wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID}
docker rm wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID}

# Remove image and network
docker rmi wavelog-web:${CI_PIPELINE_ID}
docker network rm wavelog_testnet_${CI_PIPELINE_ID}

# Clean up temp files
rm -rf /tmp/wavelog-${CI_PIPELINE_ID}
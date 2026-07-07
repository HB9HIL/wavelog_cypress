#!/bin/bash

# Set manually a random Pipeline ID
export CI_PIPELINE_ID=$((RANDOM + 10000))
echo "Using Pipeline ID: $CI_PIPELINE_ID"

############################
# Configurable via environment variables; defaults give a plain MariaDB 11.8 run.
#   DATABASE  DB image to test against (e.g. mysql:8.4, mariadb:11.4)
#   PHP       PHP version to pin (e.g. 8.3); empty keeps the Dockerfile's default
#   REPO      Wavelog repo to pull
#   BRANCH    Wavelog branch to pull
# Example: DATABASE=mysql:8.4 PHP=8.3 ./run_once.sh
############################
REPO="${REPO:-wavelog/wavelog}"
BRANCH="${BRANCH:-dev}"
DATABASE="${DATABASE:-mariadb:11.8}"
PHP="${PHP:-}"
############################

# Download and extract Wavelog
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
curl -L https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}

# Optionally pin a PHP version by patching the downloaded Dockerfile.
# Empty PHP (default) leaves the Dockerfile untouched.
if [ -n "$PHP" ]; then
  echo "Pinning PHP ${PHP}"
  sed -i "s|^FROM php:.*|FROM php:${PHP}-apache|" /tmp/wavelog-${CI_PIPELINE_ID}/Dockerfile
fi

# Enable MQTT in the image so the MQTT e2e test has something to assert on.
# The installer copies install/config/config.php into the docker config dir, so
# appending the keys here bakes mqtt_server=mqtt-broker into the built image.
cat >> /tmp/wavelog-${CI_PIPELINE_ID}/install/config/config.php <<'EOF'
$config['mqtt_server'] = 'mqtt-broker';
$config['mqtt_port'] = 1883;
$config['mqtt_prefix'] = 'wavelog/';
EOF

# Create Docker network
docker network create wavelog_testnet_${CI_PIPELINE_ID}

# Start the MQTT broker on the same network (alias mqtt-broker for the web
# container) and publish a host port so the Cypress node process can subscribe.
MQTT_PORT=$((9000 + (${CI_PIPELINE_ID} % 1000)))
docker run -d \
  --name wavelog-mqtt-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  --network-alias mqtt-broker \
  -p ${MQTT_PORT}:1883 \
  -v "$(pwd)/docker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  eclipse-mosquitto:2
export MQTT_BROKER_URL="mqtt://localhost:${MQTT_PORT}"

if [[ $DATABASE == mariadb* ]]; then
  echo "Using MariaDB database"
  DB_CMD="MARIADB"
elif [[ $DATABASE == mysql* ]]; then
  echo "Using MySQL database"
  DB_CMD="MYSQL"
else
  echo "Unsupported database: $DATABASE"
  exit 1
fi

# Start database container
docker run -d \
  --name wavelog-db-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  --network-alias wavelog-db \
  -e ${DB_CMD}_RANDOM_ROOT_PASSWORD=yes \
  -e ${DB_CMD}_DATABASE=wavelog \
  -e ${DB_CMD}_USER=wavelog \
  -e ${DB_CMD}_PASSWORD=wavelog \
  ${DATABASE}

# Build and start web container
docker build -t wavelog-web:${CI_PIPELINE_ID} /tmp/wavelog-${CI_PIPELINE_ID}
docker run -d \
  --name wavelog-web-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  -p $((8000 + (${CI_PIPELINE_ID} % 1000))):80 \
  wavelog-web:${CI_PIPELINE_ID}

# Install npm dependencies
npm ci

# Show the final port
echo "Wavelog is running on: http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"

# Set the correct base URL for Cypress
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
npx cypress run --browser chromium

# Stop and remove containers
docker stop wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}
docker rm wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}

# Remove image and network
docker rmi wavelog-web:${CI_PIPELINE_ID}
docker network rm wavelog_testnet_${CI_PIPELINE_ID}

# Clean up temp files
rm -rf /tmp/wavelog-${CI_PIPELINE_ID}

#!/bin/bash

# Set manually a random Pipeline ID
export CI_PIPELINE_ID=$((RANDOM + 10000))
echo "Using Pipeline ID: $CI_PIPELINE_ID"

############################
# Configurable via environment variables; defaults give a plain MariaDB 11.8 run.
#   DATABASE  DB image to test against (e.g. mysql:8.4, mariadb:11.4)
#   PHP       PHP version to pin (e.g. 8.3); empty keeps the Dockerfile's default
#   BROWSER   Cypress browser to run (chromium, chrome, edge, electron); firefox unsupported
#   REPO      Wavelog repo to pull (ignored when SOURCE is set)
#   BRANCH    Wavelog branch to pull (ignored when SOURCE is set)
#   SOURCE    Path to a local Wavelog checkout to test instead of downloading.
#             It is copied into a temp dir, so your working tree is untouched.
#   ONLY      Run a single stage and skip Cypress. One of:
#               phpstan  PHPStan only        (source only, no image build)
#               semgrep  semgrep SQLi scan   (source only, no image build)
#               lint     php -l syntax check (builds the web image)
#               static   all three checks    (no database / Cypress)
#             Unset runs the full pipeline (build + static checks + Cypress).
# Example: DATABASE=mysql:8.4 PHP=8.3 ./run_once.sh
# Example: ONLY=phpstan ./run_once.sh
############################
REPO="${REPO:-wavelog/wavelog}"
BRANCH="${BRANCH:-dev}"
DATABASE="${DATABASE:-mariadb:11.8}"
PHP="${PHP:-}"
BROWSER="${BROWSER:-chromium}"
############################

# Firefox is not supported in this setup.
if [ "$BROWSER" = "firefox" ]; then
  echo "BROWSER=firefox is not supported here. Use chromium, chrome, edge or electron. The browser must be available on your machine."
  exit 1
fi

# Obtain the Wavelog source in a temp dir. Everything below mutates it (PHP pin,
# MQTT config), so with SOURCE we copy the local checkout rather than use it in
# place, keeping your working tree untouched.
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
if [ -n "$SOURCE" ]; then
  if [ ! -d "$SOURCE" ]; then
    echo "SOURCE path does not exist: $SOURCE"; exit 1
  fi
  echo "Using local Wavelog source: $SOURCE"
  cp -a "$SOURCE/." /tmp/wavelog-${CI_PIPELINE_ID}/
else
  curl -L https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}
fi

# Optionally pin a PHP version by patching the downloaded Dockerfile.
# Empty PHP (default) leaves the Dockerfile untouched.
if [ -n "$PHP" ]; then
  echo "Pinning PHP ${PHP}"
  sed -i "s|^FROM php:.*|FROM php:${PHP}-apache|" /tmp/wavelog-${CI_PIPELINE_ID}/Dockerfile
fi

# ---------------------------------------------------------------------------
# Static checks (all dockerized). Each is a function so it can run standalone
# via ONLY=... or as part of the full run. Non-blocking in the full run: they
# print findings and record STATIC_FAIL but do not abort Cypress.
# ---------------------------------------------------------------------------
STATIC_FAIL=0
cleanup_temp() { rm -rf /tmp/wavelog-${CI_PIPELINE_ID}; }

run_phpstan() {
  echo "=== PHPStan (level 0) ==="
  # Pin a current PHPStan (Docker Hub's phpstan/phpstan:latest is stuck on 0.12,
  # which cannot parse PHP 8 syntax). Config lives next to this script.
  docker run --rm \
    -v /tmp/wavelog-${CI_PIPELINE_ID}:/app \
    -v "$(pwd)/phpstan.neon:/phpstan.neon:ro" \
    ghcr.io/phpstan/phpstan:2 \
    analyse -c /phpstan.neon --no-progress --memory-limit=1G \
    || { echo "PHPStan reported issues"; STATIC_FAIL=1; }
}

run_semgrep() {
  echo "=== SQL injection scan (semgrep, PHP ruleset) ==="
  # Path exclusions live here (not in a .semgrepignore inside the Wavelog source):
  #   system/   CodeIgniter 3 framework core (third-party). Also carries a flat
  #             false positive where a log_message() call is flagged as tainted SQL.
  #   install/  one-time, pre-auth installer bootstrap that runs before install/.lock
  #             is set; not part of the running application's attack surface.
  docker run --rm -v /tmp/wavelog-${CI_PIPELINE_ID}:/src semgrep/semgrep \
    semgrep scan --config p/php --error --quiet \
      --exclude=system --exclude=install \
    || { echo "Semgrep reported findings"; STATIC_FAIL=1; }
}

run_lint() {
  echo "=== PHP syntax check (php -l, via built image) ==="
  docker run --rm wavelog-web:${CI_PIPELINE_ID} bash -c \
    'find /var/www/html -name "*.php" -print0 | xargs -0 -n1 -P"$(nproc)" php -d display_errors=stderr -l >/dev/null' \
    && echo "PHP syntax OK" || { echo "PHP lint found errors"; STATIC_FAIL=1; }
}

# Source-only checks need no image, database or Cypress; run and exit.
if [ "$ONLY" = "phpstan" ]; then run_phpstan; cleanup_temp; exit $STATIC_FAIL; fi
if [ "$ONLY" = "semgrep" ]; then run_semgrep; cleanup_temp; exit $STATIC_FAIL; fi

# Enable MQTT in the image so the MQTT e2e test has something to assert on.
# The installer copies install/config/config.php into the docker config dir, so
# appending the keys here bakes mqtt_server=mqtt-broker into the built image.
# special_callsign turns on the Clubstation/Impersonate feature so the
# clubstation e2e test finds its UI (the installer generates a random
# encryption_key, so impersonate is not blocked by the default flossie key).
cat >> /tmp/wavelog-${CI_PIPELINE_ID}/install/config/config.php <<'EOF'
$config['mqtt_server'] = 'mqtt-broker';
$config['mqtt_port'] = 1883;
$config['mqtt_prefix'] = 'wavelog/';
$config['special_callsign'] = true;
EOF

# For a full run, bring up network/MQTT/DB early so the database initializes
# while the image builds and npm installs. Skipped for the static-only modes.
if [ -z "$ONLY" ]; then
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
fi

# Build the web image (needed for php -l and for the full e2e run).
docker build -t wavelog-web:${CI_PIPELINE_ID} /tmp/wavelog-${CI_PIPELINE_ID}

# Image-based static-only modes: run, drop the image and exit before Cypress.
if [ "$ONLY" = "lint" ]; then
  run_lint
  docker rmi wavelog-web:${CI_PIPELINE_ID}
  cleanup_temp
  exit $STATIC_FAIL
fi
if [ "$ONLY" = "static" ]; then
  run_lint
  run_phpstan
  run_semgrep
  docker rmi wavelog-web:${CI_PIPELINE_ID}
  cleanup_temp
  exit $STATIC_FAIL
fi

# ---- Full run: static checks (non-blocking) then Cypress e2e ----
run_lint
run_phpstan
run_semgrep

# Start web container
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
npx cypress run --browser "$BROWSER"
CYPRESS_EXIT=$?

# Stop and remove containers
docker stop wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}
docker rm wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}

# Remove image and network
docker rmi wavelog-web:${CI_PIPELINE_ID}
docker network rm wavelog_testnet_${CI_PIPELINE_ID}

# Clean up temp files
cleanup_temp

# ---- Final Report ----
BOLD="\033[1m"
CYAN="\033[1;36m"
GREEN="\033[1;32m"
RED="\033[1;31m"
YELLOW="\033[1;33m"
RESET="\033[0m"

echo ""
echo -e "${CYAN}======================================================${RESET}"
echo -e "${CYAN}${BOLD}  WAVELOG TEST REPORT${RESET}"
echo -e "${CYAN}======================================================${RESET}"
if [ -n "$SOURCE" ]; then
  echo -e "  Source:    ${YELLOW}local  ->  $SOURCE${RESET}"
else
  echo -e "  Repo:      ${YELLOW}https://github.com/${REPO}  (branch: ${BRANCH})${RESET}"
fi
echo -e "${CYAN}------------------------------------------------------${RESET}"
echo -e "  PHP:       ${YELLOW}${PHP:-default from Dockerfile}${RESET}"
echo -e "  Database:  ${YELLOW}$DATABASE${RESET}"
echo -e "  Browser:   ${YELLOW}$BROWSER${RESET}"
echo -e "${CYAN}------------------------------------------------------${RESET}"
if [ $CYPRESS_EXIT -eq 0 ]; then
  echo -e "  Cypress:   ${GREEN}PASSED${RESET}"
else
  echo -e "  Cypress:   ${RED}FAILED (exit $CYPRESS_EXIT)${RESET}"
fi
if [ $STATIC_FAIL -eq 0 ]; then
  echo -e "  Static:    ${GREEN}OK (phpstan / semgrep / lint)${RESET}"
else
  echo -e "  Static:    ${RED}ISSUES FOUND (see output above)${RESET}"
fi
echo -e "${CYAN}======================================================${RESET}"
echo ""

exit $CYPRESS_EXIT

# Final report


# Report static-check outcome (non-blocking, see above)
if [ "$STATIC_FAIL" = "1" ]; then
  echo "NOTE: one or more static checks (php lint / phpstan / semgrep) reported issues — see output above."
fi

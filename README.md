## Cypress Testing for https://github.com/wavelog/wavelog

This pipeline runs isolated tests using Docker containers.

The MQTT test (`cypress/e2e/8-mqtt.cy.js`) additionally needs a mosquitto broker
on the same docker network (alias `mqtt-broker`) and an image built with
`mqtt_server=mqtt-broker`. `run_once.sh` and both CI pipelines set this up
automatically; for manual runs see the broker step and `MQTT_BROKER_URL` below.

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
| `REPO`     | `wavelog/wavelog`| Wavelog repo to pull (ignored when `SOURCE` is set)     |
| `BRANCH`   | `dev`            | Wavelog branch to pull (ignored when `SOURCE` is set)   |
| `SOURCE`   | *(empty)*        | Path to a local Wavelog checkout to test instead of downloading; copied to a temp dir so your working tree is untouched |
| `ONLY`     | *(empty)*        | Run a single static-check stage and skip Cypress (see below) |

```bash
# MySQL 8.4 with PHP 8.3
DATABASE=mysql:8.4 PHP=8.3 ./run_once.sh

# MariaDB 11.4, PHP left at the Dockerfile default
DATABASE=mariadb:11.4 ./run_once.sh
```

# Static analysis

Alongside the Cypress e2e tests the pipeline runs three dockerized static checks
against the Wavelog source. In a full `./run_once.sh` they run before Cypress and
are **non-blocking** (findings are printed and summarized, but Cypress still runs).
The GitHub Actions workflow runs them as separate jobs.

| Check     | Tool                        | What it catches                                  |
|-----------|-----------------------------|--------------------------------------------------|
| `lint`    | `php -l` (in the web image) | PHP syntax errors, on the exact shipped PHP version |
| `phpstan` | `ghcr.io/phpstan/phpstan:2` | Undefined symbols, wrong arg counts, duplicate array keys, ... |
| `semgrep` | `semgrep/semgrep` (`p/php`) | SQL injection / XSS and other PHP security patterns |

PHPStan is configured via [`phpstan.neon`](phpstan.neon): level 0, `system/` scanned
so CodeIgniter's base classes resolve, and CI3's magic property/method loading
(`$this->db`, `$this->load`, ...) ignored. Raise `level` there as the code gets cleaner.

Use `ONLY` to run one stage in isolation (skips the database, MQTT and Cypress),
which is handy for iterating on fixes:

```bash
ONLY=phpstan ./run_once.sh   # PHPStan only        (source only, no image build)
ONLY=semgrep ./run_once.sh   # semgrep SQLi scan   (source only, no image build)
ONLY=lint    ./run_once.sh   # php -l syntax check (builds the web image)
ONLY=static  ./run_once.sh   # all three checks    (no database / Cypress)

# Check a fix branch of your own fork:
REPO=youruser/wavelog BRANCH=my-fix ONLY=phpstan ./run_once.sh

# Check a local checkout (working tree is copied, not modified):
SOURCE=/path/to/wavelog ONLY=phpstan ./run_once.sh
```

`SOURCE` also works for the full run and every other `ONLY` mode, so you can e2e
a local checkout with `SOURCE=/path/to/wavelog ./run_once.sh`.

The `ONLY` modes exit with the check's status (0 = clean, 1 = findings).

# If you want to run the tests manually, you can do so by following these steps:
## Prepare:
```bash
# Set manually a random Pipeline ID
export CI_PIPELINE_ID=$((RANDOM + 10000))
echo "Using Pipeline ID: $CI_PIPELINE_ID"

# Download and extract Wavelog
mkdir -p /tmp/wavelog-${CI_PIPELINE_ID}
curl -L https://github.com/wavelog/wavelog/archive/refs/heads/dev.tar.gz | tar xz --strip-components=1 -C /tmp/wavelog-${CI_PIPELINE_ID}

# Enable MQTT so the MQTT e2e test (8-mqtt) has something to assert on. The
# installer bakes these keys into the image's config during the install step.
cat >> /tmp/wavelog-${CI_PIPELINE_ID}/install/config/config.php <<'EOF'
$config['mqtt_server'] = 'mqtt-broker';
$config['mqtt_port'] = 1883;
$config['mqtt_prefix'] = 'wavelog/';
$config['special_callsign'] = true;
EOF

# Create Docker network
docker network create wavelog_testnet_${CI_PIPELINE_ID}

# Start the MQTT broker (alias mqtt-broker for the web container, port 1883
# published so the Cypress node process can subscribe)
docker run -d \
  --name wavelog-mqtt-${CI_PIPELINE_ID} \
  --network wavelog_testnet_${CI_PIPELINE_ID} \
  --network-alias mqtt-broker \
  -p 1883:1883 \
  -v "$(pwd)/docker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  eclipse-mosquitto:2

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
npm ci

# Show the final port
echo "Wavelog is running on: http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
```

## Run:
```bash
# Set the correct base URL for Cypress
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
# Point the MQTT test at the broker started above
export MQTT_BROKER_URL="mqtt://localhost:1883"
npx cypress run
```

## Run with GUI:
```bash
export CYPRESS_baseUrl="http://localhost:$((8000 + (${CI_PIPELINE_ID} % 1000)))/"
export MQTT_BROKER_URL="mqtt://localhost:1883"
npx cypress open
```

## Destroy after test:
```bash
# Stop and remove containers
docker stop wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}
docker rm wavelog-web-${CI_PIPELINE_ID} wavelog-db-${CI_PIPELINE_ID} wavelog-mqtt-${CI_PIPELINE_ID}

# Remove image and network
docker rmi wavelog-web:${CI_PIPELINE_ID}
docker network rm wavelog_testnet_${CI_PIPELINE_ID}

# Clean up temp files
rm -rf /tmp/wavelog-${CI_PIPELINE_ID}
```

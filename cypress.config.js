const { defineConfig } = require("cypress");
const fs = require("fs");
const mqtt = require("mqtt");

// MQTT e2e support. Wavelog publishes events server-side to the broker, so we
// need a subscriber running in the Cypress node process (not the browser) that
// buffers the retained-free live messages for the spec to assert on.
//
// The broker URL comes from process.env (NOT Cypress.env(), which is locked
// down via allowCypressEnv:false). The three orchestrators (GitHub Actions,
// GitLab CI, run_once.sh) export MQTT_BROKER_URL pointing at the published
// broker port; locally it defaults to mqtt://localhost:1883.
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";

let mqttClient = null;
let mqttMessages = [];

function ensureMqttClient() {
	if (mqttClient) {
		return Promise.resolve(mqttClient);
	}
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(MQTT_BROKER_URL, {
			connectTimeout: 10000,
			reconnectPeriod: 1000,
		});
		client.on("connect", () => {
			client.subscribe("wavelog/#", (err) => {
				if (err) {
					reject(err);
				} else {
					mqttClient = client;
					resolve(client);
				}
			});
		});
		client.on("message", (topic, payload) => {
			mqttMessages.push({ topic, payload: payload.toString() });
		});
		client.on("error", (err) => {
			if (!mqttClient) {
				reject(err);
			}
		});
	});
}

module.exports = defineConfig({
	projectId: 'Wavelog Cypress Testing',
	// Cypress.env() is deprecated since 15.10; we migrated to Cypress.expose().
	// Locking it down makes accidental Cypress.env() usage throw.
	allowCypressEnv: false,
	// Retry flaky specs automatically. Under CI load the DB/PHP-FPM containers
	// and the browser-side JS libs occasionally need a moment longer than a
	// single attempt allows; retrying the one spec beats re-running the whole
	// pipeline by hand. runMode covers CI (GitHub/GitLab/run_once.sh); openMode
	// stays 0 so `cypress open` fails fast and shows real errors while developing.
	retries: {
		runMode: 3,
		openMode: 0,
	},
	// Default 4s is tight in CI: JS libs, XHRs and DB round-trips run under load.
	// Bumping the implicit assertion/command timeout removes most timing flakes.
	defaultCommandTimeout: 8000,
	e2e: {
		// baseUrl: "http://localhost:8087/",
		// Record video for every spec, then keep it only when the spec failed
		// (see the after:spec hook below). Cypress has no built-in
		// "video on failure" switch, so we delete videos of passing specs.
		video: true,
		viewportWidth: 1920,
		viewportHeight: 1080,
		setupNodeEvents(on, config) {
			require("cypress-localstorage-commands/plugin")(on, config);

			on("task", {
				// Connect (lazily) and clear the buffer so a spec only sees
				// messages published after this point.
				"mqtt:reset": () =>
					ensureMqttClient().then(() => {
						mqttMessages = [];
						return null;
					}),
				// Return everything buffered so far.
				"mqtt:messages": () => ensureMqttClient().then(() => mqttMessages.slice()),
			});

			on("after:spec", (spec, results) => {
				if (results && results.video) {
					const failed = results.tests.some((test) =>
						test.attempts.some((attempt) => attempt.state === "failed")
					);
					if (!failed) {
						fs.unlinkSync(results.video);
					}
				}
			});

			return config;
		},
	},
	reporter: "junit",
	reporterOptions: {
		mochaFile: "results/junit-[hash].xml",
		toConsole: true
	}
});

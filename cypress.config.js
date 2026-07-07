const { defineConfig } = require("cypress");
const fs = require("fs");

module.exports = defineConfig({
	projectId: 'Wavelog Cypress Testing',
	// Cypress.env() is deprecated since 15.10; we migrated to Cypress.expose().
	// Locking it down makes accidental Cypress.env() usage throw.
	allowCypressEnv: false,
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

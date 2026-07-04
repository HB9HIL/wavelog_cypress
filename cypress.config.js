const { defineConfig } = require("cypress");

module.exports = defineConfig({
	projectId: 'Wavelog Cypress Testing',
	// Cypress.env() is deprecated since 15.10; we migrated to Cypress.expose().
	// Locking it down makes accidental Cypress.env() usage throw.
	allowCypressEnv: false,
	e2e: {
		// baseUrl: "http://localhost:8087/",
		video: false,
		viewportWidth: 1920,
		viewportHeight: 1080,
		setupNodeEvents(on, config) {
			require("cypress-localstorage-commands/plugin")(on, config);
			return config;
		},
	},
	reporter: "junit",
	reporterOptions: {
		mochaFile: "results/junit-[hash].xml",
		toConsole: true
	}
});

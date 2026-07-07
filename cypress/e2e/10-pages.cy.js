import 'cypress-real-events/support';

// Cheap, high-coverage smoke tests: every page here is reachable with a plain
// GET as the (admin) user created by the installer, and each one renders the
// shared interface_assets/header partial. That gives us two stable, uniform
// assertions for the whole list:
//
//   * we were NOT bounced to /user/login   -> the session is valid
//   * we were NOT bounced to /dashboard    -> the authorize()/config guard passed
//   * #header-menu exists                   -> the page rendered without a fatal
//
// Any PHP fatal, broken route, or regressed permission check on one of these
// controllers makes the header disappear or triggers a redirect, so a single
// tiny test catches a real breakage per page. Pages that render WITHOUT the
// header (e.g. qrbcalc) or that are gated behind optional config (e.g. dcl)
// are intentionally left out to keep this suite flake-free.
const pages = [
	// Tools & utilities
	{ name: "Notes", url: "notes" },
	{ name: "Search", url: "search" },
	{ name: "Callsign Tester", url: "calltester" },
	{ name: "Zone Checker", url: "zonechecker" },
	{ name: "Bandmap", url: "bandmap/list" },
	{ name: "DX Calendar", url: "dxcalendar" },
	{ name: "Contest Calendar", url: "contestcalendar" },
	{ name: "Satellite", url: "satellite" },
	{ name: "Satellite Timers", url: "sattimers" },
	{ name: "Hamsat", url: "hamsat" },
	{ name: "QSO Map", url: "map/qso_map" },
	// Logging views
	{ name: "Simple Fast Log Entry", url: "simplefle" },
	{ name: "Advanced Logbook", url: "logbookadvanced" },
	// Account & settings
	{ name: "Radio Interfacing", url: "radio" },
	{ name: "Modes", url: "mode" },
	{ name: "Themes", url: "themes" },
	{ name: "Appearance Options", url: "options/appearance" }
];

describe("Page smoke tests", () => {
	before(() => {
		cy.setCookie('language', 'english');
		cy.login();
		cy.getCookies().then(cookies => {
			cy.writeFile('cypress/fixtures/cookies.json', cookies);
		});
	});

	beforeEach(() => {
		cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
			cookies.forEach(cookie => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
	});

	pages.forEach(page => {
		it("Should load the " + page.name + " page", () => {
			cy.visit("/index.php/" + page.url);

			// Not redirected away -> session valid and the page's guard passed.
			cy.url().should("not.include", "/user/login");
			cy.url().should("not.include", "/dashboard");

			// The shared header renders -> no fatal, page came up.
			cy.get("#header-menu", { timeout: 10000 })
				.should("exist");
		});
	});
});

import 'cypress-real-events/support';

// Universal awards that render regardless of the logged DXCC/region.
// Every award view shares the #awardInfoButton element, which we use as
// a stable "page rendered" marker.
const awards = [
	{ name: "DXCC", url: "/awards/dxcc" },
	{ name: "CQ Zones", url: "/awards/cq" },
	{ name: "ITU Zones", url: "/awards/itu" },
	{ name: "WAC", url: "/awards/wac" },
	{ name: "WAE", url: "/awards/wae" },
	{ name: "WPX", url: "/awards/wpx" },
	{ name: "WAS", url: "/awards/was" },
	{ name: "VUCC", url: "/awards/vucc" },
	{ name: "IOTA", url: "/awards/iota" },
	{ name: "POTA", url: "/awards/pota" },
	{ name: "SOTA", url: "/awards/sota" },
	{ name: "WWFF", url: "/awards/wwff" }
];

describe("Awards", () => {
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

	awards.forEach(award => {
		it("Should load the " + award.name + " award page", () => {
			cy.visit("/index.php" + award.url);

			cy.url().should("include", award.url);

			// The award info button is present on every award page
			cy.get("#awardInfoButton", { timeout: 10000 })
				.should("exist");

			// And there is a heading
			cy.get("h2")
				.should("be.visible");
		});
	});
});

import 'cypress-real-events/support';

// The dashboard is the landing page after login and every existing spec only
// ever uses it as a jumping-off point for the menu. These tests assert the
// dashboard itself renders its stat widgets, so a regression in the dashboard
// controller/view (e.g. a missing model call) gets caught directly.
describe("Dashboard", () => {
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

	it("Shows the QSO statistic cards", () => {
		cy.visit("/index.php/dashboard");

		// The top row of stat cards rendered from the logbook model
		cy.get(".card-header").contains("Total QSOs").should("be.visible");
		cy.get(".card-header").contains("QSOs this year").should("be.visible");
		cy.get(".card-header").contains("QSOs this month").should("be.visible");
		cy.get(".card-header").contains("QSOs today").should("be.visible");
	});

	it("Shows the content widgets", () => {
		cy.visit("/index.php/dashboard");

		cy.get(".card-header").contains("Recent QSOs").should("be.visible");
		cy.get(".card-header").contains("DXCCs Breakdown").should("be.visible");
		cy.get(".card-header").contains("Map").should("be.visible");
	});

	it("Renders a numeric Total QSOs value", () => {
		cy.visit("/index.php/dashboard");

		// The card body under "Total QSOs" holds the computed count. It must be
		// a plain integer (0 or more), proving the model query returned a value.
		cy.get(".card-header")
			.contains("Total QSOs")
			.parents(".card")
			.find(".card-body h4")
			.invoke("text")
			.then((txt) => {
				expect(txt.trim()).to.match(/^[\d.,]+$/);
			});
	});
});

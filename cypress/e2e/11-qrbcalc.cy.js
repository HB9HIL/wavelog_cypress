import 'cypress-real-events/support';

// The QRB calculator is NOT a standalone page in normal use: it is a
// BootstrapDialog modal, AJAX-loaded from index.php/qrbcalc and opened with the
// global ALT+Q shortcut (document.onkeyup in interface_assets/footer.php ->
// spawnQrbCalculator() in assets/js/sections/common.js). Driving it through the
// shortcut exercises the whole chain: the keybinding, the AJAX route, the modal
// and the calculate endpoint. calculateQrb() renders distance + bearing into
// .qrbResult inside the dialog.
describe("QRB Calculator (ALT+Q modal)", () => {
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
		// Any page carrying the shared footer registers the ALT+Q handler.
		cy.visit("/index.php/dashboard");
	});

	it("Opens the calculator modal via the ALT+Q shortcut", () => {
		cy.realPress(["Alt", "Q"]);

		// The dialog loads the qrbcalc form fields
		cy.get("#qrbcalc_locator1", { timeout: 10000 }).should("be.visible");
		cy.get("#qrbcalc_locator2").should("be.visible");
		cy.get("#button1id").should("be.visible").contains("Calculate");
	});

	it("Calculates distance and bearing between two locators", () => {
		cy.realPress(["Alt", "Q"]);
		cy.get("#qrbcalc_locator1", { timeout: 10000 }).should("be.visible");

		// The first locator is prefilled with the station locator, so clear it.
		cy.get("#qrbcalc_locator1").clear().type("JN47");
		cy.get("#qrbcalc_locator2").clear().type("JO62");

		cy.get("#button1id").click();

		cy.get(".qrbResult", { timeout: 10000 })
			.should("contain.text", "distance between")
			.and("contain.text", "bearing is");
	});

	it("Shows an error for an invalid locator", () => {
		cy.realPress(["Alt", "Q"]);
		cy.get("#qrbcalc_locator1", { timeout: 10000 }).should("be.visible");

		cy.get("#qrbcalc_locator1").clear().type("JN47");
		cy.get("#qrbcalc_locator2").clear().type("ZZ99");

		cy.get("#button1id").click();

		// validateLocator() fails -> a danger alert is rendered instead of a result
		cy.get(".qrbResult .qrbalert")
			.should("be.visible");
	});
});

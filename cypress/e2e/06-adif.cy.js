import 'cypress-real-events/support';

describe("ADIF Import / Export", () => {
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

	it("Should show the ADIF page", () => {
		cy.visit("/index.php/adif");

		cy.url().should("include", "/adif");
		cy.get("h2")
			.contains("ADIF Import")
			.should("be.visible");
	});

	it("Should show the Import and Export tabs", () => {
		cy.visit("/index.php/adif");

		// Import tab is active by default and shows the file input
		cy.get("#import-tab")
			.should("be.visible")
			.and("have.class", "active");
		cy.get("#userfile")
			.should("be.visible");
		cy.get("#prepare_sub")
			.should("be.visible")
			.contains("Upload");

		// Switch to the Export tab (force, the sticky header can overlap the tabs)
		cy.get("#export-tab")
			.click({ force: true });
		cy.get("#export")
			.should("be.visible")
			.contains("Take your logbook file anywhere!");
	});

	it("Should import an ADIF file", () => {
		cy.visit("/index.php/adif");

		// Attach the fixture file to the upload field
		cy.get("#userfile")
			.selectFile("cypress/fixtures/import_test.adi");

		// Ignore station/grid checks so the import always goes through
		cy.get("#skipStationCheck").check({ force: true });
		cy.get("#skipGridCheck").check({ force: true });

		// Start the import
		cy.get("#prepare_sub").click();

		// The success page should confirm the import
		cy.get("body", { timeout: 20000 })
			.contains("Yay, it's imported!")
			.should("be.visible");
		cy.get("body")
			.contains("Number of QSOs imported:");
	});

	it("Should export all QSOs as ADIF", () => {
		// exportall is a GET download, so we can request it directly
		cy.request("/index.php/adif/exportall").then((response) => {
			expect(response.status).to.eq(200);
			// A valid ADIF export ends the header with <EOH> and holds records
			expect(response.body).to.contain("<EOH>");
			expect(response.body).to.contain("<CALL:");
			// Each record carries its band and mode, and terminates with <EOR>
			expect(response.body).to.contain("<BAND:");
			expect(response.body).to.contain("<MODE:");
			expect(response.body).to.contain("<EOR>");
		});
	});

	it("Should offer a custom export form on the Export tab", () => {
		cy.visit("/index.php/adif");
		cy.get("#export-tab").click({ force: true });

		// The export panel holds a form posting to adif/export_custom with a
		// station-profile picker and an optional date range.
		cy.get("#export").within(() => {
			cy.get('form[action*="export_custom"]').should("exist");
			cy.get('select[name="station_profile"]').should("exist");
			cy.get('input[name="from"]').should("exist");
			cy.get('input[name="to"]').should("exist");
		});
	});
});

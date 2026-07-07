import 'cypress-real-events/support';

describe("QSO Live Logging", () => {
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

	it("Call QSO live logging page", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Make sure we see the QSO Logging form
		cy.get("#callsign")
			.should("be.visible");
		cy.get("#rst_sent")
			.should("be.visible");
		cy.get('button[id="saveQso"]')
			.should("be.visible");
	});

	it("Call the different tabs", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Click the Station Tab
		cy.get('a[id="station-tab"]')
			.click();

		// Make sure we see the frequency_rx field
		cy.get("#frequency_rx")
			.should("be.visible");
		
		// Click the General Tab
		cy.get('a[id="general-tab"]')
			.click();

		// Make sure we see the continent field
		cy.get("#continent")
			.should("be.visible");

		// Click the Satellite Tab
		cy.get('a[id="satellite-tab"]')
			.click();
		
		// Make sure we see the sat_name field
		cy.get("#sat_name")
			.should("be.visible");

		// Click the Notes Tab
		cy.get('a[id="notes-tab"]')
			.click();

		// Make sure we see the notes field
		cy.get("#notes")
			.should("be.visible");

		// Click the QSL Tab	
		cy.get('a[id="qsl-tab"]')
			.click();
	});

	it("Log a QSO", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Fill in the QSO data
		cy.get("#band")
			.select("20m");
		cy.get("#mode")
			.select("SSB");
		cy.get("#callsign")
			.type("DK0TU")
			.blur();
		// The 'worked before' assertion already gates the callsign lookup, so the
		// form is ready to submit; no fixed waits around the click are needed.
		cy.get('#timesWorked')
			.should('contain.text', 'worked before');
		cy.get('button[id="saveQso"]')
			.click();

		// Check if the QSO has been saved. .contains(...).should('be.visible')
		// retries until the confirmation renders.
		cy.get('body')
			.contains("was added to logbook")
			.should("be.visible");
	});

	it("Log a second QSO to check if worked before", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Fill in the QSO data
		cy.get("#callsign")
			.type("DK0TU")
			.blur();
		cy.get("body")
			.contains("worked before")
			.should("be.visible");
		cy.get("#band")
			.select("40m");
		cy.get("#mode")
			.select("AM");
		// The 'worked before' assertion above confirms the lookup finished, so
		// the save handler is bound; no fixed wait before the click.
		cy.get('button[id="saveQso"]')
			.click();

		// Check if the QSO has been saved
		cy.get('body')
			.contains("was added to logbook");
	});

	it("Check if the QSO is shown in latest Contacts", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Check if the QSO is shown in the latest contacts
		cy.get('body')
			.contains("DKØTU");
	});

	it("Check the Frequency Input", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// Choose a mode
		cy.get("#mode")
			.select("SSB");
		// Choose a band
		cy.get("#band")
			.select("17m");

		// Check if the frequency is set correctly
		cy.get("#frequency")
			.should("have.value", "18130000");
	});

	it("Post QSO mode enables the date and time fields", () => {
		// manual=1 is the "log a QSO made in the past" mode. Unlike the live
		// mode (manual=0), the date/time inputs are enabled for manual entry.
		cy.visit("/index.php/qso?manual=1");

		cy.get("#start_date")
			.should("be.visible")
			.and("not.be.disabled");
		cy.get("#start_time")
			.should("be.visible")
			.and("not.be.disabled");

		// The tab badge switches from LIVE to POST
		cy.get("#qso-tab")
			.should("contain.text", "POST");
	});

	it("Adjusts the default RST to the selected mode", () => {
		// Visit the QSO Live Logging Page
		cy.visit("/index.php/qso?manual=0");

		// CW switches the default report to 599 (setRst() in common.js)
		cy.get("#mode").select("CW");
		cy.get("#rst_sent").should("have.value", "599");
		cy.get("#rst_rcvd").should("have.value", "599");

		// FT8 (and the other weak-signal modes) use -05
		cy.get("#mode").select("FT8");
		cy.get("#rst_sent").should("have.value", "-05");
		cy.get("#rst_rcvd").should("have.value", "-05");

		// SSB (phone) falls back to 59
		cy.get("#mode").select("SSB");
		cy.get("#rst_sent").should("have.value", "59");
		cy.get("#rst_rcvd").should("have.value", "59");
	});
});

describe("SimpleFLE", () => {
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

    it("Call SimpleFLE from the header menu", () => {
		cy.visit("/index.php/dashboard");

		cy.get(".nav-link")
			.contains("QSO")
			.realHover();

		cy.get(".dropdown-menu")
			.should("be.visible")
			.contains("Simple Fast Log Entry")
			.click();

		// See SimpleFLE
		cy.url().should("include", "/simplefle");

        // Make sure we see the SimpleFLE form
        cy.get("#qsodate")
            .should("be.visible");

        cy.get("#contest")
            .should("be.visible");

        cy.get("#sfle_textarea")
            .should("be.visible");

        cy.get("table.sfletable thead tr").within(() => {
            cy.contains("th", "Date").should("be.visible");
            cy.contains("th", "Time").should("be.visible");
            cy.contains("th", "Callsign").should("be.visible");
            cy.contains("th", "Band").should("be.visible");
            cy.contains("th", "Mode").should("be.visible");
            cy.contains("th", "RST (S)").should("be.visible");
            cy.contains("th", "RST (R)").should("be.visible");
            cy.contains("th", "Gridsquare").should("be.visible");
            cy.contains("th", "Refs*").should("be.visible");
        });

        // Check if atleast the save button is visible
        cy.get('.js-save-to-log')
            .should("be.visible")
            .contains("Save in Wavelog");
	});

    it("Enter some QSO data", () => {
        cy.visit("/index.php/simplefle");

        // Enter some data
        cy.get("#qsodate")
            .type("2021-01-01");

        cy.get("#sfle_textarea")
            .type("20m ssb\n1200 hb9hil jn47rh")
            .type("{enter}");

        // Check if the QSO is entered
        cy.get("table.sfletable tbody tr")
            .should("have.length", 1)
            .first()
            .within(() => {
                cy.get("td").eq(0).should("contain.text", "2021-01-01");
                cy.get("td").eq(1).should("contain.text", "1200");
                cy.get("td").eq(2).should("contain.text", "HB9HIL");
                cy.get("td").eq(3).should("contain.text", "20m");
                cy.get("td").eq(4).should("contain.text", "SSB");
                cy.get("td").eq(5).should("contain.text", "59");
                cy.get("td").eq(6).should("contain.text", "59");
                cy.get("td").eq(7).should("contain.text", "JN47RH");
            });

        // Save the QSO
        cy.get('.js-save-to-log')
            .click();

        // Check if the modal pops up and hit ok
        cy.get(".modal-dialog")
            .get(".modal-body")
            .contains("Are you sure that you want to add these QSO to the Log and clear the session?")
            .should("be.visible")
            .get(".modal-footer")
            .contains("OK")
            .click();
        
        cy.get("body")
            .contains("QSO Logged!");
    });
});

describe("Live Contest Logging", () => {

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

	it("Should show the Contest Management dashboard", () => {
		// The contesting entry point is now a management dashboard
		cy.visit("/index.php/contesting");

		// The dashboard offers a Quick Start button to launch a session
		cy.get('a[href*="contesting/quickstart"]')
			.should("be.visible")
			.and("contain.text", "Quick Start");
	});

	it("Should open the contest logging engine", () => {
		// Quick Start creates a session and redirects to the logging engine
		cy.visit("/index.php/contesting/quickstart");

		// We should end up on the logging engine
		cy.url().should("include", "/contesting/logging_engine/");

		// Wait until the JS engine finished loading (loading screen gets removed)
		cy.get("#contest-loading-screen", { timeout: 20000 })
			.should("not.exist");

		// Make sure we see the QSO logging form
		cy.get("#qso-callsign", { timeout: 10000 })
			.should("be.visible");
		cy.get("#qso-rst-sent")
			.should("be.visible");
		cy.get("#qso-rst-received")
			.should("be.visible");
	});

});
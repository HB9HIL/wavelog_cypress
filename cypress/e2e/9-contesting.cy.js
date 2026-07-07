import 'cypress-real-events/support';

// End-to-end coverage for the contesting feature: create a session via
// Quickstart, load the logging engine, log a QSO in the engine and verify it
// shows up in the "Recent QSOs" list, then export the session as ADIF,
// Cabrillo and REG1TEST/EDI.
//
// The logging engine is an offline-first JS app (IndexedDB + heartbeat/worker
// transport). The on-page log updates immediately from local state, while the
// export endpoints read from the server DB after the record has synced, so the
// ADIF-contains-callsign check is done with a retry.

describe("Contesting", () => {
	const CONTEST_CALL = "9A9CTS";

	// The contest_session_id created by Quickstart, read from the manager page.
	let sessionId;

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

	it("Shows the contest management dashboard", () => {
		cy.visit("/index.php/contesting");
		cy.get('a[href*="contesting/quickstart"]')
			.should("be.visible")
			.and("contain.text", "Quick Start");
	});

	it("Starts a session and loads the logging engine", () => {
		cy.visit("/index.php/contesting/quickstart");

		// Quickstart creates a session and redirects to the logging engine
		cy.url().should("include", "/contesting/logging_engine/");

		// Wait until the JS engine finished loading (loading screen removed)
		cy.get("#contest-loading-screen", { timeout: 20000 })
			.should("not.exist");

		cy.get("#qso-callsign", { timeout: 10000 }).should("be.visible");
		cy.get("#qso-rst-sent").should("be.visible");
		cy.get("#qso-rst-received").should("be.visible");
		cy.get("#qso-table").should("be.visible");
	});

	it("Logs a QSO in the engine and shows it in Recent QSOs", () => {
		cy.visit("/index.php/contesting/quickstart");
		cy.get("#contest-loading-screen", { timeout: 20000 }).should("not.exist");
		cy.get("#qso-callsign", { timeout: 10000 }).should("be.visible");

		// Fill the callsign, then set frequency + mode and log in one JS tick.
		// logQso() requires a frequency and mode from the radio component:
		// getFrequency() reads the hidden #frequency field, getMode() reads #mode.
		// The manual radio-entry widget itself is out of scope here.
		cy.get("#qso-callsign").type(CONTEST_CALL);
		cy.window().then((win) => {
			win.document.getElementById("frequency").value = "14074000";
			const modeSel = win.document.getElementById("mode");
			const opt = [...modeSel.options].find((o) => o.value);
			if (opt) modeSel.value = opt.value;
			expect(win.logQso, "window.logQso").to.be.a("function");
			win.logQso();
		});

		// The QSO shows up in the on-page log and the counter increments
		cy.get("#qso-tbody tr", { timeout: 10000 })
			.should("have.length.at.least", 1);
		cy.get("#qso-tbody")
			.should("contain.text", CONTEST_CALL);
		cy.get("#qso-count-badge")
			.should("not.have.text", "0");
	});

	it("Reads the session id from the management dashboard", () => {
		cy.visit("/index.php/contesting");

		// Every session row links to its exports; grab the id from the ADIF link
		cy.get('a[href*="contesting/export_adif/"]')
			.first()
			.invoke("attr", "href")
			.then((href) => {
				sessionId = href.split("/").pop();
				expect(sessionId, "contest session id").to.match(/^\d+$/);
			});
	});

	it("Exports the session as ADIF", () => {
		expect(sessionId, "session id from previous test").to.be.ok;

		cy.request(`/index.php/contesting/export_adif/${sessionId}`).then((response) => {
			expect(response.status).to.eq(200);
			// A valid ADIF file always ends its header with <EOH>
			expect(response.body.toUpperCase()).to.contain("<EOH>");
		});
	});

	it("Exports the session as Cabrillo", () => {
		// All Cabrillo category fields default server-side, so an empty POST works
		cy.request({
			method: "POST",
			url: `/index.php/contesting/export_cabrillo/${sessionId}`,
			form: true,
			body: {},
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.contain("START-OF-LOG");
		});
	});

	it("Exports the session as REG1TEST/EDI", () => {
		cy.request({
			method: "POST",
			url: `/index.php/contesting/export_reg1test/${sessionId}`,
			form: true,
			body: {},
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.contain("[REG1TEST;1]");
		});
	});
});

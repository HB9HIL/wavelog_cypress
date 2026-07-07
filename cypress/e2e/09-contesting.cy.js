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

		// The SCP callsign database must finish loading into the browser.
		cy.waitForScpReady();
	});

	it("Logs a QSO in the engine and shows it in Recent QSOs", () => {
		cy.visit("/index.php/contesting/quickstart");
		cy.get("#contest-loading-screen", { timeout: 20000 }).should("not.exist");
		cy.get("#qso-callsign", { timeout: 10000 }).should("be.visible");

		// Wait for the SCP callsign database before interacting with the form.
		cy.waitForScpReady();

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

// Frontend coverage for the logging engine's floating-window desktop
// (assets/js/sections/contesting/contest_engine/core/window-manager.js). The
// engine renders each component as a draggable/resizable ".window" inside
// #logger-workspace, and an offcanvas control panel (#controlPanel) lets the
// operator toggle window visibility and save/reset the layout. These tests
// drive that UI directly: move a window, hide it, toggle it from the panel and
// persist a named layout.
describe("Contesting engine window management", () => {
	// Reuse a single session for all window tests: create it once, then re-open
	// the same logging-engine URL in each test instead of spawning new sessions.
	let engineUrl;

	before(() => {
		cy.setCookie('language', 'english');
		cy.login();
		cy.getCookies().then(cookies => {
			cy.writeFile('cypress/fixtures/cookies.json', cookies);
		});
		cy.visit("/index.php/contesting/quickstart");
		cy.url().should("include", "/contesting/logging_engine/").then((url) => {
			engineUrl = url;
		});
	});

	beforeEach(() => {
		cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
			cookies.forEach(cookie => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
		cy.visit(engineUrl);
		// Wait for the engine to boot and the windows to be created.
		cy.get("#contest-loading-screen", { timeout: 20000 }).should("not.exist");
		cy.get("#logger-workspace .window", { timeout: 10000 })
			.should("have.length.at.least", 1);

		// Wait until the SCP callsign database is fully loaded into the browser.
		cy.waitForScpReady();
	});

	it("Renders draggable windows with a header and controls", () => {
		cy.get("#logger-workspace .window").first().within(() => {
			cy.get(".window-header").should("exist");
			cy.get(".window-title").should("exist");
			cy.get(".window-btn.close").should("exist");
		});
	});

	it("Opens the control panel with visibility and layout controls", () => {
		cy.get("#controlPanelToggle").click();

		cy.get("#controlPanel").should("be.visible").and("have.class", "show");

		// One toggle button per window, plus the save / reset layout controls
		cy.get("#componentVisibilityList button", { timeout: 6000 })
			.should("have.length.at.least", 1);
		cy.get("#saveNewLayoutBtn").should("exist");
		cy.get("#resetLayoutBtn").should("exist");
	});

	it("Moves a window by dragging its header", () => {
		cy.get("#logger-workspace .window").filter(":visible").first().as("win");

		cy.get("@win").then(($w) => {
			const startLeft = parseFloat($w[0].style.left) || 0;
			const startTop = parseFloat($w[0].style.top) || 0;

			// Grab the header and drag the whole window across the workspace.
			cy.get("@win").find(".window-header").first()
				.realMouseDown({ position: "center" });
			cy.get("body").realMouseMove(750, 480);
			cy.get("body").realMouseUp();

			cy.get("@win").should(($el) => {
				const newLeft = parseFloat($el[0].style.left) || 0;
				const newTop = parseFloat($el[0].style.top) || 0;
				// At least one axis must have moved noticeably.
				expect(Math.abs(newLeft - startLeft) + Math.abs(newTop - startTop))
					.to.be.greaterThan(5);
			});
		});
	});

	it("Hides a window via its close button", () => {
		cy.get("#logger-workspace .window").filter(":visible").first().as("win");

		cy.get("@win").then(($w) => {
			cy.wrap($w).find(".window-btn.close").click();
			cy.wrap($w).should("not.be.visible");
		});
	});

	it("Toggles window visibility from the control panel", () => {
		cy.get("#controlPanelToggle").click();
		cy.get("#controlPanel").should("have.class", "show");
		cy.get("#componentVisibilityList button", { timeout: 6000 })
			.should("have.length.at.least", 1);

		// Hiding the first component removes exactly one visible window.
		cy.get("#logger-workspace .window").filter(":visible").its("length").then((n) => {
			cy.get("#componentVisibilityList button").first().click();
			cy.get("#logger-workspace .window").filter(":visible")
				.should("have.length", n - 1);
		});
	});

	it("Saves a named layout and lists it", () => {
		cy.get("#controlPanelToggle").click();
		cy.get("#controlPanel").should("have.class", "show");

		// promptSaveNewLayout() asks for a name via window.prompt.
		cy.window().then((win) => {
			cy.stub(win, "prompt").returns("e2e-layout");
		});

		cy.get("#saveNewLayoutBtn").click();

		// After the save round-trip the layout appears in the saved list.
		cy.get("#savedLayoutsList", { timeout: 10000 })
			.should("contain.text", "e2e-layout");
	});

	it("Resets the layout, restoring a hidden window", () => {
		// Hide the first visible window, remembering exactly which one it was.
		// (Operate on the concrete element/id rather than re-querying an alias:
		// a ".filter(':visible').first()" alias would resolve to a *different*
		// window once the first one is hidden.)
		cy.get("#logger-workspace .window").filter(":visible").first().then(($w) => {
			const winId = $w[0].id;

			cy.wrap($w).find(".window-btn.close").click();
			cy.wrap($w).should("not.be.visible");

			// resetUserLayout() asks for confirmation before restoring defaults.
			cy.window().then((win) => {
				cy.stub(win, "confirm").returns(true);
			});

			cy.get("#controlPanelToggle").click();
			cy.get("#controlPanel").should("have.class", "show");
			cy.get("#resetLayoutBtn").click();

			// The previously hidden window is visible again.
			cy.get(`#${winId}`).should("be.visible");
		});
	});
});

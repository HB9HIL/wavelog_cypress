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

// End-to-end coverage for the legacy contest import (controller
// Contesting_import): QSOs that carry a CONTEST_ID but are not yet linked to
// any contest session can be imported as historical contest sessions.
//
// The flow under test: seed the logbook via ADIF import with contest QSOs,
// preview the detected groups on /contesting_import (grouped by contest +
// station and split into time segments: a new segment starts when consecutive
// QSOs are >= 72h apart AND in different ISO calendar weeks), import them and
// verify the created sessions in the contest manager.
//
// The fixture holds 5 QSOs:
//   - 2x CQ-WW-SSB on the 2021 contest weekend  -> segment 1
//   - 2x CQ-WW-SSB on the 2022 contest weekend  -> segment 2 (>72h + new week)
//   - 1x unknown contest id "CYPRESS-TEST"      -> mapped to "Other"
// => the preview must show 3 groups, the import must create 3 sessions with
//    5 linked QSOs in total.
describe("Contesting legacy import", () => {
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

	it("Imports an ADIF log with historical contest QSOs", () => {
		cy.visit("/index.php/adif");

		cy.get("#userfile")
			.selectFile("cypress/fixtures/contest_legacy_import.adi");

		// Ignore station/grid checks so the import always goes through
		cy.get("#skipStationCheck").check({ force: true });
		cy.get("#skipGridCheck").check({ force: true });

		cy.get("#prepare_sub").click();

		cy.get("body", { timeout: 20000 })
			.contains("Yay, it's imported!")
			.should("be.visible");
	});

	it("Links to the legacy import from the contest dashboard", () => {
		cy.visit("/index.php/contesting");

		// Regular per-user import link (href$= so the admin /all link is not matched)
		cy.get('a[href$="contesting_import"]')
			.should("be.visible")
			.and("contain.text", "Import historical contests");

		// The test user is an admin, so the all-users variant is offered too
		cy.get('a[href*="contesting_import/all"]').should("exist");
	});

	it("Previews the historical contest groups with segmentation", () => {
		cy.visit("/index.php/contesting_import");

		cy.get("h2").contains("Import Historical Contests").should("be.visible");

		// The two CQ-WW-SSB weekends are >72h apart in different ISO weeks, so
		// they must show up as two separate sessions (2021 and 2022), 2 QSOs each.
		cy.get('#import-legacy-form tbody tr:contains("CQ-WW-SSB")')
			.should("have.length", 2)
			.then(($rows) => {
				const years = [...$rows].map((r) => r.cells[3].innerText.trim());
				expect(years).to.have.members(["2021", "2022"]);
				[...$rows].forEach((r) => {
					expect(r.cells[7].innerText.trim(), "QSO count per segment").to.eq("2");
				});
			});

		// The known contest id resolves to its display name from the contest table
		cy.get("#import-legacy-form tbody")
			.should("contain.text", "CQ WW DX Contest (SSB)");

		// The unknown contest id falls back to "Other" and is flagged as such
		cy.contains("#import-legacy-form tbody tr", "CYPRESS-TEST").within(() => {
			cy.get(".badge").should("contain.text", "Other");
			cy.get("td").eq(7).should("have.text", "1");
		});

		// All groups are preselected; the select-all checkbox toggles them
		cy.get('input[name="groups[]"]').should("have.length", 3);
		cy.get('input[name="groups[]"]:checked').should("have.length", 3);
		cy.get("#select-all").uncheck();
		cy.get('input[name="groups[]"]:checked').should("have.length", 0);
		cy.get("#select-all").check();
		cy.get('input[name="groups[]"]:checked').should("have.length", 3);
	});

	it("Shows the admin preview for all users", () => {
		cy.visit("/index.php/contesting_import/all");

		cy.get("h2")
			.contains("Import Historical Contests (All Users)")
			.should("be.visible");
		cy.get(".alert-warning").should("contain.text", "Admin mode:");
		cy.get('#import-legacy-form tbody tr:contains("CQ-WW-SSB")')
			.should("have.length", 2);
	});

	it("Blocks the import when no group is selected", () => {
		cy.visit("/index.php/contesting_import");

		// With nothing selected the submit handler alerts and prevents the POST
		cy.window().then((win) => {
			cy.stub(win, "alert").as("noSelectionAlert");
		});

		cy.get("#select-all").uncheck();
		cy.get('input[name="groups[]"]:checked').should("have.length", 0);
		cy.get("#import-btn").click();

		cy.get("@noSelectionAlert").should("have.been.calledOnce");
		cy.url().should("include", "/contesting_import");
	});

	it("Imports the selected historical contests", () => {
		cy.visit("/index.php/contesting_import");
		cy.get('input[name="groups[]"]:checked').should("have.length", 3);

		// The form asks for confirmation before submitting
		cy.window().then((win) => {
			cy.stub(win, "confirm").returns(true);
		});

		cy.get("#import-btn").click();

		// Redirects back to the manager: 3 sessions (2x CQ-WW-SSB segments +
		// 1x unknown -> Other) with all 5 QSOs linked.
		cy.url().should("match", /\/contesting\/?$/);
		cy.get(".alert-message")
			.should("contain.text", "3 session(s) created, 5 QSO(s) linked.");
	});

	it("Shows the imported sessions in the contest manager", () => {
		cy.visit("/index.php/contesting");

		cy.get("#user_contests_table")
			.should("contain.text", "CQ WW DX Contest (SSB)")
			.and("contain.text", "Imported from logbook");

		// One row per imported session
		cy.get('#user_contests_table tbody tr:contains("Imported from logbook")')
			.should("have.length", 3);
	});

	it("Redirects with a warning when nothing is left to import", () => {
		// All groups are linked now, so both preview pages bail out to the manager
		cy.visit("/index.php/contesting_import");
		cy.url().should("match", /\/contesting\/?$/);
		cy.get(".alert-warning")
			.should("contain.text", "No historical contests found");

		cy.visit("/index.php/contesting_import/all");
		cy.url().should("match", /\/contesting\/?$/);
		cy.get(".alert-warning")
			.should("contain.text", "No historical contests found");
	});
});

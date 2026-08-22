// Escaping regression test.
//
// Wavelog renders QSO fields into two different output contexts: HTML text and
// inline JavaScript (onclick=, href="javascript:..."). Each needs its own
// escaping - html_escape() for the former, js_escape() for the latter - and
// getting them mixed up is the classic way an XSS slips back in.
//
// The approach: import one QSO whose fields carry a canary payload, then walk
// every page that renders QSO data and scan the DOM for traces of the payload
// having escaped its context. See cy.checkNoXss() in support/commands.js for
// what the scan actually looks at.
//
// Payloads go in through the ADIF importer rather than straight into the
// database, so the spec needs no SQL access and works the same in all three
// orchestrators. The trade-off is that the importer normalises some fields, so
// the spec verifies the payload actually survived (see the guard tests) instead
// of quietly passing on data that never arrived.

describe("XSS escaping", () => {
	const CALL = "T6XSS";

	// Pages reachable with a plain GET that render QSO data. The award matrices
	// are in here because their models build HTML themselves (Dxcc.php, Was.php,
	// ...), which is exactly the kind of code that forgets to escape.
	const pages = [
		// Logbook and QSO listings
		{ name: "dashboard", url: "dashboard" },
		{ name: "logbook", url: "logbook" },
		{ name: "logbookadvanced", url: "logbookadvanced" },
		{ name: "search", url: "search" },
		{ name: "calltester", url: "calltester" },
		{ name: "statistics", url: "statistics" },
		{ name: "debug", url: "debug" },
		// Analytics
		{ name: "timeline", url: "timeline" },
		{ name: "distance records", url: "distancerecords" },
		{ name: "distances", url: "distances" },
		{ name: "activators", url: "activators" },
		{ name: "callstats", url: "callstats" },
		{ name: "accumulated", url: "accumulated" },
		{ name: "days with QSO", url: "dayswithqso" },
		{ name: "timeplotter", url: "timeplotter" },
		{ name: "QSO map", url: "map/qso_map" },
		{ name: "gridmap", url: "gridmap" },
		{ name: "activated gridmap", url: "activated_gridmap" },
		// QSL handling
		{ name: "QSL cards", url: "qsl" },
		{ name: "QSL print", url: "qslprint" },
		// Award matrices
		{ name: "DXCC award", url: "awards/dxcc" },
		{ name: "WAS award", url: "awards/was" },
		{ name: "WAJA award", url: "awards/waja" },
		{ name: "WAC award", url: "awards/wac" },
		{ name: "WAE award", url: "awards/wae" },
		{ name: "WAB award", url: "awards/wab" },
		{ name: "WAP award", url: "awards/wap" },
		{ name: "WAPC award", url: "awards/wapc" },
		{ name: "WAIP award", url: "awards/waip" },
		{ name: "WPX award", url: "awards/wpx" },
		{ name: "IOTA award", url: "awards/iota" },
		{ name: "VUCC award", url: "awards/vucc" },
		{ name: "CQ award", url: "awards/cq" },
		{ name: "ITU award", url: "awards/itu" },
		{ name: "RAC award", url: "awards/rac" },
		{ name: "DOK award", url: "awards/dok" },
		{ name: "JCC award", url: "awards/jcc" },
		{ name: "FFMA award", url: "awards/ffma" },
		{ name: "Helvetia award", url: "awards/helvetia" },
		{ name: "counties award", url: "awards/counties" },
		{ name: "SOTA award", url: "awards/sota" },
		{ name: "POTA award", url: "awards/pota" },
		{ name: "WWFF award", url: "awards/wwff" },
		{ name: "SIG award", url: "awards/sig" },
		{ name: "Polska award", url: "awards/pl_polska" },
		{ name: "AMSAT rover", url: "awards/amsat_rover" },
		{ name: "73on73 award", url: "awards/seven3on73" },
	];

	// Where the canary actually showed up. Rendering nothing is not a pass - a
	// scan over a page without the payload proves nothing - so the last test
	// asserts this is not empty and prints the full breakdown, which doubles as
	// the coverage report for the list above.
	const canarySeen = {};
	let qsoId = null;

	function noteCanary(name, html) {
		canarySeen[name] = html.includes(Cypress.expose("xss").canary);
	}

	before(() => {
		cy.setCookie("language", "english");
		cy.login();
		cy.getCookies().then((cookies) => {
			cy.writeFile("cypress/fixtures/cookies.json", cookies);
		});
	});

	beforeEach(() => {
		cy.readFile("cypress/fixtures/cookies.json").then((cookies) => {
			cookies.forEach((cookie) => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
	});

	it("Should import a QSO carrying the XSS payload", () => {
		const xss = Cypress.expose("xss");

		// Built here rather than kept as a fixture because ADIF prefixes every
		// value with its length - generating it keeps those in sync with the
		// payload instead of relying on hand-counted numbers staying correct.
		const field = (name, value) => `<${name}:${value.length}>${value}`;

		// Logged today so the QSO also shows up in the "recent contacts" views
		// and at the top of the logbook. 00:01 UTC keeps it in the past no
		// matter what time of day the suite runs.
		const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

		const adif =
			"Wavelog Cypress XSS test file\n" +
			"<ADIF_VER:5>3.1.4\n<PROGRAMID:7>Wavelog\n<EOH>\n" +
			[
				field("CALL", CALL),
				field("QSO_DATE", today),
				field("TIME_ON", "0001"),
				field("BAND", "20m"),
				field("MODE", "SSB"),
				field("RST_SENT", "59"),
				field("RST_RCVD", "59"),
				field("STATION_CALLSIGN", "4W7EST"),
				// CALL stays clean: it is validated on import, so a payload
				// there would be rejected and take the whole record with it.
				// IOTA gets the short variant - its column is varchar(10) and
				// an over-long value aborts the import instead of truncating.
				field("STATE", xss.payload),
				field("SAT_NAME", xss.payload),
				field("IOTA", xss.short),
				field("COMMENT", xss.payload),
				field("NAME", xss.payload),
				field("QSLMSG", xss.payload),
				"<EOR>\n",
			].join("");

		cy.visit("/index.php/adif");
		cy.get("#userfile").selectFile({
			contents: Cypress.Buffer.from(adif),
			fileName: "xss_test.adi",
			mimeType: "text/plain",
		});

		// Ignore station/grid checks so the import always goes through
		cy.get("#skipStationCheck").check({ force: true });
		cy.get("#skipGridCheck").check({ force: true });
		cy.get("#prepare_sub").click();

		cy.get("body", { timeout: 20000 })
			.contains("Yay, it's imported!")
			.should("be.visible");
	});

	it("Should have stored the payload verbatim (guard against a vacuous run)", () => {
		// If the importer had stripped or rewritten the payload, every scan
		// below would pass while testing nothing at all. The ADIF export is the
		// cheapest way to read the fields back exactly as stored.
		cy.request("/index.php/adif/exportall").then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body, "payload survived the ADIF round trip").to.contain(
				Cypress.expose("xss").payload
			);
		});
	});

	pages.forEach((page) => {
		it(`Should render ${page.name} without XSS`, () => {
			cy.visit("/index.php/" + page.url);
			// A page that bounced us to the login form would be scanned as the
			// login form - green, and meaningless.
			cy.url().should("not.include", "/user/login");
			cy.document().then((doc) => noteCanary(page.name, doc.body.innerHTML));
			cy.checkNoXss(page.name);
		});
	});

	// -----------------------------------------------------------------------
	// Fragments loaded over AJAX. They never appear as a URL in the browser, so
	// they are requested directly and scanned as detached markup.
	// -----------------------------------------------------------------------

	it("Should render the logbook search result without XSS", () => {
		// Doubles as the source for the QSO id the single-QSO view needs.
		cy.request(`/index.php/logbook/search_result/${CALL}`).then((response) => {
			noteCanary("logbook/search_result", response.body);
			cy.checkNoXssInHtml(response.body, "logbook/search_result");

			const match = response.body.match(/displayQso\((\d+)\)/);
			expect(match, `QSO id for ${CALL}`).to.not.be.null;
			qsoId = match[1];
		});
	});

	// logbook/view is not a page either: displayQso() in common.js POSTs it and
	// drops the markup into the QSO dialog. Requested the same way.
	it("Should render the single QSO view without XSS", () => {
		expect(qsoId, "QSO id from the previous test").to.not.be.null;
		cy.request({
			method: "POST",
			url: `/index.php/logbook/view/${qsoId}`,
		}).then((response) => {
			noteCanary("logbook/view", response.body);
			cy.checkNoXssInHtml(response.body, "single QSO view");
		});
	});

	// The advanced search posts the jQuery QueryBuilder rules as JSON, not a
	// plain term - Search::buildWhere() takes an array and answers 500 on
	// anything else. Built the way footer.php builds it from #builder.
	it("Should render the search result without XSS", () => {
		const rules = {
			condition: "AND",
			rules: [
				{
					id: "COL_CALL",
					field: "COL_CALL",
					type: "string",
					input: "text",
					operator: "equal",
					value: CALL,
				},
			],
			valid: true,
		};

		cy.request({
			method: "POST",
			url: "/index.php/search/search_result",
			form: true,
			body: { search: JSON.stringify(rules) },
		}).then((response) => {
			noteCanary("search/search_result", response.body);
			cy.checkNoXssInHtml(response.body, "search/search_result");
		});
	});

	it("Should render the callsign tester info without XSS", () => {
		cy.request(`/index.php/calltester/call_info/${CALL}`).then((response) => {
			noteCanary("calltester/call_info", response.body);
			cy.checkNoXssInHtml(response.body, "calltester/call_info");
		});
	});

	// The SOTA/POTA/WWFF tables are DataTables sources, not pages: they answer
	// with JSON whose cells are HTML built in the controller (links carrying the
	// reference and the callsign), so they are fetched the way the map pages
	// fetch them and the cells are scanned as markup.
	["sota", "pota", "wwff"].forEach((award) => {
		it(`Should render the ${award.toUpperCase()} table without XSS`, () => {
			cy.request({
				method: "POST",
				url: `/index.php/awards/${award}_table`,
				form: true,
				body: { band: "All", mode: "All", worked: 1, confirmed: 1 },
			}).then((response) => {
				const rows = response.body.data || [];
				const html = rows
					.map((row) => `<tr><td>${row.join("</td><td>")}</td></tr>`)
					.join("");
				noteCanary(`awards/${award}_table`, html);
				cy.checkNoXssInHtml(`<table>${html}</table>`, `awards/${award}_table`);
			});
		});
	});

	it("Should render the WPX details fragment without XSS", () => {
		cy.request({
			method: "POST",
			url: "/index.php/awards/wpx_details",
			form: true,
			body: { band: "20m", status: "W", mode: "All", summaryband: "All" },
		}).then((response) => {
			noteCanary("wpx_details", response.body);
			cy.checkNoXssInHtml(response.body, "wpx_details");
		});
	});

	// The WAB square list is not a page: awards/wab_list is the POST target
	// behind the "Show list" button on the WAB award page (assets/js/sections/wab.js)
	// and answers 500 on a bare GET, since it reads its filters straight out of
	// the post data. Driven the way the UI drives it.
	it("Should render the WAB list fragment without XSS", () => {
		cy.request({
			method: "POST",
			url: "/index.php/awards/wab_list",
			form: true,
			body: { band: "All", mode: "All", sat: "All", orbit: "All" },
		}).then((response) => {
			noteCanary("awards/wab_list", response.body);
			cy.checkNoXssInHtml(response.body, "awards/wab_list");
		});
	});

	it("Should have rendered the payload somewhere (guard against a vacuous run)", () => {
		// Individual pages may legitimately not show the QSO - an award matrix
		// only lists what its filters match. But if *no* target rendered the
		// canary, the scans above never had anything to find and the suite
		// would be green for the wrong reason.
		const seen = Object.keys(canarySeen).filter((k) => canarySeen[k]);
		const missing = Object.keys(canarySeen).filter((k) => !canarySeen[k]);

		cy.log(`payload rendered on ${seen.length} target(s): ${seen.join(", ")}`);
		cy.log(`payload absent on ${missing.length} target(s): ${missing.join(", ")}`);

		expect(seen, "targets that actually rendered the payload").to.not.be.empty;
	});
});

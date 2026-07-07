// Wavelog ships two parallel APIs: the older v1 (RPC-style, key in the JSON body
// or as a URL segment) and the newer v2 (REST, Bearer token). This spec covers
// the v1 endpoints as a contract: the core happy-path calls plus the auth error
// cases (401/403). A separate 15-api_v2.cy.js will follow for v2.
//
// The v1 endpoints authenticate via an API key, not the session cookie. There is
// no API endpoint to mint a key, so we generate both a read-write and a
// read-only key once through the web UI (/index.php/api), same as 08-mqtt.cy.js.

describe("API v1", () => {
	// The installer creates a single user (user_id 1) with a default station
	// location (station_profile_id 1) whose logbook carries the public slug set
	// in 02-stationsetup.cy.js.
	const STATION_PROFILE_ID = 1;

	const env_user = Cypress.expose('user');
	const env_stationsetup = Cypress.expose('stationsetup');

	let rwKey;
	let roKey;

	before(() => {
		cy.setCookie('language', 'english');
		cy.login();
		cy.getCookies().then(cookies => {
			cy.writeFile('cypress/fixtures/cookies.json', cookies);
		});

		// Generate one read-write and one read-only key. Each button POSTs and
		// reloads the page; afterwards the table lists both keys.
		cy.visit("/index.php/api");
		cy.get('button').contains("Create a read & write key").click();
		cy.get('button').contains("Create a read-only key").click();

		// Read each key by its permission badge rather than row order, so a
		// read-write key left over from 08-mqtt.cy.js can't shadow ours.
		cy.contains('.badge', 'Read & Write')
			.closest('tr')
			.find('.api-key')
			.first()
			.invoke('text')
			.then((text) => {
				rwKey = text.trim();
				expect(rwKey, "read-write API key").to.have.length.greaterThan(0);
			});
		cy.contains('.badge', 'Read-Only')
			.closest('tr')
			.find('.api-key')
			.first()
			.invoke('text')
			.then((text) => {
				roKey = text.trim();
				expect(roKey, "read-only API key").to.have.length.greaterThan(0);
			});
	});

	beforeEach(() => {
		cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
			cookies.forEach(cookie => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
	});

	it("POST /api/version returns the Wavelog version", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/version",
			body: { key: rwKey },
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.have.property("status", "ok");
			expect(response.body.version, "version string").to.match(/\d/);
		});
	});

	it("GET /api/auth/<key> returns the rights as XML", () => {
		cy.request(`/index.php/api/auth/${rwKey}`).then((response) => {
			expect(response.status).to.eq(200);
			// auth is the only XML endpoint; assert on the raw body text.
			expect(response.headers["content-type"]).to.include("xml");
			expect(response.body).to.include("<status>Valid</status>");
			expect(response.body).to.include("<rights>rw</rights>");
		});
	});

	it("GET /api/check_auth/<key> validates a read-write key", () => {
		cy.request(`/index.php/api/check_auth/${rwKey}`).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.have.property("status", "valid");
			expect(response.body).to.have.property("rights", "rw");
		});
	});

	it("GET /api/station_info/<key> lists the station profiles", () => {
		cy.request(`/index.php/api/station_info/${rwKey}`).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.be.an("array").and.to.have.length.greaterThan(0);
			expect(response.body[0]).to.have.property("station_profile_name");
			expect(response.body[0]).to.have.property("station_callsign");
		});
	});

	it("GET /api/statistics/<key> returns QSO counts", () => {
		cy.request(`/index.php/api/statistics/${rwKey}`).then((response) => {
			// statistics answers with 201 by design, not 200.
			expect(response.status).to.eq(201);
			expect(response.body).to.have.property("total_qsos");
			expect(Number(response.body.total_qsos)).to.be.a("number");
			expect(Number.isNaN(Number(response.body.total_qsos))).to.eq(false);
		});
	});

	it("POST /api/qso/1 accepts a dry run", () => {
		const adif =
			"<call:6>T6API1<qso_date:8>20240102<time_on:4>1202<band:3>20m<mode:3>SSB<eor>";

		cy.request({
			method: "POST",
			url: "/index.php/api/qso/1", // trailing /1 => dryrun
			body: {
				key: rwKey,
				station_profile_id: STATION_PROFILE_ID,
				type: "adif",
				string: adif,
			},
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body).to.have.property("status", "created");
			expect(response.body.messages.join(" ")).to.include("Dryrun");
		});
	});

	it("POST /api/qso logs a QSO", () => {
		const adif =
			"<call:6>T6API2<qso_date:8>20240102<time_on:4>1203<band:3>20m<mode:3>SSB<eor>";

		cy.request({
			method: "POST",
			url: "/index.php/api/qso",
			body: {
				key: rwKey,
				station_profile_id: STATION_PROFILE_ID,
				type: "adif",
				string: adif,
			},
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body).to.have.property("status", "created");
			expect(response.body.adif_count).to.eq(1);
			expect(response.body.adif_errors).to.eq(0);
		});
	});

	it("POST /api/logbook_check_callsign returns a lookup result", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/logbook_check_callsign",
			body: {
				key: rwKey,
				logbook_public_slug: env_stationsetup.public_slug,
				callsign: "T6API2",
			},
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body.callsign).to.eq("T6API2");
			expect(response.body.result).to.be.oneOf(["Found", "Not Found"]);
		});
	});

	it("POST /api/private_lookup returns callsign details", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/private_lookup",
			body: { key: rwKey, callsign: env_user.callsign },
		}).then((response) => {
			expect(response.status).to.eq(200);
			// The endpoint echoes the callsign uppercased.
			expect(response.body.callsign).to.eq(env_user.callsign.toUpperCase());
			expect(response.body).to.have.property("dxcc_id");
		});
	});

	it("rejects an invalid key with 401", () => {
		cy.request({
			method: "GET",
			url: "/index.php/api/check_auth/notavalidkey",
			failOnStatusCode: false,
		}).then((response) => {
			expect(response.status).to.eq(401);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("rejects a QSO without a key with 401", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/qso",
			failOnStatusCode: false,
			body: {
				station_profile_id: STATION_PROFILE_ID,
				type: "adif",
				string: "<call:6>T6API3<qso_date:8>20240102<time_on:4>1204<band:3>20m<mode:3>SSB<eor>",
			},
		}).then((response) => {
			expect(response.status).to.eq(401);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("rejects a QSO from a read-only key with 403", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/qso",
			failOnStatusCode: false,
			body: {
				key: roKey,
				station_profile_id: STATION_PROFILE_ID,
				type: "adif",
				string: "<call:6>T6API4<qso_date:8>20240102<time_on:4>1205<band:3>20m<mode:3>SSB<eor>",
			},
		}).then((response) => {
			expect(response.status).to.eq(403);
			expect(response.body).to.have.property("status", "failed");
		});
	});
});

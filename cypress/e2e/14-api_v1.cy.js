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

	// Logbook 1 is the installer default. 02-stationsetup.cy.js attaches the
	// public slug to it, so it is guaranteed to have an associated station
	// location — logbook_get_worked_grids answers 404 for logbooks without one.
	const LOGBOOK_ID = 1;

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

		cy.createApiKey("rw").then((key) => { rwKey = key; });
		cy.createApiKey("ro").then((key) => { roKey = key; });
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

	it("POST /api/get_contacts_adif exports QSOs as ADIF", () => {
		cy.apiPost("get_contacts_adif", {
			key: rwKey,
			station_id: STATION_PROFILE_ID,
			fetchfromid: 0, // 0 => everything from the start of the log
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.have.property("status", "successful");
			expect(response.body.exported_qsos).to.be.greaterThan(0);
			// The QSO logged above must be part of a full export.
			expect(response.body.adif).to.include("T6API2");
			expect(response.body.adif).to.include("<EOH>");
			// lastfetchedid is the goalpost for the next incremental pull.
			expect(Number(response.body.lastfetchedid)).to.be.greaterThan(0);
		});
	});

	it("POST /api/get_contacts_adif exports QSOs as JSON", () => {
		cy.apiPost("get_contacts_adif", {
			key: rwKey,
			station_id: STATION_PROFILE_ID,
			fetchfromid: 0,
			output_format: "json",
			fields: ["CALL", "BAND", "MODE"],
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body.qsos).to.be.an("array").and.to.have.length.greaterThan(0);
			// With "fields" the rows carry exactly the requested keys. The order
			// follows the model's own field list, not the requested one, so
			// compare the sets.
			expect(Object.keys(response.body.qsos[0]).sort())
				.to.deep.eq(["BAND", "CALL", "MODE"]);
			expect(response.body.exported_records).to.eq(response.body.qsos.length);
		});
	});

	it("POST /api/get_contacts_adif rejects an unknown field", () => {
		cy.apiPost("get_contacts_adif", {
			key: rwKey,
			station_id: STATION_PROFILE_ID,
			fetchfromid: 0,
			output_format: "json",
			fields: ["NOSUCHFIELD"],
		}, { failOnStatusCode: false }).then((response) => {
			expect(response.status).to.eq(400);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("POST /api/get_contacts_adif rejects a foreign station_id", () => {
		cy.apiPost("get_contacts_adif", {
			key: rwKey,
			station_id: 99999,
			fetchfromid: 0,
		}, { failOnStatusCode: false }).then((response) => {
			expect(response.status).to.eq(401);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("POST /api/logbook_check_grid finds a worked grid", () => {
		// Log a QSO carrying a gridsquare first, so the lookup has something to
		// find. Without it the endpoint could only be asserted loosely.
		const adif =
			"<call:6>T6API5<gridsquare:4>JO22<qso_date:8>20240102<time_on:4>1206<band:3>20m<mode:3>SSB<eor>";

		cy.apiPost("qso", {
			key: rwKey,
			station_profile_id: STATION_PROFILE_ID,
			type: "adif",
			string: adif,
		}).its("status").should("eq", 201);

		cy.apiPost("logbook_check_grid", {
			key: rwKey,
			logbook_public_slug: env_stationsetup.public_slug,
			grid: "JO22",
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body.gridsquare).to.eq("JO22");
			expect(response.body.result).to.eq("Found");
		});
	});

	it("POST /api/logbook_check_grid reports an unworked grid", () => {
		cy.apiPost("logbook_check_grid", {
			key: rwKey,
			logbook_public_slug: env_stationsetup.public_slug,
			grid: "AA00",
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body.gridsquare).to.eq("AA00");
			expect(response.body.result).to.eq("Not Found");
		});
	});

	it("POST /api/logbook_get_worked_grids lists the worked grids", () => {
		cy.apiPost("logbook_get_worked_grids", {
			key: rwKey,
			logbook_id: LOGBOOK_ID,
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body).to.be.an("array");
			// JO22 was logged by the check_grid test above.
			expect(response.body.map((g) => String(g).toUpperCase()))
				.to.include("JO22");
		});
	});

	it("POST /api/logbook_get_worked_grids rejects a foreign logbook with 403", () => {
		cy.apiPost("logbook_get_worked_grids", {
			key: rwKey,
			logbook_id: 99999,
		}, { failOnStatusCode: false }).then((response) => {
			expect(response.status).to.eq(403);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("POST /api/lookup resolves DXCC data for a callsign", () => {
		// The lookup endpoint is what DXClusterAPI calls. It resolves the DXCC
		// entity plus its coordinates; the worked-before flag comes from the
		// key owner's own log.
		cy.apiPost("lookup", { key: rwKey, callsign: "T6API2" }).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body.callsign).to.eq("T6API2");
			expect(response.body).to.have.property("dxcc_id");
			expect(response.body.dxcc_lat, "dxcc latitude").to.not.eq("");
			expect(response.body.dxcc_long, "dxcc longitude").to.not.eq("");
			expect(response.body).to.have.property("workedBefore", true);
		});
	});

	it("POST /api/get_wp_stats returns statistics for an own station", () => {
		cy.apiPost("get_wp_stats", {
			key: rwKey,
			station_id: STATION_PROFILE_ID,
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.have.property("status", "successful");
			expect(response.body.statistics).to.have.property("totalalltime");
			expect(response.body.statistics).to.have.property("totalthisyear");
			expect(response.body.statistics.totalgroupedmodes).to.be.an("array");
		});
	});

	it("POST /api/get_wp_stats rejects a foreign station_id with 401", () => {
		cy.apiPost("get_wp_stats", {
			key: rwKey,
			station_id: 99999,
		}, { failOnStatusCode: false }).then((response) => {
			expect(response.status).to.eq(401);
			expect(response.body).to.have.property("status", "failed");
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

	// create_station runs last: it adds a station profile and therefore changes
	// what station_info returns. The profile is created inactive
	// (station_active = 0), so it does not affect the active logbook.
	it("POST /api/create_station/<key> creates a station profile", () => {
		const profileName = "CYPRESS_API_STATION";

		cy.request({
			method: "POST",
			url: `/index.php/api/create_station/${rwKey}`,
			body: {
				station_profile_name: profileName,
				station_callsign: "4W7EST/API",
				station_gridsquare: "JN47RI",
				station_dxcc: env_stationsetup.station_dxcc,
			},
		}).then((response) => {
			expect(response.status).to.eq(201);
			expect(response.body).to.have.property("status", "success");
		});

		// Verify through the read endpoint that the profile really landed.
		cy.request(`/index.php/api/station_info/${rwKey}`).then((response) => {
			const names = response.body.map((s) => s.station_profile_name);
			expect(names).to.include(profileName);
		});
	});

	it("POST /api/create_station rejects a read-only key with 403", () => {
		cy.request({
			method: "POST",
			url: `/index.php/api/create_station/${roKey}`,
			failOnStatusCode: false,
			body: {
				station_profile_name: "CYPRESS_API_STATION_RO",
				station_callsign: "4W7EST/RO",
			},
		}).then((response) => {
			expect(response.status).to.eq(403);
			expect(response.body).to.have.property("status", "error");
		});
	});

	it("GET /api/auth/<key> reports an invalid key as XML", () => {
		cy.request({
			url: "/index.php/api/auth/notavalidkey",
			failOnStatusCode: false,
		}).then((response) => {
			expect(response.headers["content-type"]).to.include("xml");
			// auth answers 200 even for a bad key; the verdict is in the body,
			// which carries a <message> instead of <status>/<rights>.
			expect(response.body).to.include("Key Invalid");
			expect(response.body).to.not.include("<status>Valid</status>");
		});
	});

	// Every JSON endpoint that takes the key in the body must reject a bogus
	// key with 401. Driven as a table so a new endpoint is one line to cover.
	// Two endpoints are deliberately absent: statistics answers 201 with zeroed
	// counters instead of 401 (backwards compatibility with older clients), and
	// lookup accepts an active session as an alternative to a key — cy.request
	// sends our login cookie, so it would authorize regardless of the key.
	[
		{ endpoint: "version", body: {} },
		{ endpoint: "get_wp_stats", body: { station_id: STATION_PROFILE_ID } },
		{ endpoint: "logbook_get_worked_grids", body: { logbook_id: LOGBOOK_ID } },
		{
			endpoint: "get_contacts_adif",
			body: { station_id: STATION_PROFILE_ID, fetchfromid: 0 },
		},
	].forEach(({ endpoint, body }) => {
		it(`POST /api/${endpoint} rejects a bogus key with 401`, () => {
			cy.apiPost(endpoint, { key: "notavalidkey", ...body }, {
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body).to.have.property("status", "failed");
			});
		});
	});

	it("GET /api/station_info rejects a bogus key with 401", () => {
		// station_info takes the key as a URL segment, not in the body.
		cy.request({
			url: "/index.php/api/station_info/notavalidkey",
			failOnStatusCode: false,
		}).then((response) => {
			expect(response.status).to.eq(401);
			expect(response.body).to.have.property("status", "failed");
		});
	});

	it("POST /api/qso reports errors for malformed ADIF instead of failing", () => {
		cy.apiPost("qso", {
			key: rwKey,
			station_profile_id: STATION_PROFILE_ID,
			type: "adif",
			// No <eor>, no length markers — nothing the parser can use.
			string: "this is not adif at all",
		}, { failOnStatusCode: false }).then((response) => {
			// Whatever the verdict, it must be a handled response, not a 500.
			expect(response.status).to.be.lessThan(500);
			expect(response.body.adif_count ?? 0).to.eq(0);
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

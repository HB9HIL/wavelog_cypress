// Wavelog ships two parallel APIs: the older v1 (RPC-style, key in the JSON body
// or as a URL segment, covered by 14-api_v1.cy.js) and the newer v2 (REST, Bearer
// token). This spec is the v2 contract: every resource and verb, the happy paths
// plus the auth/scope/validation error cases.
//
// v2 authenticates with a "wl2_" token, not the session cookie. There is no API
// endpoint to mint a token, so we create them once through the session-based UI
// controller (api_token/generate). That POST redirects back to /index.php/api,
// whose page reveals the freshly created plaintext token exactly once in the
// #newTokenValue input; we scrape it from the redirected HTML.

describe("API v2", () => {
	// The installer creates user_id 1 (an administrator) with a default, active
	// station location (station_profile_id 1). 02-stationsetup.cy.js adds a
	// second, non-active location. Ownership in v2 is derived from the token.
	const STATION_PROFILE_ID = 1;
	const API = "/index.php/api/v2";

	// Every scope the registry offers, for a token that can do everything.
	const ALL_SCOPES = [
		"qso:read", "qso:write", "qso:delete",
		"station:read", "station:write", "station:delete",
		"radio:read", "radio:write", "radio:delete",
		"statistic:read",
	];
	// A read-only token: reads succeed, writes/deletes must be refused.
	const READ_SCOPES = ["qso:read", "station:read", "radio:read", "statistic:read"];

	let fullKey; // token carrying ALL_SCOPES
	let roKey;   // token carrying READ_SCOPES

	// State handed between the ordered CRUD tests.
	let qsoId;
	let stationId;
	let radioId;

	// Mint a token through the web UI and return its plaintext value. The POST to
	// api_token/generate stores the token and flashes the plaintext; the followed
	// redirect renders /api with the one-time reveal modal we scrape here.
	function mintToken(name, scopes, expiry = "30") {
		const body = new URLSearchParams();
		body.append("token_name", name);
		body.append("expiry", expiry);
		scopes.forEach((s) => body.append("scopes[]", s));

		return cy
			.request({
				method: "POST",
				url: "/index.php/api_token/generate",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			})
			.then((response) => {
				expect(response.status, "generate token page").to.eq(200);
				const match = response.body.match(/id="newTokenValue"[^>]*value="(wl2_[0-9a-f]+)"/);
				expect(match, `plaintext token for "${name}"`).to.not.be.null;
				return match[1];
			});
	}

	// Authorization header helper.
	const auth = (token) => ({ Authorization: "Bearer " + token });

	before(() => {
		cy.setCookie("language", "english");
		cy.login();
		cy.getCookies().then((cookies) => {
			cy.writeFile("cypress/fixtures/cookies.json", cookies);
		});

		mintToken("cypress-v2-full", ALL_SCOPES).then((t) => (fullKey = t));
		mintToken("cypress-v2-readonly", READ_SCOPES).then((t) => (roKey = t));
	});

	beforeEach(() => {
		cy.readFile("cypress/fixtures/cookies.json").then((cookies) => {
			cookies.forEach((cookie) => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
	});

	// --- Meta endpoint (public, no auth) ----------------------------------

	describe("Meta", () => {
		it("GET /api/v2 returns the public status envelope", () => {
			cy.request(API).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.deep.include({
					name: "Wavelog API",
					status: "ok",
				});
			});
		});

		it("GET /api/v2/status is the same public meta endpoint", () => {
			cy.request(`${API}/status`).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.have.property("status", "ok");
			});
		});

		it("POST /api/v2/status is rejected with 405 and an Allow header", () => {
			cy.request({
				method: "POST",
				url: `${API}/status`,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(405);
				expect(response.body.error).to.have.property("code", "method_not_allowed");
				expect(response.headers).to.have.property("allow");
			});
		});

		it("OPTIONS preflight returns 204 with CORS headers", () => {
			cy.request({
				method: "OPTIONS",
				url: `${API}/qso`,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(204);
				expect(response.headers["access-control-allow-origin"]).to.eq("*");
				expect(response.headers["access-control-allow-methods"]).to.include("PATCH");
			});
		});
	});

	// --- Authentication & authorization -----------------------------------

	describe("Authentication", () => {
		it("rejects a request without a token (401 unauthorized)", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso`,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "unauthorized");
			});
		});

		it("rejects a non-wl2 / legacy token (401 invalid_token)", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso`,
				headers: auth("notavalidtoken"),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		it("rejects an unknown wl2 token (401 invalid_token)", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso`,
				headers: auth("wl2_" + "0".repeat(40)),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		it("accepts the token via the X-API-Key fallback header", () => {
			cy.request({
				method: "GET",
				url: `${API}/station`,
				headers: { "X-API-Key": fullKey },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array");
			});
		});

		it("rejects a write when the token lacks the scope (403 insufficient_scope)", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(roKey),
				body: {
					station_profile_id: STATION_PROFILE_ID,
					call: "V2SCOPE",
					band: "20m",
					mode: "SSB",
					qso_date: "2024-01-03",
					time_on: "1200",
				},
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
				expect(response.body.error.details).to.have.property("required_scope", "qso:write");
			});
		});

		it("returns 404 for an unknown resource", () => {
			cy.request({
				method: "GET",
				url: `${API}/nonexistent`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});
	});

	// --- QSOs resource (qso:read / qso:write / qso:delete) -----------------

	describe("QSOs", () => {
		it("POST /api/v2/qso creates a QSO (201 + Location)", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: {
					station_profile_id: STATION_PROFILE_ID,
					call: "V2API1",
					band: "20m",
					mode: "SSB",
					freq: 14075000,
					qso_date: "2024-01-02",
					time_on: "1210",
					rst_sent: "59",
					rst_rcvd: "57",
					gridsquare: "JN47",
					name: "Cypress",
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.headers).to.have.property("location");
				expect(response.headers.location).to.include("/api/v2/qso/");
				const qso = response.body.data;
				expect(qso.call).to.eq("V2API1");
				expect(qso.mode).to.eq("SSB");
				expect(Number(qso.freq)).to.eq(14075000);
				expect(qso.id).to.be.a("number");
				qsoId = qso.id;
			});
		});

		it("GET /api/v2/qso lists QSOs with pagination meta", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=100`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array").and.have.length.greaterThan(0);
				expect(response.body.meta).to.include({ page: 1, per_page: 100 });
				expect(response.body.meta.count).to.be.a("number");
			});
		});

		it("GET /api/v2/qso?band= filters by band", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?band=20m`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array");
				response.body.data.forEach((qso) => {
					expect(qso.band).to.eq("20m");
				});
			});
		});

		it("GET /api/v2/qso/{id} returns the single QSO", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso/${qsoId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.id).to.eq(qsoId);
				expect(response.body.data.call).to.eq("V2API1");
			});
		});

		it("PATCH /api/v2/qso/{id} updates only the given fields", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/qso/${qsoId}`,
				headers: auth(fullKey),
				body: { comment: "Patched by Cypress", rst_rcvd: "59" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.comment).to.eq("Patched by Cypress");
				expect(response.body.data.rst_rcvd).to.eq("59");
				// A field we did not send must be untouched.
				expect(response.body.data.call).to.eq("V2API1");
			});
		});

		it("PUT /api/v2/qso/{id} replaces the QSO", () => {
			cy.request({
				method: "PUT",
				url: `${API}/qso/${qsoId}`,
				headers: auth(fullKey),
				body: {
					call: "V2API1",
					band: "40m",
					mode: "CW",
					freq: 7030000,
					qso_date: "2024-01-02",
					time_on: "1215",
				},
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.band).to.eq("40m");
				expect(response.body.data.mode).to.eq("CW");
				// An optional field omitted on PUT is reset.
				expect(response.body.data.comment === "" || response.body.data.comment === null).to.eq(true);
			});
		});

		it("POST /api/v2/qso without a required field returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: {
					station_profile_id: STATION_PROFILE_ID,
					band: "20m",
					mode: "SSB",
					qso_date: "2024-01-02",
					time_on: "1220",
				}, // missing "call"
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details.missing).to.include("call");
			});
		});

		it("POST /api/v2/qso with a foreign station_profile_id returns 403", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: {
					station_profile_id: 999999,
					call: "V2API9",
					band: "20m",
					mode: "SSB",
					qso_date: "2024-01-02",
					time_on: "1221",
				},
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});

		it("POST /api/v2/qso with a non-scalar field returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: { station_profile_id: STATION_PROFILE_ID, nested: { a: 1 } },
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("POST /api/v2/qso with malformed JSON returns 400 invalid_json", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: { ...auth(fullKey), "content-type": "application/json" },
				failOnStatusCode: false,
				body: "{ not valid json",
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "invalid_json");
			});
		});

		it("PATCH /api/v2/qso without an id returns 404", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: { comment: "no id" },
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		it("DELETE /api/v2/qso/{id} removes the QSO (204)", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/qso/${qsoId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});
		});

		it("GET /api/v2/qso/{id} of a deleted QSO returns 404", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso/${qsoId}`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});
	});

	// --- Stations resource (station:read / station:write / station:delete) -

	describe("Stations", () => {
		const NEW_STATION = {
			name: "Cypress V2 Location",
			callsign: "V2/4W7EST",
			gridsquare: "JN47RI",
			dxcc: 287,
			cq: 14,
			itu: 28,
			power: 100,
		};

		it("GET /api/v2/station lists the owner's station locations", () => {
			cy.request({
				method: "GET",
				url: `${API}/station`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array").and.have.length.greaterThan(0);
				const active = response.body.data.find((s) => s.active === true);
				expect(active, "an active station exists").to.exist;
			});
		});

		it("GET /api/v2/station/{id} returns the default station", () => {
			cy.request({
				method: "GET",
				url: `${API}/station/${STATION_PROFILE_ID}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.id).to.eq(STATION_PROFILE_ID);
				expect(response.body.data).to.have.property("callsign");
			});
		});

		it("POST /api/v2/station creates a station (201 + Location)", () => {
			cy.request({
				method: "POST",
				url: `${API}/station`,
				headers: auth(fullKey),
				body: NEW_STATION,
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.headers.location).to.include("/api/v2/station/");
				const station = response.body.data;
				expect(station.name).to.eq(NEW_STATION.name);
				expect(station.callsign).to.eq(NEW_STATION.callsign);
				// A user with an existing active station: the new one is not active.
				expect(station.active).to.eq(false);
				expect(station.id).to.be.a("number");
				stationId = station.id;
			});
		});

		it("POST /api/v2/station with the same data returns 409 conflict", () => {
			cy.request({
				method: "POST",
				url: `${API}/station`,
				headers: auth(fullKey),
				body: NEW_STATION,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(409);
				expect(response.body.error).to.have.property("code", "conflict");
			});
		});

		it("POST /api/v2/station without required fields returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/station`,
				headers: auth(fullKey),
				body: { gridsquare: "JN47RI" }, // missing name + callsign
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("POST /api/v2/station with an invalid grid returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/station`,
				headers: auth(fullKey),
				body: { name: "Bad Grid", callsign: "V2/BAD", gridsquare: "ZZ99zz" },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("PATCH /api/v2/station/{id} updates the given fields", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/station/${stationId}`,
				headers: auth(fullKey),
				body: { power: 50, city: "Bonn" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.power).to.eq(50);
				expect(response.body.data.city).to.eq("Bonn");
			});
		});

		it("PUT /api/v2/station/{id} replaces the station", () => {
			cy.request({
				method: "PUT",
				url: `${API}/station/${stationId}`,
				headers: auth(fullKey),
				body: { name: "Cypress V2 Replaced", callsign: "V2/4W7EST", gridsquare: "JN48RI" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.name).to.eq("Cypress V2 Replaced");
				expect(response.body.data.gridsquare).to.eq("JN48RI");
				// power was set on PATCH; PUT omits it, so it is reset.
				expect(response.body.data.power === null || response.body.data.power === 0).to.eq(true);
			});
		});

		it("DELETE /api/v2/station/{id} of the active station returns 409", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/station/${STATION_PROFILE_ID}`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(409);
				expect(response.body.error).to.have.property("code", "conflict");
			});
		});

		it("DELETE /api/v2/station/{id} removes the created station (204)", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/station/${stationId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});
		});

		it("GET /api/v2/station/{id} of a deleted station returns 404", () => {
			cy.request({
				method: "GET",
				url: `${API}/station/${stationId}`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});
	});

	// --- Radios resource (radio:read / radio:write / radio:delete) ---------

	describe("Radios", () => {
		const RADIO_NAME = "Cypress-Rig";

		it("POST /api/v2/radio creates a radio (201 + Location)", () => {
			cy.request({
				method: "POST",
				url: `${API}/radio`,
				headers: auth(fullKey),
				body: { radio: RADIO_NAME, frequency: 14075000, mode: "SSB", power: 100 },
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.headers.location).to.include("/api/v2/radio/");
				const radio = response.body.data;
				expect(radio.radio).to.eq(RADIO_NAME);
				expect(radio.frequency).to.eq(14075000);
				expect(radio.mode).to.eq("SSB");
				expect(radio.id).to.be.a("number");
				radioId = radio.id;
			});
		});

		it("POST /api/v2/radio with an existing name upserts (200)", () => {
			cy.request({
				method: "POST",
				url: `${API}/radio`,
				headers: auth(fullKey),
				body: { radio: RADIO_NAME, frequency: 7030000, mode: "CW", power: 50 },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.id).to.eq(radioId);
				expect(response.body.data.frequency).to.eq(7030000);
				expect(response.body.data.mode).to.eq("CW");
			});
		});

		it("GET /api/v2/radio lists the owner's radios", () => {
			cy.request({
				method: "GET",
				url: `${API}/radio`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array");
				const mine = response.body.data.find((r) => r.id === radioId);
				expect(mine, "created radio is listed").to.exist;
			});
		});

		it("GET /api/v2/radio/{id} returns the single radio", () => {
			cy.request({
				method: "GET",
				url: `${API}/radio/${radioId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.id).to.eq(radioId);
				expect(response.body.data.radio).to.eq(RADIO_NAME);
			});
		});

		it("POST /api/v2/radio without the radio name returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/radio`,
				headers: auth(fullKey),
				body: { frequency: 14075000 },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("PATCH /api/v2/radio/{id} is not supported (405)", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/radio/${radioId}`,
				headers: auth(fullKey),
				body: { mode: "FT8" },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(405);
				expect(response.body.error).to.have.property("code", "method_not_allowed");
			});
		});

		it("GET /api/v2/radio/{id} of an unknown radio returns 404", () => {
			cy.request({
				method: "GET",
				url: `${API}/radio/999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		it("DELETE /api/v2/radio/{id} removes the radio (204)", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/radio/${radioId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});
		});
	});

	// --- Statistic resource (statistic:read, read-only) --------------------

	describe("Statistics", () => {
		it("GET /api/v2/statistic returns the qso topic by default", () => {
			cy.request({
				method: "GET",
				url: `${API}/statistic`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("profile", "qso");
				const qso = response.body.data.qso;
				expect(qso).to.have.property("total");
				expect(Number(qso.total)).to.be.a("number");
				expect(qso.activity).to.have.all.keys("today", "month", "year");
				expect(qso.breakdown).to.have.all.keys("by_band", "by_mode");
				expect(qso.confirmations).to.have.all.keys("lotw", "eqsl", "qsl");
				expect(qso.dxcc).to.have.all.keys("worked", "confirmed", "available");
			});
		});

		it("GET /api/v2/statistic?profile=full returns every permitted topic", () => {
			cy.request({
				method: "GET",
				url: `${API}/statistic?profile=full`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("profile", "full");
				expect(response.body.data).to.have.property("qso");
			});
		});

		it("GET /api/v2/statistic?profile=system returns instance info for an admin", () => {
			// user_id 1 is an administrator, so the admin-only system topic is
			// available and meta.admin is true.
			cy.request({
				method: "GET",
				url: `${API}/statistic?profile=system`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("admin", true);
				expect(response.body.data.system).to.have.property("wavelog");
				expect(response.body.data.system).to.have.property("php");
			});
		});

		it("GET /api/v2/statistic?profile=bogus returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/statistic?profile=bogus`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("POST /api/v2/statistic is refused: the resource is read-only (403)", () => {
			// There is no statistics:write scope, so any write verb is rejected at
			// the scope check before it reaches a handler.
			cy.request({
				method: "POST",
				url: `${API}/statistic`,
				headers: auth(fullKey),
				body: {},
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
			});
		});
	});
});

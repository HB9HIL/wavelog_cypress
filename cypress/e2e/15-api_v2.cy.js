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
		"lookup:read", "club:read",
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
				// Pagination totals let a client find the last page without probing.
				expect(response.body.meta.total).to.be.a("number");
				expect(response.body.meta.total_pages).to.be.a("number");
				expect(response.body.meta).to.have.property("has_more");
			});
		});

		it("GET /api/v2/qso pagination reports total_pages and has_more", () => {
			// Page 1 of 1-per-page: if there is more than one QSO, has_more is true
			// and total_pages equals total; the last page reports has_more false.
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=1&page=1`,
				headers: auth(fullKey),
			}).then((response) => {
				const meta = response.body.meta;
				expect(meta.total_pages).to.eq(meta.total);
				expect(meta.has_more).to.eq(meta.total > 1);

				// Fetch the last page and confirm has_more flips to false.
				cy.request({
					method: "GET",
					url: `${API}/qso?per_page=1&page=${meta.total_pages}`,
					headers: auth(fullKey),
				}).then((last) => {
					expect(last.body.meta.has_more).to.eq(false);
				});
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

	// --- QSO ADIF import & export (qso:write / qso:read) -------------------

	describe("QSO ADIF", () => {
		const ADIF_CALL = "V2ADIF1";
		// A single, self-contained ADIF record. Lengths must match the values.
		const ADIF = `<CALL:${ADIF_CALL.length}>${ADIF_CALL}<QSO_DATE:8>20240104<TIME_ON:4>1230<BAND:3>20m<MODE:3>FT8<EOR>`;

		it("POST import_type=adif with dryrun parses without importing", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: {
					import_type: "adif",
					station_profile_id: STATION_PROFILE_ID,
					dryrun: true,
					adif: ADIF,
				},
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.include({ dryrun: true, parsed: 1 });
			});
		});

		it("POST import_type=adif imports the QSO (201)", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: {
					import_type: "adif",
					station_profile_id: STATION_PROFILE_ID,
					adif: ADIF,
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.parsed).to.eq(1);
				expect(response.body.data.imported).to.eq(1);
				expect(response.body.data.skipped).to.eq(0);
			});
		});

		it("POST import_type=adif again skips the duplicate", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: {
					import_type: "adif",
					station_profile_id: STATION_PROFILE_ID,
					adif: ADIF,
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.imported).to.eq(0);
				expect(response.body.data.skipped).to.eq(1);
			});
		});

		it("GET /api/v2/qso?format=adif exports incrementally", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?format=adif&since_id=0&station_id=${STATION_PROFILE_ID}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.have.property("lastfetchedid");
				expect(response.body.data.exported).to.be.a("number").and.to.be.greaterThan(0);
				expect(response.body.data.adif).to.be.a("string").and.to.include(ADIF_CALL);
				// ADIF shares the list's pagination meta.
				expect(response.body.meta).to.have.property("total");
				expect(response.body.meta).to.have.property("has_more");
			});
		});

		it("GET /api/v2/qso per_page is honoured up to the 5000 cap (both formats)", () => {
			// Both JSON and ADIF share a 5000 max; an over-large per_page clamps.
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=1000`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta.per_page).to.eq(1000);
			});
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=99999`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta.per_page).to.eq(5000);
			});
			cy.request({
				method: "GET",
				url: `${API}/qso?format=adif&per_page=99999`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta.per_page).to.eq(5000);
			});
		});

		it("GET /api/v2/qso?limit= returns the newest N QSOs", () => {
			// limit=1 must return exactly the newest QSO, matching page 1 of a
			// per_page=1 request (both are newest-first).
			cy.request({
				method: "GET",
				url: `${API}/qso?limit=1`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.have.length(1);
				expect(response.body.meta.per_page).to.eq(1);
				const newest = response.body.data[0].id;

				cy.request({
					method: "GET",
					url: `${API}/qso?per_page=1&page=1`,
					headers: auth(fullKey),
				}).then((cmp) => {
					expect(cmp.body.data[0].id).to.eq(newest);
				});
			});
		});

		it("GET /api/v2/qso?limit=0 returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?limit=0`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("GET /api/v2/qso applies the common filters (json)", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?station_id=${STATION_PROFILE_ID}&since_id=0&band=20m&per_page=5`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array");
				expect(response.body.meta.total).to.be.a("number");
				response.body.data.forEach((qso) => expect(qso.band).to.eq("20m"));
			});
		});

		it("GET /api/v2/qso?mode= filters by mode or submode", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?mode=SSB&per_page=5`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array");
				// Every row matches on the main mode or the submode.
				response.body.data.forEach((qso) =>
					expect(qso.mode === "SSB" || qso.submode === "SSB").to.eq(true)
				);
			});
		});

		it("GET /api/v2/qso?station_id= of a foreign station returns 403", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?station_id=999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});

		it("GET /api/v2/qso?since_id=abc returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?since_id=abc`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("GET /api/v2/qso?qsl_filter=bogus returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?qsl_filter=bogus`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("POST with an unknown import_type returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: { import_type: "xml", station_profile_id: STATION_PROFILE_ID },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("GET /api/v2/qso?format=bogus returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/qso?format=bogus`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		after(() => {
			// Remove the imported QSO so re-runs start clean.
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=500`,
				headers: auth(fullKey),
			}).then((response) => {
				const hit = response.body.data.find((q) => q.call === ADIF_CALL);
				if (hit) {
					cy.request({
						method: "DELETE",
						url: `${API}/qso/${hit.id}`,
						headers: auth(fullKey),
					});
				}
			});
		});
	});

	// --- QSO bulk JSON import (qso:write) ----------------------------------

	describe("QSO JSON bulk", () => {
		const CALLS = ["V2JB1", "V2JB2"];
		const qsos = [
			{ call: CALLS[0], band: "20m", mode: "FT8", qso_date: "2024-02-01", time_on: "1200" },
			{ call: CALLS[1], band: "40m", mode: "CW", qso_date: "2024-02-01", time_on: "1201" },
		];

		it("POST with a qsos array and dryrun validates without importing", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: { station_profile_id: STATION_PROFILE_ID, dryrun: true, qsos },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.include({ dryrun: true, parsed: 2 });
			});
		});

		it("POST with a qsos array imports them all (201)", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				body: { station_profile_id: STATION_PROFILE_ID, qsos },
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.parsed).to.eq(2);
				expect(response.body.data.imported).to.eq(2);
			});
		});

		it("POST with a missing field flags the offending row index (400)", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: {
					station_profile_id: STATION_PROFILE_ID,
					qsos: [
						{ call: "V2JBOK", band: "20m", mode: "FT8", qso_date: "2024-02-01", time_on: "1200" },
						{ band: "40m", mode: "CW", qso_date: "2024-02-01", time_on: "1201" }, // no call
					],
				},
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details).to.have.property("index", 1);
			});
		});

		it("POST with an empty qsos array returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
				body: { station_profile_id: STATION_PROFILE_ID, qsos: [] },
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		after(() => {
			// Remove the imported bulk QSOs so re-runs start clean.
			cy.request({
				method: "GET",
				url: `${API}/qso?per_page=500`,
				headers: auth(fullKey),
			}).then((response) => {
				response.body.data
					.filter((q) => CALLS.includes(q.call))
					.forEach((q) =>
						cy.request({ method: "DELETE", url: `${API}/qso/${q.id}`, headers: auth(fullKey) })
					);
			});
		});
	});

	// --- Lookup resource (lookup:read, read-only) --------------------------

	describe("Lookup", () => {
		it("GET /api/v2/lookup/{callsign} returns full DXCC data with full detail", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup/DL1ABC?detail=full`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("detail", "full");
				expect(response.body.data).to.have.property("callsign", "DL1ABC");
				expect(response.body.data).to.have.property("dxcc");
				// Full detail exposes the per-band/mode worked flags.
				expect(response.body.data).to.have.property("call_worked");
			});
		});

		it("GET /api/v2/lookup/{callsign} default detail omits the QSO history", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup/DL1ABC`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("detail", "basic");
				expect(response.body.data).to.have.property("workedBefore");
				expect(response.body.data).to.not.have.property("call_worked");
			});
		});

		it("GET /api/v2/lookup/{callsign}?detail=bogus returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup/DL1ABC?detail=bogus`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("GET /api/v2/lookup?callsign= works and handles a slashed callsign", () => {
			// A "/" callsign can't be a path segment (encoded slashes are rejected),
			// so the query form is the way to look these up.
			cy.request({
				method: "GET",
				url: `${API}/lookup?callsign=${encodeURIComponent("DL1ABC/P")}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.have.property("callsign", "DL1ABC/P");
				expect(response.body.data).to.have.property("dxcc");
			});
		});

		it("GET /api/v2/lookup?grid= reports a grid worked/confirmed result", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup?grid=JN47`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.meta).to.have.property("type", "grid");
				expect(response.body.data).to.have.property("gridsquare", "JN47");
				expect(["Not Found", "Found", "Worked", "Confirmed"]).to.include(
					response.body.data.result
				);
			});
		});

		it("GET /api/v2/lookup?grid=&logbook_id= of a foreign logbook returns 403", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup?grid=JN47&logbook_id=999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});

		it("GET /api/v2/lookup without a callsign or grid returns 400", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("is refused for a token without lookup:read (403)", () => {
			cy.request({
				method: "GET",
				url: `${API}/lookup/DL1ABC`,
				headers: auth(roKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
			});
		});
	});

	// --- Club resource (club:read, read-only) ------------------------------

	describe("Club", () => {
		it("GET /api/v2/club is refused for a non-officer/personal token (403)", () => {
			// The test user's token is personal (owner == creator), so it is never a
			// club officer and the endpoint refuses it.
			cy.request({
				method: "GET",
				url: `${API}/club`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});
	});

	// --- Token resource (whoami, no scope) ---------------------------------

	describe("Token", () => {
		it("GET /api/v2/token returns the current token's metadata", () => {
			cy.request({
				method: "GET",
				url: `${API}/token`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.have.property("id");
				expect(response.body.data).to.have.property("owner");
				expect(response.body.data.scopes).to.be.an("array").and.to.include("qso:read");
				expect(response.body.data).to.have.property("expires_at");
			});
		});

		it("GET /api/v2/token needs no particular scope (read-only token works)", () => {
			cy.request({
				method: "GET",
				url: `${API}/token`,
				headers: auth(roKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.scopes).to.be.an("array");
			});
		});

		it("GET /api/v2/token without a token returns 401", () => {
			cy.request({
				method: "GET",
				url: `${API}/token`,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "unauthorized");
			});
		});
	});
});

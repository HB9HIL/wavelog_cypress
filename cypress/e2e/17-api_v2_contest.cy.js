// API v2 - contest sessions.
//
// The contest resource is the API side of the Contesting module: it manages
// contest *sessions* (one contest run with its exchange settings) and which
// QSOs belong to them, so an external logger or an offline mirror can
// replicate a session instead of rebuilding it through "Import Historical
// Contests".
//
// Two things set it apart from the other v2 resources:
//
//   - The contest is addressed by its ADIF name ("contest"), because the
//     numeric catalog ids are instance-local. The ids and names used here are
//     the ones the installer seeds from install/assets/install.sql.
//   - Linking a QSO also maintains COL_CONTEST_ID on the QSO row, which is
//     what the ADIF export, the contest import and the logbook filters read.
//     No v2 resource exposes that column as a field, so this spec asserts it
//     through the ADIF export of the QSO resource.
//
// The clubstation rules of this resource (officer level for the session
// itself, own QSOs only for a member) live in 16-api_v2_clubstation.cy.js,
// next to the club fixture they need.

describe("API v2 - Contest sessions", () => {
	const API = "/index.php/api/v2";
	// The installer's default station location, owned by user_id 1.
	const STATION_PROFILE_ID = 1;

	// Catalog entries from install/assets/install.sql; ids are stable there,
	// but the API is driven by the ADIF name on purpose.
	const CONTEST = "070-PSKFEST";
	const CONTEST_NAME = "PODXS PSKFest";
	const CONTEST_CATALOG_ID = 7;
	const OTHER_CONTEST = "DARC-WAG";
	const OTHER_CONTEST_NAME = "DARC Worked All Germany";

	// Everything this spec needs, in one token.
	const FULL_SCOPES = [
		"contest:read", "contest:write", "contest:delete",
		"qso:read", "qso:write", "qso:delete",
		"station:read",
	];
	// Full contest rights, but no power over the logbook: the token that must
	// be refused when a session delete is asked to remove the QSOs as well.
	const CONTEST_SCOPES = [
		"contest:read", "contest:write", "contest:delete",
		"qso:read", "station:read",
	];
	const READ_SCOPES = ["contest:read", "station:read"];

	let fullKey;    // FULL_SCOPES
	let contestKey; // CONTEST_SCOPES
	let roKey;      // READ_SCOPES

	// State handed between the ordered tests.
	let sessionId;  // the session the link tests work on
	let qsoA;       // linked to sessionId
	let qsoB;       // parked in a second session, to be refused as "skipped"
	let qsoC;       // used for the delete_qsos teardown
	let otherSessionId;

	const auth = (token) => ({ Authorization: "Bearer " + token });

	function expectCommonMeta(response, method = "GET") {
		expect(response.body).to.have.property("meta");
		expect(response.body.meta).to.have.property("resource", "contest");
		expect(response.body.meta).to.have.property("method", method);
		expect(Date.parse(response.body.meta.timestamp), "ISO timestamp").to.not.satisfy(Number.isNaN);
	}

	// A QSO of the token owner, to be linked into a session.
	function logQso(call, time) {
		return cy.request({
			method: "POST",
			url: `${API}/qso`,
			headers: auth(fullKey),
			body: {
				station_profile_id: STATION_PROFILE_ID,
				call: call,
				band: "20m",
				mode: "SSB",
				qso_date: "2024-03-01",
				time_on: time,
			},
		}).then((response) => {
			expect(response.status, `log ${call}`).to.eq(201);
			return response.body.data.id;
		});
	}

	// The error cases outnumber the happy ones here, so the helper never fails
	// on the status code; every caller asserts it.
	function createSession(body, token = fullKey) {
		return cy.request({
			method: "POST",
			url: `${API}/contest`,
			headers: auth(token),
			failOnStatusCode: false,
			body: {
				contest: CONTEST,
				time_start: "2024-03-01 10:00",
				time_end: "2024-03-01 18:00",
				station_id: STATION_PROFILE_ID,
				...body,
			},
		});
	}

	// The ADIF export is the only place the API shows COL_CONTEST_ID.
	function adifOf(call) {
		return cy.request({
			url: `${API}/qso?callsign=${call}&format=adif`,
			headers: auth(fullKey),
		}).then((response) => {
			expect(response.status).to.eq(200);
			return (response.body.data.adif || "").toUpperCase();
		});
	}

	before(() => {
		cy.setCookie("language", "english");
		cy.login();

		cy.createApiToken("cypress-v2-contest-full", FULL_SCOPES).then((t) => (fullKey = t));
		cy.createApiToken("cypress-v2-contest-only", CONTEST_SCOPES).then((t) => (contestKey = t));
		cy.createApiToken("cypress-v2-contest-readonly", READ_SCOPES).then((t) => (roKey = t));

		cy.then(() => {
			logQso("V2CONT1", "1000").then((id) => (qsoA = id));
			logQso("V2CONT2", "1010").then((id) => (qsoB = id));
			logQso("V2CONT3", "1020").then((id) => (qsoC = id));
		});
	});

	// --- Creating sessions --------------------------------------------------

	describe("Create", () => {
		it("POST /api/v2/contest creates a session (201 + Location)", () => {
			createSession({ comment: "Cypress contest run" }).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.headers.location).to.include("/api/v2/contest/");
				expectCommonMeta(response, "POST");

				const session = response.body.data;
				expect(session.id).to.be.a("number");
				// Both names travel: the ADIF name is the stable handle, the
				// display name saves the client a catalog lookup.
				expect(session.contest).to.eq(CONTEST);
				expect(session.contest_name).to.eq(CONTEST_NAME);
				expect(session.station_id).to.eq(STATION_PROFILE_ID);
				expect(session.comment).to.eq("Cypress contest run");
				expect(session.qso_count).to.eq(0);
				expect(session.created_at).to.be.a("string");
				expect(session.updated_at).to.be.a("string");

				// The settings come back merged over the module defaults, so a
				// client never has to know which keys the instance stored.
				expect(session.settings).to.deep.include({
					exchangetype: "Serial",
					copyexchangeto: "",
					callbook_lookup: true,
					custom_name: "",
					serial_per_band: false,
					serial_scope: "station",
				});
				expect(session.settings.exchangefields).to.deep.eq(["serial"]);

				sessionId = session.id;
			});
		});

		it("POST /api/v2/contest accepts contest_id instead of the ADIF name", () => {
			cy.request({
				method: "POST",
				url: `${API}/contest`,
				headers: auth(fullKey),
				body: {
					contest_id: CONTEST_CATALOG_ID,
					time_start: "2024-03-02 10:00",
					time_end: "2024-03-02 18:00",
					station_id: STATION_PROFILE_ID,
					comment: "Cypress by catalog id",
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.contest).to.eq(CONTEST);
				// Kept: the "skipped" case below needs a second session.
				otherSessionId = response.body.data.id;
			});
		});

		it("POST /api/v2/contest derives exchangetype from the exchange fields", () => {
			// exchangetype is legacy state the logging engine reads; deriving it
			// keeps it from contradicting the fields it is supposed to describe.
			// A value sent by the client is overwritten rather than trusted.
			createSession({
				comment: "Cypress derived type",
				settings: { exchangetype: "Exchange", exchangefields: ["serial", "gridsquare"] },
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.settings.exchangetype).to.eq("Serialgridsquare");
				expect(response.body.data.settings.exchangefields).to.deep.eq(["serial", "gridsquare"]);

				cy.request({
					method: "DELETE",
					url: `${API}/contest/${response.body.data.id}`,
					headers: auth(fullKey),
				});
			});
		});

		it("POST /api/v2/contest without the required fields returns 400", () => {
			cy.request({
				method: "POST",
				url: `${API}/contest`,
				headers: auth(fullKey),
				body: { comment: "nothing else" },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details.missing).to.include("contest");
			});
		});

		it("POST /api/v2/contest with an unknown contest returns 400", () => {
			createSession({ contest: "NO-SUCH-CONTEST" }).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details).to.have.property("field", "contest");
			});
		});

		it("POST /api/v2/contest with a malformed datetime returns 400", () => {
			createSession({ time_start: "01.03.2024 10:00" }).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details).to.have.property("format", "YYYY-MM-DD HH:MM[:SS]");
			});
		});

		it("POST /api/v2/contest with a foreign station_id returns 403", () => {
			createSession({ station_id: 999999 }).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});

		it("POST /api/v2/contest reports every bad settings value at once", () => {
			createSession({
				settings: { nope: 1, serial_scope: "whatever", callbook_lookup: "yes" },
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				// One message per problem, so a client can fix the whole object in
				// one round trip instead of discovering the errors one by one.
				expect(response.body.error.details.errors).to.have.length(3);
			});
		});

		// The catalog knows deactivated contests; the session form only offers the
		// active ones. Without the same rule the API would accept a contest the UI
		// cannot pick, and the COL_CONTEST_ID maintenance would then silently write
		// an empty value on every link.
		it("POST /api/v2/contest with a deactivated contest returns 400", () => {
			cy.login();
			cy.request({
				method: "POST",
				url: "/index.php/contest_admin/deactivate",
				form: true,
				body: { id: CONTEST_CATALOG_ID },
			}).then((response) => {
				expect(response.status, "deactivate the contest").to.eq(200);
			});

			createSession({ comment: "should never be created" }).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.message).to.contain("not active");
			});

			// Same rule for the numeric handle.
			cy.request({
				method: "POST",
				url: `${API}/contest`,
				headers: auth(fullKey),
				body: {
					contest_id: CONTEST_CATALOG_ID,
					time_start: "2024-03-02 10:00",
					time_end: "2024-03-02 18:00",
					station_id: STATION_PROFILE_ID,
				},
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error.details).to.have.property("field", "contest_id");
			});

			cy.request({
				method: "POST",
				url: "/index.php/contest_admin/activate",
				form: true,
				body: { id: CONTEST_CATALOG_ID },
			}).then((response) => {
				expect(response.status, "activate the contest again").to.eq(200);
			});
		});

		// The link list is validated before the session is written. Were it the
		// other way round, a rejected list would leave an empty session behind
		// that the client believes it never created.
		it("POST /api/v2/contest with an unusable qso_ids leaves no session behind", () => {
			cy.request({ url: `${API}/contest`, headers: auth(fullKey) }).then((before) => {
				const countBefore = before.body.data.length;

				createSession({ qso_ids: [999999] }).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error).to.have.property("code", "forbidden");
					expect(response.body.error.details.qso_ids).to.include(999999);

					cy.request({ url: `${API}/contest`, headers: auth(fullKey) }).then((after) => {
						expect(after.body.data.length, "session count unchanged").to.eq(countBefore);
					});
				});
			});
		});
	});

	// --- Reading ------------------------------------------------------------

	describe("Read", () => {
		it("GET /api/v2/contest lists the owner's sessions", () => {
			cy.request({ url: `${API}/contest`, headers: auth(fullKey) }).then((response) => {
				expect(response.status).to.eq(200);
				expectCommonMeta(response, "GET");
				expect(response.body.data).to.be.an("array");
				const mine = response.body.data.find((s) => s.id === sessionId);
				expect(mine, "created session is listed").to.exist;
				expect(mine.contest).to.eq(CONTEST);
			});
		});

		it("GET /api/v2/contest/{id} carries the linked QSO ids", () => {
			cy.request({ url: `${API}/contest/${sessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.id).to.eq(sessionId);
				// The ids are the QSO resource's, so a client can mirror the
				// linkage without a second lookup. Nothing is linked yet.
				expect(response.body.data.qso_ids).to.deep.eq([]);
			});
		});

		it("GET /api/v2/contest?since_id= only returns newer sessions", () => {
			cy.request({
				url: `${API}/contest?since_id=${sessionId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(200);
				const ids = response.body.data.map((s) => s.id);
				expect(ids).to.not.include(sessionId);
				ids.forEach((id) => expect(id).to.be.greaterThan(sessionId));
			});

			cy.request({
				url: `${API}/contest?since_id=${sessionId - 1}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.body.data.map((s) => s.id)).to.include(sessionId);
			});
		});

		it("GET /api/v2/contest?station_id= of a foreign station returns 403", () => {
			cy.request({
				url: `${API}/contest?station_id=999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});

		it("GET /api/v2/contest/{id} of an unknown session returns 404", () => {
			cy.request({
				url: `${API}/contest/999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		it("GET /api/v2/contest/{id} with a non-numeric id returns 400", () => {
			cy.request({
				url: `${API}/contest/abc`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});
	});

	// --- Editing the session ------------------------------------------------

	describe("Update", () => {
		it("PATCH /api/v2/contest/{id} changes only the given fields", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { comment: "Patched by Cypress" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.comment).to.eq("Patched by Cypress");
				// Untouched fields survive: there is no PUT anywhere in v2.
				expect(response.body.data.contest).to.eq(CONTEST);
				expect(response.body.data.time_start).to.eq("2024-03-01 10:00:00");
			});
		});

		it("PATCH /api/v2/contest/{id} merges settings over the stored ones", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { settings: { custom_name: "Cypress Run" } },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.settings.custom_name).to.eq("Cypress Run");
			});

			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { settings: { serial_per_band: true } },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.settings.serial_per_band).to.eq(true);
				// A sparse settings object patches, it does not replace.
				expect(response.body.data.settings.custom_name).to.eq("Cypress Run");
			});
		});

		it("PATCH /api/v2/contest/{id} can move the session to another contest", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { contest: OTHER_CONTEST },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.contest).to.eq(OTHER_CONTEST);
				expect(response.body.data.contest_name).to.eq(OTHER_CONTEST_NAME);
			});

			// Back, so the link tests below assert against the contest this spec
			// started with.
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { contest: CONTEST },
			}).then((response) => {
				expect(response.body.data.contest).to.eq(CONTEST);
			});
		});

		it("PATCH /api/v2/contest/{id} with nothing to change returns 400", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: {},
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("PATCH /api/v2/contest/{id} rejects a bad settings value", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { settings: { copyexchangeto: "pwnd" } },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});
	});

	// --- Linking QSOs -------------------------------------------------------

	describe("QSO links", () => {
		it("PATCH link_qso_ids attaches a QSO to the session", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: [qsoA] },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.linked).to.eq(1);
				expect(response.body.data.skipped).to.deep.eq([]);
				expect(response.body.data.qso_count).to.eq(1);
			});

			cy.request({ url: `${API}/contest/${sessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.body.data.qso_ids).to.deep.eq([qsoA]);
			});
		});

		// The whole point of the resource: the QSO row itself has to carry the
		// contest, as the ADIF *name*. Anything else and the ADIF export, the
		// contest import on the mirror side and the logbook filters all miss it.
		it("linking stamps the ADIF contest name onto the QSO", () => {
			adifOf("V2CONT1").then((adif) => {
				expect(adif).to.contain("CONTEST_ID");
				expect(adif).to.contain(CONTEST);
				// Not the display name - that would match no consumer at all.
				expect(adif).to.not.contain(CONTEST_NAME.toUpperCase());
			});
		});

		it("re-sending the same id is an idempotent no-op", () => {
			// A sync client re-sends its full list; the second run must not create
			// a duplicate link or report work it did not do.
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: [qsoA] },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.linked).to.eq(0);
				expect(response.body.data.skipped).to.deep.eq([]);
				expect(response.body.data.qso_count).to.eq(1);
			});
		});

		it("a QSO of another session is skipped, not stolen", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${otherSessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: [qsoB] },
			}).then((response) => {
				expect(response.body.data.linked).to.eq(1);
			});

			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: [qsoB] },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.linked).to.eq(0);
				expect(response.body.data.skipped).to.deep.eq([qsoB]);
			});

			// Still where it was.
			cy.request({ url: `${API}/contest/${otherSessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.body.data.qso_ids).to.deep.eq([qsoB]);
			});
		});

		// Same guard as on create: the link list is checked before anything is
		// written, so a rejected request leaves no half-applied update.
		it("PATCH with an inaccessible QSO id changes nothing (403)", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { comment: "must not land", link_qso_ids: [999999] },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});

			cy.request({ url: `${API}/contest/${sessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.body.data.comment).to.eq("Patched by Cypress");
			});
		});

		it("PATCH with a non-numeric QSO id returns 400", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: ["abc"] },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("PATCH unlink_qso_ids detaches the QSO and clears its contest", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { unlink_qso_ids: [qsoA] },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.unlinked).to.eq(1);
				expect(response.body.data.qso_count).to.eq(0);
			});

			// The QSO stays in the logbook, only the contest is gone.
			cy.request({ url: `${API}/qso/${qsoA}`, headers: auth(fullKey) }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.call).to.eq("V2CONT1");
			});
			adifOf("V2CONT1").then((adif) => {
				expect(adif).to.not.contain(CONTEST);
			});
		});

		it("unlinking a QSO of another session is a no-op", () => {
			// qsoB belongs to otherSessionId; a detach on the wrong session must
			// not clear a link (or a COL_CONTEST_ID) it does not own.
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { unlink_qso_ids: [qsoB] },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.unlinked).to.eq(0);
			});

			cy.request({ url: `${API}/contest/${otherSessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.body.data.qso_ids).to.deep.eq([qsoB]);
			});
		});

		it("POST /api/v2/contest can link QSOs while creating the session", () => {
			createSession({ comment: "Cypress create+link", qso_ids: [qsoA] }).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.linked).to.eq(1);
				expect(response.body.data.qso_count).to.eq(1);
				const created = response.body.data.id;

				adifOf("V2CONT1").then((adif) => expect(adif).to.contain(CONTEST));

				// Leave the QSO unlinked for the suites below.
				cy.request({
					method: "PATCH",
					url: `${API}/contest/${created}`,
					headers: auth(fullKey),
					body: { unlink_qso_ids: [qsoA] },
				});
				cy.request({
					method: "DELETE",
					url: `${API}/contest/${created}`,
					headers: auth(fullKey),
				});
			});
		});
	});

	// --- Scopes -------------------------------------------------------------

	describe("Scopes", () => {
		it("a contest:read token may read but not write", () => {
			cy.request({ url: `${API}/contest`, headers: auth(roKey) }).then((response) => {
				expect(response.status).to.eq(200);
			});

			createSession({}, roKey).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
				expect(response.body.error.details).to.have.property("required_scope", "contest:write");
			});
		});

		it("deleting a session needs contest:delete", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/contest/${sessionId}`,
				headers: auth(roKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error.details).to.have.property("required_scope", "contest:delete");
			});
		});

		// contest:delete covers the session. Taking the logbook entries with it is
		// a QSO-resource power, so it needs that resource's delete scope - a
		// contest token must not become a way around it.
		it("?delete_qsos=true additionally needs qso:delete", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/contest/${sessionId}?delete_qsos=true`,
				headers: auth(contestKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
				expect(response.body.error.details).to.have.property("required_scope", "qso:delete");
			});

			// Refused means refused: the session is still there.
			cy.request({ url: `${API}/contest/${sessionId}`, headers: auth(fullKey) }).then((response) => {
				expect(response.status).to.eq(200);
			});
		});
	});

	// --- Deleting -----------------------------------------------------------

	describe("Delete", () => {
		it("DELETE /api/v2/contest/{id} keeps the QSOs in the logbook", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				body: { link_qso_ids: [qsoA] },
			}).then((response) => {
				expect(response.body.data.linked).to.eq(1);
			});

			cy.request({
				method: "DELETE",
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});

			cy.request({
				url: `${API}/contest/${sessionId}`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});

			// Deleting the session must never delete the log.
			cy.request({ url: `${API}/qso/${qsoA}`, headers: auth(fullKey) }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.call).to.eq("V2CONT1");
			});
		});

		it("DELETE ?delete_qsos=true removes the linked QSOs as well", () => {
			createSession({ comment: "Cypress teardown", qso_ids: [qsoC] }).then((response) => {
				expect(response.status).to.eq(201);
				const created = response.body.data.id;

				cy.request({
					method: "DELETE",
					url: `${API}/contest/${created}?delete_qsos=true`,
					headers: auth(fullKey),
				}).then((del) => {
					expect(del.status).to.eq(204);
				});

				cy.request({
					url: `${API}/qso/${qsoC}`,
					headers: auth(fullKey),
					failOnStatusCode: false,
				}).then((qso) => {
					expect(qso.status).to.eq(404);
				});
			});
		});

		it("DELETE /api/v2/contest/{id} of an unknown session returns 404", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/contest/999999`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});
		});
	});

	// --- Dispatcher ---------------------------------------------------------

	describe("Dispatcher", () => {
		it("PUT /api/v2/contest/{id} is not supported (405)", () => {
			cy.request({
				method: "PUT",
				url: `${API}/contest/${otherSessionId}`,
				headers: auth(fullKey),
				body: { comment: "replaced" },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(405);
				expect(response.body.error).to.have.property("code", "method_not_allowed");
				const allowed = response.headers.allow.split(",").map((v) => v.trim()).sort();
				expect(allowed).to.deep.eq(["DELETE", "GET", "PATCH", "POST"]);
			});
		});

		it("GET /api/v2/contest/{id}/qso does not exist (404)", () => {
			// The URL space is /<resource>[/<id>]; the links travel in the body.
			cy.request({
				url: `${API}/contest/${otherSessionId}/qso`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});
	});

	// --- Cleanup ------------------------------------------------------------

	describe("Cleanup", () => {
		it("removes the sessions and QSOs created here", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/contest/${otherSessionId}`,
				headers: auth(fullKey),
				failOnStatusCode: false,
			});

			[qsoA, qsoB].forEach((id) => {
				cy.request({
					method: "DELETE",
					url: `${API}/qso/${id}`,
					headers: auth(fullKey),
					failOnStatusCode: false,
				});
			});

			cy.request({ url: `${API}/contest`, headers: auth(fullKey) }).then((response) => {
				const ids = response.body.data.map((s) => s.id);
				expect(ids).to.not.include(sessionId);
				expect(ids).to.not.include(otherSessionId);
			});
		});
	});
});

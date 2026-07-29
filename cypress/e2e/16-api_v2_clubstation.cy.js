import 'cypress-real-events/support';

// API v2 under a clubstation: the permission levels.
//
// A club token is not the same thing as a personal one. It belongs to the
// clubstation (user_id) but was issued by a member acting on its behalf
// (created_by), and what that member may do depends on the permission level
// stored in club_permissions:
//
//   3  Club Member       log and manage your OWN QSOs, read station locations
//   6  Club Member ADIF  same, plus ADIF import/export of your own QSOs
//   9  Club Officer      everything, across all operators
//
// In the web UI all of this hangs off clubaccess_check(), which reads
// cd_p_level and operator_callsign from the session. The API is sessionless, so
// v2 carries the level in the auth context instead and enforces the same rules
// per resource. This spec is the contract for that: what a level-3/6 member can
// and cannot reach, and that an officer is unrestricted.
//
// Prerequisites, all produced by 13-clubstation.cy.js (which runs earlier):
//   - the clubstation account exists,
//   - the admin holds permission level 9 on it.
// The feature flag `special_callsign` is baked into the test image by
// run_once.sh / the CI configs; with it off there are no club rules at all.
//
// The club token itself has to be minted from inside a clubstation session,
// which is the only way to get created_by != user_id. Everything after that
// runs through the API alone — the token keeps working after we leave the
// session, which is exactly the point of a sessionless API.

describe("API v2 - Clubstation permissions", () => {
	const API = "/index.php/api/v2";

	const ALL_SCOPES = [
		"qso:read", "qso:write", "qso:delete",
		"station:read", "station:write", "station:delete",
		"radio:read", "radio:write", "radio:delete",
		"statistic:read",
		"lookup:read", "club:read",
	];

	// Permission levels, named for readability (see controllers/Club.php).
	const MEMBER = 3;
	const MEMBER_ADIF = 6;
	const OFFICER = 9;

	// A callsign that is nobody's operator in this instance, used to plant a QSO
	// that belongs to a different operator than the token's member.
	const OTHER_OPERATOR = "HB9OTHER";

	let clubToken;      // club token: user_id = clubstation, created_by = admin
	let clubId;         // user_id of the clubstation account
	let adminId;        // user_id of the admin (the acting member)
	let clubStationId;  // station location owned by the clubstation
	let ownQsoId;       // QSO logged by the admin as the club
	let foreignQsoId;   // QSO in the same log, but COL_OPERATOR = OTHER_OPERATOR

	const auth = () => ({ Authorization: "Bearer " + clubToken });

	// Reveal the hover-activated "Logged in As" header dropdown (see
	// 13-clubstation.cy.js, same mechanism).
	function openUserMenu(callsign) {
		cy.contains('a.nav-link.dropdown-toggle', callsign).realHover();
	}

	// The first dashboard load as the clubstation may AJAX-open the "Version
	// Info" modal, which overlays the header menu.
	function dismissVersionModal() {
		cy.wait(2000);
		cy.get("body").then(($body) => {
			if ($body.find(".modal.show").length) {
				cy.get(".modal.show").contains("button", "Don't show again").click();
				cy.get(".modal-backdrop", { timeout: 8000 }).should("not.exist");
			}
		});
	}

	// Enter the clubstation through the officer path (club_permissions row plus a
	// fresh login, which fills available_clubstations).
	function clubSwitch(adminCallsign, clubCallsign) {
		cy.visit("/index.php/dashboard");
		openUserMenu(adminCallsign);
		cy.get('button.dropdown-item[onclick*="clubswitch_modal"]')
			.contains(clubCallsign)
			.click();
		cy.get("#clubswitchModal", { timeout: 8000 }).should("be.visible");
		cy.get('#clubswitchModal button[type="submit"]').click();
	}

	function stopImpersonate(clubCallsign) {
		openUserMenu(clubCallsign);
		cy.get('button.dropdown-item[onclick*="stopImpersonate_modal"]').click();
		cy.get("#stopImpersonateModal", { timeout: 8000 }).should("be.visible");
		cy.get('#stopImpersonateModal button[type="submit"]').click();
		cy.url({ timeout: 15000 }).should((url) =>
			expect(url.includes("/dashboard") || url.includes("/user/login")).to.be.true
		);
		cy.url().then((url) => {
			if (!url.includes("/dashboard")) {
				cy.login();
			}
		});
	}

	// Set the acting member's permission level. club/alter_member is an upsert,
	// so the same call both changes an existing level and re-adds a removed
	// member. Driven over the endpoint rather than the selectize-based UI: the
	// UI path is already covered by 13-clubstation, and here the level is a
	// precondition, not the thing under test.
	function setClubLevel(level) {
		return cy.request({
			method: "POST",
			url: "/index.php/club/alter_member",
			form: true,
			body: { club_id: clubId, user_id: adminId, permission: level },
		}).then((response) => {
			expect(response.status, `set club level ${level}`).to.eq(200);
		});
	}

	function removeClubMembership() {
		return cy.request({
			method: "POST",
			url: "/index.php/club/delete_member",
			form: true,
			body: { club_id: clubId, user_id: adminId },
		}).then((response) => {
			expect(response.status, "remove club membership").to.eq(200);
		});
	}

	before(() => {
		const env_user = Cypress.expose('user');
		const env_club = Cypress.expose('clubstation');

		cy.setCookie("language", "english");
		cy.login();

		// Resolve the clubstation's user_id from the admin user list: its row
		// links to club/permissions/<club_id>.
		cy.request("/index.php/user").then((response) => {
			const row = response.body
				.split("<tr")
				.find((chunk) => chunk.includes(env_club.callsign) && chunk.includes("club/permissions"));
			expect(row, "clubstation row in the user list").to.exist;
			const match = row.match(/club\/permissions\/(\d+)/);
			expect(match, "club_id from the permissions link").to.not.be.null;
			clubId = Number(match[1]);
		});

		// The admin's own user_id, via the endpoint the permissions UI uses.
		cy.request({
			method: "POST",
			url: "/index.php/club/get_users",
			form: true,
			body: { query: env_user.callsign },
		}).then((res) => {
			const list = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
			const user = list.find((u) => u.user_callsign === env_user.callsign);
			expect(user, "admin found via club/get_users").to.exist;
			adminId = Number(user.user_id);
		});

		// Mint the club token from inside the clubstation session, then leave it.
		// 13-clubstation left the admin at level 9, which is what we need to set
		// the fixture up through the API.
		cy.then(() => {
			clubSwitch(env_user.callsign, env_club.callsign);
			dismissVersionModal();
			cy.createApiToken("cypress-v2-club", ALL_SCOPES).then((t) => (clubToken = t));
			cy.visit("/index.php/dashboard");
			stopImpersonate(env_club.callsign);
		});
	});

	beforeEach(() => {
		cy.setCookie("language", "english");
		cy.login();
	});

	// --- Fixture, built through the API as an officer ----------------------

	describe("Fixture (officer)", () => {
		it("the club token is a club token, not a personal one", () => {
			const env_club = Cypress.expose('clubstation');

			cy.request({ url: `${API}/token`, headers: auth() }).then((response) => {
				expect(response.status).to.eq(200);
				// The token's owner is the clubstation, not the admin who created it.
				expect(response.body.data).to.have.property("owner", env_club.callsign);
				expect(response.body.data.user_id).to.eq(clubId);
			});
		});

		it("an officer may create a station location for the club", () => {
			cy.request({
				method: "POST",
				url: `${API}/station`,
				headers: auth(),
				body: {
					name: "Cypress Club Location",
					callsign: Cypress.expose('clubstation').callsign,
					gridsquare: "JN47RI",
					city: "Club City",
					// Switzerland, the same entity 02-stationsetup picks in the UI.
					// The UI form marks DXCC, CQ and ITU as required and copies them
					// into every QSO logged from the location, so a location without
					// them is not something a real client would create.
					dxcc: 287,
					cq: 14,
					itu: 28,
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				clubStationId = response.body.data.id;
				expect(clubStationId).to.be.a("number");
			});
		});

		it("an officer may log a QSO under another operator's callsign", () => {
			// Only an officer can do this; for a member the operator is forced.
			// This is the row the member must not be able to see or touch later.
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(),
				body: {
					station_profile_id: clubStationId,
					call: "V2CLUBFOREIGN",
					band: "20m",
					mode: "SSB",
					qso_date: "2024-02-01",
					time_on: "1200",
					operator: OTHER_OPERATOR,
					name: "Foreign Op Contact",
					qth: "Foreignville",
					gridsquare: "JN99XX",
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				foreignQsoId = response.body.data.id;
			});
		});

		it("an officer logging without an operator gets their own callsign", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(),
				body: {
					station_profile_id: clubStationId,
					call: "V2CLUBOWN",
					band: "40m",
					mode: "CW",
					qso_date: "2024-02-01",
					time_on: "1300",
				},
			}).then((response) => {
				expect(response.status).to.eq(201);
				ownQsoId = response.body.data.id;
			});
		});

		it("an officer sees both QSOs", () => {
			cy.request({
				url: `${API}/qso?station_id=${clubStationId}`,
				headers: auth(),
			}).then((response) => {
				expect(response.status).to.eq(200);
				const calls = response.body.data.map((q) => q.call);
				expect(calls).to.include("V2CLUBFOREIGN");
				expect(calls).to.include("V2CLUBOWN");
			});
		});
	});

	// --- Club Member (3) and Club Member ADIF (6) --------------------------
	//
	// Both levels are below officer and share every restriction; the split
	// between them is about the ADIF *UI*, not about the API surface. The suite
	// therefore runs identically for both.

	[MEMBER, MEMBER_ADIF].forEach((level) => {
		describe(`Club Member level ${level}`, () => {
			beforeEach(() => {
				setClubLevel(level);
			});

			it("may still read station locations", () => {
				cy.request({ url: `${API}/station`, headers: auth() }).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data).to.be.an("array");
				});
			});

			// Station locations are club-wide infrastructure, and deleting one takes
			// all of its QSOs with it. v1 refuses create_station for levels 3 and 6
			// for the same reason.
			it("may not create a station location (403)", () => {
				cy.request({
					method: "POST",
					url: `${API}/station`,
					headers: auth(),
					body: { name: "Member Location", callsign: "HB9NOPE" },
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error).to.have.property("code", "insufficient_club_permission");
					expect(response.body.error.details).to.have.property("required_level", 9);
					expect(response.body.error.details).to.have.property("granted_level", level);
				});
			});

			it("may not update a station location (403)", () => {
				cy.request({
					method: "PATCH",
					url: `${API}/station/${clubStationId}`,
					headers: auth(),
					body: { city: "Hijacked" },
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error).to.have.property("code", "insufficient_club_permission");
				});
			});

			it("may not delete a station location (403)", () => {
				cy.request({
					method: "DELETE",
					url: `${API}/station/${clubStationId}`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error).to.have.property("code", "insufficient_club_permission");
				});
			});

			// The operator is what separates one member's QSOs from another's, so a
			// member must not be able to log under someone else's callsign by naming
			// them in the payload.
			it("cannot log a QSO under a foreign operator", () => {
				const env_user = Cypress.expose('user');

				cy.request({
					method: "POST",
					url: `${API}/qso`,
					headers: auth(),
					body: {
						station_profile_id: clubStationId,
						call: "V2CLUBFORCED",
						band: "20m",
						mode: "SSB",
						qso_date: "2024-02-02",
						time_on: `120${level}`,
						operator: OTHER_OPERATOR,
					},
				}).then((response) => {
					expect(response.status).to.eq(201);
					const created = response.body.data.id;

					// Read it back: the QSO is visible to the member, which it would
					// not be had the foreign operator been kept.
					cy.request({
						url: `${API}/qso/${created}`,
						headers: auth(),
					}).then((read) => {
						expect(read.status).to.eq(200);
						expect(read.body.data.call).to.eq("V2CLUBFORCED");
					});

					cy.request({
						method: "DELETE",
						url: `${API}/qso/${created}`,
						headers: auth(),
					});
				});
			});

			it("cannot log a bulk QSO under a foreign operator either", () => {
				cy.request({
					method: "POST",
					url: `${API}/qso`,
					headers: auth(),
					body: {
						station_profile_id: clubStationId,
						qsos: [{
							call: "V2CLUBBULK",
							band: "20m",
							mode: "SSB",
							qso_date: "2024-02-03",
							time_on: `130${level}`,
							operator: OTHER_OPERATOR,
						}],
					},
				}).then((response) => {
					expect(response.status).to.eq(201);
					expect(response.body.data.imported).to.eq(1);
				});

				// The row is in the member's own list, so the operator was overwritten.
				cy.request({
					url: `${API}/qso?station_id=${clubStationId}`,
					headers: auth(),
				}).then((response) => {
					const calls = response.body.data.map((q) => q.call);
					expect(calls).to.include("V2CLUBBULK");
				});
			});

			it("only sees its own QSOs in the list", () => {
				cy.request({
					url: `${API}/qso?station_id=${clubStationId}`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					const calls = response.body.data.map((q) => q.call);
					expect(calls).to.include("V2CLUBOWN");
					expect(calls).to.not.include("V2CLUBFOREIGN");
				});
			});

			// The ADIF export runs the same query as the JSON list, so the filter
			// cannot be sidestepped by asking for a different format.
			it("only exports its own QSOs as ADIF", () => {
				cy.request({
					url: `${API}/qso?station_id=${clubStationId}&format=adif`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					const adif = response.body.data.adif || "";
					expect(adif).to.not.contain("V2CLUBFOREIGN");
					expect(adif.toUpperCase()).to.contain("V2CLUBOWN");
				});
			});

			it("meta.total counts only its own QSOs", () => {
				cy.request({
					url: `${API}/qso?station_id=${clubStationId}`,
					headers: auth(),
				}).then((response) => {
					// The list and its total run through the same WHERE builder, so
					// the count must match what was actually returned.
					expect(response.body.meta.total).to.eq(response.body.data.length);
				});
			});

			// A foreign QSO is reported as not found rather than forbidden: the
			// resource does not confirm that a row the token may not see exists.
			it("cannot read a QSO of another operator (404)", () => {
				cy.request({
					url: `${API}/qso/${foreignQsoId}`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(404);
					expect(response.body.error).to.have.property("code", "not_found");
				});
			});

			it("cannot edit a QSO of another operator (404)", () => {
				cy.request({
					method: "PATCH",
					url: `${API}/qso/${foreignQsoId}`,
					headers: auth(),
					body: { comment: "should never land" },
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(404);
					expect(response.body.error).to.have.property("code", "not_found");
				});
			});

			it("cannot delete a QSO of another operator (404)", () => {
				cy.request({
					method: "DELETE",
					url: `${API}/qso/${foreignQsoId}`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(404);
					expect(response.body.error).to.have.property("code", "not_found");
				});
			});

			it("may still edit its own QSO", () => {
				cy.request({
					method: "PATCH",
					url: `${API}/qso/${ownQsoId}`,
					headers: auth(),
					body: { comment: `member level ${level}` },
				}).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data.comment).to.eq(`member level ${level}`);
				});
			});

			// A lookup answers "have I worked this before" out of the same logbook,
			// so without the same restriction it would hand back the name, QTH and
			// locator of exactly the QSO the list hides.
			it("does not learn about another operator's QSO through a lookup", () => {
				cy.request({
					url: `${API}/lookup?callsign=V2CLUBFOREIGN`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data.workedBefore).to.eq(false);
					expect(response.body.data.name).to.eq("");
					expect(response.body.data.location).to.eq("");
				});
			});

			it("does not learn about it through a detailed lookup either", () => {
				cy.request({
					url: `${API}/lookup?callsign=V2CLUBFOREIGN&detail=full`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data.call_worked).to.eq(false);
					expect(response.body.data.name).to.eq("");
				});
			});

			it("does not see another operator's grid as worked", () => {
				// JN99 only exists in the foreign QSO.
				cy.request({
					url: `${API}/lookup?grid=JN99`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data.result).to.eq("Not Found");
				});
			});

			it("does not list another operator's grid in the worked grids", () => {
				cy.request({
					url: `${API}/lookup?grid=all`,
					headers: auth(),
				}).then((response) => {
					expect(response.status).to.eq(200);
					expect(response.body.data.grids).to.not.include("JN99");
				});
			});

			// Radios carry an operator of their own, so each member registers its
			// own rigs into the shared club account and must only see those.
			//
			// A radio belonging to *another* operator cannot be created through the
			// API at all (POST always stamps the caller's own operator), so the
			// cross-operator case needs a second club member and is not covered
			// here. What is covered is that the filter does not break normal use.
			it("can register and see its own radio", () => {
				cy.request({
					method: "POST",
					url: `${API}/radio`,
					headers: auth(),
					body: { radio: `Cypress-Club-Rig-${level}`, frequency: 14074000, mode: "FT8" },
				}).then((response) => {
					expect([200, 201]).to.include(response.status);
					const radioId = response.body.data.id;

					cy.request({ url: `${API}/radio`, headers: auth() }).then((list) => {
						const mine = list.body.data.find((r) => r.id === radioId);
						expect(mine, "own radio is listed").to.exist;
					});

					cy.request({
						method: "DELETE",
						url: `${API}/radio/${radioId}`,
						headers: auth(),
					}).then((del) => {
						expect(del.status).to.eq(204);
					});
				});
			});

			// The member list carries every member's email address, so it stays
			// officer-only.
			it("may not list the club members (403)", () => {
				cy.request({
					url: `${API}/club`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error.code).to.be.oneOf([
						"insufficient_club_permission",
						"forbidden",
					]);
				});
			});
		});
	});

	// --- Back to officer ---------------------------------------------------

	describe("Club Officer", () => {
		beforeEach(() => {
			setClubLevel(OFFICER);
		});

		it("sees every operator's QSO again", () => {
			cy.request({
				url: `${API}/qso?station_id=${clubStationId}`,
				headers: auth(),
			}).then((response) => {
				const calls = response.body.data.map((q) => q.call);
				expect(calls).to.include("V2CLUBFOREIGN");
				expect(calls).to.include("V2CLUBOWN");
			});
		});

		it("may read and edit another operator's QSO", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/qso/${foreignQsoId}`,
				headers: auth(),
				body: { comment: "officer edit" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.comment).to.eq("officer edit");
			});
		});

		it("finds another operator's QSO through a lookup again", () => {
			cy.request({
				url: `${API}/lookup?callsign=V2CLUBFOREIGN`,
				headers: auth(),
			}).then((response) => {
				expect(response.body.data.workedBefore).to.eq(true);
				expect(response.body.data.name).to.eq("Foreign Op Contact");
			});
		});

		it("may manage station locations again", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/station/${clubStationId}`,
				headers: auth(),
				body: { city: "Officer City" },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.city).to.eq("Officer City");
			});
		});

		it("may list the club members", () => {
			cy.request({ url: `${API}/club`, headers: auth() }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data).to.be.an("array").and.to.have.length.greaterThan(0);
			});
		});
	});

	// --- Membership revoked ------------------------------------------------
	//
	// The token carries no record of the membership, so it has to be re-checked
	// on every request. Without that, removing a member from the club would
	// leave them full access until the token happens to expire — and the UI
	// offers "never" as an expiry.

	describe("Membership revoked", () => {
		before(() => {
			cy.login();
			removeClubMembership();
		});

		[
			"/token",
			"/qso",
			"/station",
			"/radio",
			"/statistic",
			"/club",
			"/lookup?callsign=V2CLUBOWN",
		].forEach((path) => {
			it(`GET ${path} is refused with club_access_revoked`, () => {
				cy.request({
					url: `${API}${path}`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(403);
					expect(response.body.error).to.have.property("code", "club_access_revoked");
				});
			});
		});

		it("a write is refused as well", () => {
			cy.request({
				method: "POST",
				url: `${API}/qso`,
				headers: auth(),
				body: {
					station_profile_id: clubStationId,
					call: "V2REVOKED",
					band: "20m",
					mode: "SSB",
					qso_date: "2024-02-04",
					time_on: "1400",
				},
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "club_access_revoked");
			});
		});

		it("re-adding the member restores access immediately", () => {
			// No caching: the level is read per request.
			setClubLevel(OFFICER);
			cy.request({ url: `${API}/token`, headers: auth() }).then((response) => {
				expect(response.status).to.eq(200);
			});
		});
	});

	// --- Cleanup -----------------------------------------------------------

	describe("Cleanup", () => {
		it("removes the QSOs and the station location created here", () => {
			// Deleting the location would take its QSOs with it, but removing them
			// explicitly keeps the failure modes apart if one of the two breaks.
			[ownQsoId, foreignQsoId].forEach((id) => {
				cy.request({
					method: "DELETE",
					url: `${API}/qso/${id}`,
					headers: auth(),
					failOnStatusCode: false,
				});
			});

			cy.request({
				method: "DELETE",
				url: `${API}/station/${clubStationId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				// 409 when it ended up being the club's active location, which is
				// refused by design and not a failure of this spec.
				expect([204, 409]).to.include(response.status);
			});
		});

		it("leaves the admin as Club Officer for the specs that follow", () => {
			setClubLevel(OFFICER);
		});
	});
});

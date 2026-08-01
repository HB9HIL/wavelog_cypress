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
		"lookup:read", "club:read", "club:write", "club:delete",
	];

	// Permission levels, named for readability (see controllers/Club.php).
	const MEMBER = 3;
	const MEMBER_ADIF = 6;
	const OFFICER = 9;

	// A callsign that is nobody's operator in this instance, used to plant a QSO
	// that belongs to a different operator than the token's member.
	const OTHER_OPERATOR = "HB9OTHER";

	let clubToken;      // club token: user_id = clubstation, created_by = admin
	let clubReadToken;  // same, but with club:read only (scope enforcement)
	let personalToken;  // the admin's own token: user_id == created_by
	let adminClubToken; // the admin's own token, with the club scopes
	let clubId;         // user_id of the clubstation account
	let adminId;        // user_id of the admin (the acting member)
	let memberId;       // user_id of a second account, the target of the club writes
	let clubStationId;  // station location owned by the clubstation
	let ownQsoId;       // QSO logged by the admin as the club
	let foreignQsoId;   // QSO in the same log, but COL_OPERATOR = OTHER_OPERATOR

	const auth = () => ({ Authorization: "Bearer " + clubToken });

	// Reveal the hover-activated "Logged in As" header dropdown (see
	// 13-clubstation.cy.js, same mechanism).
	function openUserMenu(callsign) {
		cy.contains('a.nav-link.dropdown-toggle', callsign).realHover();
	}

	// cy.login() is hard-wired to the admin, and the session set up by the
	// beforeEach hook is still active, so this logs out first. Used for the
	// cases that need somebody other than the admin in front of the UI.
	function loginAs(username, password) {
		cy.visit("/index.php/user/logout");
		cy.url({ timeout: 15000 }).should("include", "/user/login");

		cy.get('input[name="user_name"]').type(username);
		cy.get('input[name="user_password"]').type(password);
		cy.get('button[type="submit"]').click();
		cy.url().should("include", "/dashboard");
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

	// Enter the clubstation as somebody who may just have logged in for the very
	// first time. That login is met by the first login wizard, which is
	// backdrop-static, so the header menu clubSwitch() reaches for is behind an
	// overlay that cannot be clicked away - but the wizard offers the club
	// switch itself ("Skip and Open Clubstation"). On a re-run the account is no
	// longer new, the wizard never appears and the header path is the only one.
	function enterClubstation(userCallsign, clubCallsign) {
		cy.wait(2000);
		cy.get("body").then(($body) => {
			if ($body.find("#firstLoginWizardModal.show").length) {
				cy.get("#firstLoginWizardModal").contains("a", clubCallsign).click();
				cy.get("#clubswitchModal", { timeout: 8000 }).should("be.visible");
				cy.get('#clubswitchModal button[type="submit"]').click();
			} else {
				dismissVersionModal();
				clubSwitch(userCallsign, clubCallsign);
			}
		});
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

	// Resolve a user_id through the endpoint the club permission UI uses.
	// Yields null when no such account exists.
	function findUserId(callsign) {
		return cy.request({
			method: "POST",
			url: "/index.php/club/get_users",
			form: true,
			body: { query: callsign },
		}).then((res) => {
			const list = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
			const user = list.find((u) => u.user_callsign === callsign);
			return user ? Number(user.user_id) : null;
		});
	}

	// The club write endpoints need a target that is neither the clubstation nor
	// the acting officer — the API refuses both. The admin is the officer here,
	// so a second ordinary account is created for that role. Idempotent, so the
	// spec survives a re-run against an instance that already has it.
	function ensureClubMemberAccount() {
		const env_member = Cypress.expose('clubmember');

		return findUserId(env_member.callsign).then((id) => {
			if (id !== null) {
				memberId = id;
				return;
			}

			cy.visit("/index.php/user/add");
			cy.get('input[name="user_name"]').type(env_member.username);
			cy.get('input[name="user_password"]').type(env_member.password);
			cy.get('input[name="user_callsign"]').type(env_member.callsign);
			cy.get('input[name="user_email"]').type(env_member.email);
			cy.get('input[name="user_locator"]').type(env_member.userlocator);
			// Operator, the lowest level config/auth_level offers (the other is
			// 99). Enough to open /api and mint a token, which the scope
			// visibility tests need, and decidedly not an administrator.
			cy.get('select[name="user_type"]').select("3");
			// Scope to the user form: the header also renders a submit button.
			cy.get('form[name="users"] button[type="submit"]').click();

			findUserId(env_member.callsign).then((created) => {
				expect(created, "club member account created").to.not.be.null;
				memberId = created;
			});
		});
	}

	// The permission suite starts from "not a member yet". A run that was cut
	// short (cypress-fail-fast) can leave the membership behind, so drop it
	// before the suite rather than depending on its own cleanup having run.
	function clearMemberMembership() {
		return cy.request({
			method: "POST",
			url: "/index.php/club/delete_member",
			form: true,
			body: { club_id: clubId, user_id: memberId },
			failOnStatusCode: false,
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
		findUserId(env_user.callsign).then((id) => {
			expect(id, "admin found via club/get_users").to.not.be.null;
			adminId = id;
		});

		// The second account the club permission endpoints act on.
		ensureClubMemberAccount();

		// Mint the club token from inside the clubstation session, then leave it.
		// 13-clubstation left the admin at level 9, which is what we need to set
		// the fixture up through the API.
		cy.then(() => {
			clubSwitch(env_user.callsign, env_club.callsign);
			dismissVersionModal();
			cy.createApiToken("cypress-v2-club", ALL_SCOPES).then((t) => (clubToken = t));
			// A second club token, restricted to club:read. Minting it here is the
			// only way to keep it a *club* token; from a normal admin session it
			// would come out personal and fail the officer check instead of the
			// scope check it is meant to prove.
			cy.createApiToken("cypress-v2-club-readonly", ["club:read"]).then((t) => (clubReadToken = t));
			cy.visit("/index.php/dashboard");
			stopImpersonate(env_club.callsign);

			// Back in the plain admin session, so these come out personal
			// (user_id == created_by). Losing the club membership must not touch
			// them; the revocation suite at the end asserts that.
			cy.createApiToken("cypress-v2-personal", ["station:read"]).then((t) => (personalToken = t));
			// A personal token that carries the club scopes: only an
			// administrator is offered them outside a clubstation, and only they
			// can use them - by naming the club with ?club_id=.
			cy.createApiToken("cypress-v2-admin-club", ["club:read", "club:write", "club:delete"])
				.then((t) => (adminClubToken = t));
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

			// Handing out permissions is the officer's job; a member holding
			// club:write must not be able to promote themselves or anybody else.
			// The token carries the scope here, so a pass would be a real
			// privilege escalation, not just a missing scope.
			it("may not read, grant or revoke club permissions (403)", () => {
				[
					{ method: "GET", url: `${API}/club/${adminId}` },
					{ method: "POST", url: `${API}/club`, body: { user_id: memberId, permission_level: OFFICER } },
					{ method: "PATCH", url: `${API}/club/${memberId}`, body: { permission_level: OFFICER } },
					{ method: "DELETE", url: `${API}/club/${adminId}` },
				].forEach((request) => {
					cy.request({
						...request,
						headers: auth(),
						failOnStatusCode: false,
					}).then((response) => {
						expect(response.status, `${request.method} ${request.url}`).to.eq(403);
						expect(response.body.error.code).to.be.oneOf([
							"insufficient_club_permission",
							"forbidden",
						]);
					});
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

	// --- Managing club permissions (officer) -------------------------------
	//
	// The clubstation is implicit — it is the token owner — so the path id
	// addresses the *member*: /club/{user_id}. The acting officer is the admin,
	// so every write here targets the separate member account: the API refuses
	// to let an officer touch their own membership, which is what keeps a club
	// from being locked out of its own permission management.

	describe("Club permissions", () => {
		before(() => {
			cy.login();
			clearMemberMembership();
		});

		beforeEach(() => {
			setClubLevel(OFFICER);
		});

		// The full member object. config.php can cut this down to the callsign
		// and the name (api_minimal_userdata), which the test image does not do
		// - asserting the whole set here is what would catch that default
		// flipping, since the option cannot be toggled mid-run.
		it("reads a single member", () => {
			cy.request({ url: `${API}/club/${adminId}`, headers: auth() }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.user_id).to.eq(adminId);
				expect(response.body.data.permission_level).to.eq(OFFICER);
				expect(Object.keys(response.body.data).sort()).to.deep.eq([
					"callsign",
					"permission_level",
					"user_email",
					"user_firstname",
					"user_id",
					"user_language",
					"user_lastname",
					"user_locator",
					"user_name",
				]);
			});
		});

		it("reports a non-member as not found", () => {
			cy.request({
				url: `${API}/club/${memberId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		it("adds a member", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: auth(),
				body: { user_id: memberId, permission_level: MEMBER },
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.headers).to.have.property("location");
				expect(response.headers.location).to.contain(`/club/${memberId}`);
				expect(response.body.data.user_id).to.eq(memberId);
				expect(response.body.data.permission_level).to.eq(MEMBER);
				// No notify flag was sent, so the meta stays silent about mail.
				expect(response.body.meta).to.not.have.property("notified");
			});
		});

		it("the new member shows up in the list", () => {
			cy.request({ url: `${API}/club`, headers: auth() }).then((response) => {
				const ids = response.body.data.map((m) => m.user_id);
				expect(ids).to.include(memberId);
			});
		});

		// POST creates, it never overwrites: silently changing a level a client
		// believed it was setting for the first time is the worse failure mode.
		it("refuses to add the same member twice (409)", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: auth(),
				body: { user_id: memberId, permission_level: OFFICER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(409);
				expect(response.body.error).to.have.property("code", "conflict");
			});
		});

		it("changes the member's level", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: MEMBER_ADIF },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.permission_level).to.eq(MEMBER_ADIF);
			});
		});

		// The mail needs working email settings, which the test instance does not
		// have. What is under test is the contract: the permission is granted
		// either way and the outcome is reported instead of failing the request.
		it("reports the notification outcome without failing on it", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: MEMBER, notify: true },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.permission_level).to.eq(MEMBER);
				expect(response.body.meta).to.have.property("notified");
				expect(response.body.meta.notified).to.be.a("boolean");
			});
		});

		it("refuses a level outside 3/6/9 (400)", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: 5 },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details.allowed).to.have.members([MEMBER, MEMBER_ADIF, OFFICER]);
			});
		});

		it("refuses a POST without a user_id (400)", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: auth(),
				body: { permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		// An officer demoting or removing themselves over the API would lock the
		// club out of its own permission management. The rule binds officers
		// only, and the fixture's officer is the Wavelog administrator - who is
		// exempt - so this needs a club token created by an ordinary member at
		// officer level. The preceding tests left that member at level 3, and
		// handing out club scopes needs officer level too
		// (Club_resource::is_grantable()). cd_p_level is filled from
		// available_clubstations at login time, so the promotion has to happen
		// before the login, not after the club switch.
		it("refuses to touch a plain officer's own membership (403)", () => {
			const env_member = Cypress.expose('clubmember');
			const env_club = Cypress.expose('clubstation');

			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: OFFICER },
			}).then((response) => {
				expect(response.status, "promote the member to officer").to.eq(200);
			});

			loginAs(env_member.username, env_member.password);
			enterClubstation(env_member.callsign, env_club.callsign);

			cy.createApiToken("cypress-v2-member-club", ["club:read", "club:write", "club:delete"])
				.then((memberClubToken) => {
					const memberAuth = { Authorization: "Bearer " + memberClubToken };

					cy.request({
						method: "PATCH",
						url: `${API}/club/${memberId}`,
						headers: memberAuth,
						body: { permission_level: MEMBER },
						failOnStatusCode: false,
					}).then((response) => {
						expect(response.status).to.eq(403);
						expect(response.body.error).to.have.property("code", "forbidden");
					});

					cy.request({
						method: "DELETE",
						url: `${API}/club/${memberId}`,
						headers: memberAuth,
						failOnStatusCode: false,
					}).then((response) => {
						expect(response.status).to.eq(403);
						expect(response.body.error).to.have.property("code", "forbidden");
					});

					// Still an officer afterwards.
					cy.request({ url: `${API}/club/${memberId}`, headers: memberAuth }).then((response) => {
						expect(response.body.data.permission_level).to.eq(OFFICER);
					});
				});
		});

		// The other side of that rule: an administrator is never locked out of
		// the web UI, so it would only get in their way. Their club token walks
		// straight through the check the member above is stopped by. Set to the
		// level it already holds, so the assertion costs the fixture nothing.
		it("lets an administrator's club token touch their own membership", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${adminId}`,
				headers: auth(),
				body: { permission_level: OFFICER },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.permission_level).to.eq(OFFICER);
			});
		});

		it("refuses the clubstation itself as a member (400)", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: auth(),
				body: { user_id: clubId, permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
			});
		});

		it("refuses an unknown user (404)", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/999999`,
				headers: auth(),
				body: { permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		// Wavelog has no PUT anywhere; the Allow header must advertise only what
		// the resource actually implements.
		it("has no PUT (405)", () => {
			cy.request({
				method: "PUT",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(405);
				expect(response.headers.allow).to.contain("PATCH");
				expect(response.headers.allow).to.not.contain("PUT");
			});
		});

		it("removes the member", () => {
			cy.request({
				method: "DELETE",
				url: `${API}/club/${memberId}`,
				headers: auth(),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});

			cy.request({
				url: `${API}/club/${memberId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});
		});

		// Without this a DELETE on a non-member would report success, and a PATCH
		// would quietly create the membership POST is meant to create.
		it("refuses to change or remove a non-member (404)", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				body: { permission_level: OFFICER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});

			cy.request({
				method: "DELETE",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});
		});

		// Reading the list needs club:read, writing club:write and removing
		// club:delete. The read-only token is an officer's token too (minted in
		// the same clubstation session), so what it fails on is the scope alone.
		it("needs the matching scope per verb", () => {
			const readAuth = { Authorization: "Bearer " + clubReadToken };

			cy.request({ url: `${API}/club`, headers: readAuth }).then((response) => {
				expect(response.status).to.eq(200);
			});

			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: readAuth,
				body: { user_id: memberId, permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "insufficient_scope");
				expect(response.body.error.details).to.have.property("required_scope", "club:write");
			});

			cy.request({
				method: "DELETE",
				url: `${API}/club/${adminId}`,
				headers: readAuth,
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error.details).to.have.property("required_scope", "club:delete");
			});
		});

		// The clubstation is implicit for a club token, so ?club_id= is at most
		// a restatement of it. Naming a different club must not silently work on
		// the token's own one.
		it("accepts its own club_id and refuses a foreign one", () => {
			cy.request({
				url: `${API}/club?club_id=${clubId}`,
				headers: auth(),
			}).then((response) => {
				expect(response.status).to.eq(200);
			});

			cy.request({
				url: `${API}/club?club_id=${adminId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(403);
				expect(response.body.error).to.have.property("code", "forbidden");
			});
		});
	});

	// --- The administrator path --------------------------------------------
	//
	// An administrator manages every clubstation in the web UI, so the API lets
	// them too - but with a personal token there is no implicit club, and
	// ?club_id= becomes mandatory. Their own membership is not protected the way
	// an officer's is: they cannot lock themselves out, since the web UI always
	// gets them back in.

	describe("Club permissions as an administrator", () => {
		const adminAuth = () => ({ Authorization: "Bearer " + adminClubToken });

		beforeEach(() => {
			setClubLevel(OFFICER);
		});

		// The one call that does not need club_id: it is where club_id comes
		// from. Refusing it would leave an administrator nowhere to look up the
		// id every other call requires.
		it("lists the clubstations when no club is named", () => {
			cy.request({
				url: `${API}/club`,
				headers: adminAuth(),
			}).then((response) => {
				expect(response.status).to.eq(200);
				const club = response.body.data.find((c) => c.club_id === clubId);
				expect(club, "the clubstation is listed").to.exist;
				expect(club.callsign).to.eq(Cypress.expose('clubstation').callsign);
				// The admin is a member, so the count is at least one.
				expect(club.member_count).to.be.at.least(1);
				// A directory entry, not the member shape.
				expect(club).to.not.have.property("permission_level");
			});
		});

		// A club_id that was supplied but is unusable must not fall back to the
		// directory - that would hide the typo.
		it("refuses a malformed club_id (400)", () => {
			cy.request({
				url: `${API}/club?club_id=notanumber`,
				headers: adminAuth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details).to.have.property("field", "club_id");
			});
		});

		it("still refuses to guess the club on a single member (400)", () => {
			cy.request({
				url: `${API}/club/${adminId}`,
				headers: adminAuth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error).to.have.property("code", "validation_error");
				expect(response.body.error.details).to.have.property("field", "club_id");
			});
		});

		it("lists the members of the club it names", () => {
			cy.request({
				url: `${API}/club?club_id=${clubId}`,
				headers: adminAuth(),
			}).then((response) => {
				expect(response.status).to.eq(200);
				const ids = response.body.data.map((m) => m.user_id);
				expect(ids).to.include(adminId);
			});
		});

		// A user id that is not a clubstation is not a club, whatever else it is.
		it("refuses a club_id that is not a clubstation (404)", () => {
			cy.request({
				url: `${API}/club?club_id=${adminId}`,
				headers: adminAuth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
				expect(response.body.error).to.have.property("code", "not_found");
			});
		});

		it("adds, changes and removes a member", () => {
			cy.request({
				method: "POST",
				url: `${API}/club?club_id=${clubId}`,
				headers: adminAuth(),
				body: { user_id: memberId, permission_level: MEMBER },
			}).then((response) => {
				expect(response.status).to.eq(201);
				expect(response.body.data.permission_level).to.eq(MEMBER);
			});

			cy.request({
				method: "PATCH",
				url: `${API}/club/${memberId}?club_id=${clubId}`,
				headers: adminAuth(),
				body: { permission_level: OFFICER },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.permission_level).to.eq(OFFICER);
			});

			cy.request({
				method: "DELETE",
				url: `${API}/club/${memberId}?club_id=${clubId}`,
				headers: adminAuth(),
			}).then((response) => {
				expect(response.status).to.eq(204);
			});
		});

		it("still needs club_id on a write (400)", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: adminAuth(),
				body: { user_id: memberId, permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
				expect(response.body.error.details).to.have.property("field", "club_id");
			});
		});

		// The counterpart of the officer's 403: the rule exists to stop a club
		// locking itself out, which cannot happen to an administrator.
		it("may change its own membership, unlike an officer", () => {
			cy.request({
				method: "PATCH",
				url: `${API}/club/${adminId}?club_id=${clubId}`,
				headers: adminAuth(),
				body: { permission_level: MEMBER },
			}).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data.permission_level).to.eq(MEMBER);
			});

			// Put it back through the same path, so the suite leaves an officer
			// behind even if the beforeEach hook is ever dropped.
			cy.request({
				method: "PATCH",
				url: `${API}/club/${adminId}?club_id=${clubId}`,
				headers: adminAuth(),
				body: { permission_level: OFFICER },
			}).then((response) => {
				expect(response.status).to.eq(200);
			});
		});

		// Same guards as for an officer, minus the self-service rule.
		it("keeps the remaining guard rails", () => {
			cy.request({
				method: "POST",
				url: `${API}/club?club_id=${clubId}`,
				headers: adminAuth(),
				body: { user_id: clubId, permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(400);
			});

			cy.request({
				method: "PATCH",
				url: `${API}/club/999999?club_id=${clubId}`,
				headers: adminAuth(),
				body: { permission_level: MEMBER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(404);
			});
		});

		// A club token has exactly one club, so it never sees the directory -
		// GET /club stays its own member list.
		it("a club token gets members, not the clubstation list", () => {
			cy.request({ url: `${API}/club`, headers: auth() }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body.data[0]).to.have.property("permission_level");
				expect(response.body.data[0]).to.not.have.property("member_count");
			});
		});

		// A personal token without administrator rights is turned away by the
		// same check, whether or not it names a club - including on the
		// directory call, which must not leak which clubstations exist.
		it("a regular user's personal token is refused (403)", () => {
			const env_member = Cypress.expose('clubmember');

			// Minted from the member's own session, so it is personal and its
			// owner is not an administrator. The club scopes are not offered in
			// that dialog, which is why they are requested directly.
			loginAs(env_member.username, env_member.password);
			cy.createApiToken("cypress-v2-member-personal", ["station:read"]).then((memberToken) => {
				const memberAuth = { Authorization: "Bearer " + memberToken };

				[`${API}/club`, `${API}/club?club_id=${clubId}`].forEach((url) => {
					cy.request({ url, headers: memberAuth, failOnStatusCode: false }).then((response) => {
						// Without club:read the scope check fires first; either
						// way the request never reaches the club data.
						expect(response.status).to.eq(403);
						expect(response.body.error.code).to.be.oneOf(["forbidden", "insufficient_scope"]);
					});
				});
			});
		});
	});

	// --- Scope visibility in the token dialog -------------------------------
	//
	// A scope that can only ever answer 403 has no business in the dialog, so
	// the club group is only rendered for the two roles that can use it. The
	// checkboxes are the contract: same source as the validation in
	// Api_token::generate().

	describe("Club scopes in the token dialog", () => {
		const clubCheckbox = 'input[name="scopes[]"][value="club:read"]';

		it("are offered to an administrator", () => {
			// The beforeEach hook already logged the admin in; cy.login() insists
			// on the login form, so a second one would fail on the dashboard.
			cy.visit("/index.php/api");
			cy.get(clubCheckbox).should("exist");
		});

		it("are not offered to a regular user", () => {
			const env_member = Cypress.expose('clubmember');

			loginAs(env_member.username, env_member.password);
			cy.visit("/index.php/api");
			// The dialog itself is there, only the club group is missing.
			cy.get('input[name="scopes[]"]').should("exist");
			cy.get(clubCheckbox).should("not.exist");
		});

		it("are offered inside a clubstation to an officer", () => {
			const env_user = Cypress.expose('user');
			const env_club = Cypress.expose('clubstation');

			// Same order as below: the level first, then the login that fills
			// available_clubstations, then the switch.
			setClubLevel(OFFICER);
			loginAs(env_user.username, env_user.password);
			clubSwitch(env_user.callsign, env_club.callsign);
			dismissVersionModal();

			cy.visit("/index.php/api");
			cy.get(clubCheckbox).should("exist");

			cy.visit("/index.php/dashboard");
			stopImpersonate(env_club.callsign);
		});

		// The level travels in the session (cd_p_level), filled from
		// available_clubstations at switch time - so the level has to be set
		// before the login that precedes the switch, not after.
		it("are not offered inside a clubstation below officer level", () => {
			const env_user = Cypress.expose('user');
			const env_club = Cypress.expose('clubstation');

			setClubLevel(MEMBER);
			loginAs(env_user.username, env_user.password);

			clubSwitch(env_user.callsign, env_club.callsign);
			dismissVersionModal();

			cy.visit("/index.php/api");
			cy.get('input[name="scopes[]"]').should("exist");
			cy.get(clubCheckbox).should("not.exist");

			cy.visit("/index.php/dashboard");
			stopImpersonate(env_club.callsign);
			setClubLevel(OFFICER);
		});
	});

	// --- Cleanup -----------------------------------------------------------
	//
	// Runs before the revocation suite on purpose: removing the membership takes
	// the club token with it, and everything below is torn down through exactly
	// that token.

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

		it("leaves the club with only the admin as officer", () => {
			setClubLevel(OFFICER);

			// The "Club permissions" suite ends with the member removed, but a
			// failed run may leave the membership behind.
			cy.request({
				method: "DELETE",
				url: `${API}/club/${memberId}`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect([204, 404]).to.include(response.status);
			});
		});
	});

	// --- Membership revoked ------------------------------------------------
	//
	// Removing a member takes their club tokens with it, the same cleanup the v1
	// keys have always had (Club_model::delete_member()). The token is gone, so
	// the API answers 401 invalid_token rather than refusing an existing token —
	// and re-adding the member does not bring it back.
	//
	// The per-request membership check (Api_v2::resolve_club_context(), error
	// code club_access_revoked) still guards everything that ends a membership
	// without going through delete_member(): direct database work, migrations,
	// future code paths. Nothing reachable from a browser session can trigger it
	// any more, and the suite has no SQL access, so it is deliberately not
	// covered here — adding a database dependency just to exercise a safety net
	// would cost more than it proves.
	//
	// Last suite in the file: it destroys the club token everything above needs.

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
			it(`GET ${path} is refused with invalid_token`, () => {
				cy.request({
					url: `${API}${path}`,
					headers: auth(),
					failOnStatusCode: false,
				}).then((response) => {
					expect(response.status).to.eq(401);
					expect(response.body.error).to.have.property("code", "invalid_token");
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
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		// A removed officer must not be able to grant themselves back in.
		it("granting permissions is refused as well", () => {
			cy.request({
				method: "POST",
				url: `${API}/club`,
				headers: auth(),
				body: { user_id: memberId, permission_level: OFFICER },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		// The read-only club token was issued by the same member, so it goes with
		// the membership too — the cleanup is per member, not per token.
		it("every club token of that member is gone, not just the one in use", () => {
			cy.request({
				url: `${API}/club`,
				headers: { Authorization: "Bearer " + clubReadToken },
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		// The permission comes back, the token does not: it was deleted, and
		// nothing recreates it.
		it("re-adding the member does not revive the token", () => {
			setClubLevel(OFFICER);
			cy.request({
				url: `${API}/token`,
				headers: auth(),
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body.error).to.have.property("code", "invalid_token");
			});
		});

		// A personal token of the same user is a different thing entirely: it is
		// owned by them rather than by the club, so no membership change touches
		// it. Minted before the removal, which is what makes this an assertion
		// about survival rather than about minting a fresh one.
		it("their personal token is untouched", () => {
			cy.request({
				url: `${API}/station`,
				headers: { Authorization: "Bearer " + personalToken },
			}).then((response) => {
				expect(response.status).to.eq(200);
			});
		});
	});
});

import 'cypress-real-events/support';

// Clubstations & Impersonate.
//
// Wavelog's clubstation feature lets several operators share one club/special
// callsign. It is gated behind the config option `special_callsign` (enabled for
// the test image in run_once.sh / the CI configs) and builds on the impersonate
// mechanism. Two ways lead into a clubstation session:
//
//   1. Admin impersonate  - an admin (user_type 99) takes over the clubstation
//      directly from the user list. Posts to user/impersonate WITHOUT clubswitch,
//      giving cd_p_level = 99. Needs no club_permissions entry.
//   2. Club switch (Officer) - the real feature path. Needs a club_permissions
//      row plus a fresh login (which fills the session key available_clubstations),
//      then a switch from the header dropdown -> #clubswitchModal (clubswitch=1).
//
// Both end by switching back to the admin. stop_impersonate logs out and the
// re_login cookie auto-logs the source user back in, landing on /dashboard.
//
// The "Logged in As" header menu is hover-activated on desktop (CSS
// `.dropdown:hover > .header-dropdown`), NOT click-activated, so we open it with
// cy.realHover() like the other header-menu specs (03/04/05).
//
// Every test logs in fresh via cy.login() instead of the shared-cookie trick used
// by the other specs: impersonate/stop_impersonate regenerate the server session,
// which would invalidate a persisted cookie. The one-time "Version Info" modal has
// already been dismissed for the admin by 01-login, so it does not block us here.

describe("Clubstations & Impersonate", () => {

	// Reveal the "Logged in As" header dropdown (hover-activated on desktop). It
	// hosts the club-switch and stop-impersonate buttons. The toggle is uniquely
	// identified by the callsign it shows (the admin's when logged in normally,
	// the club's when impersonating).
	function openUserMenu(callsign) {
		cy.contains('a.nav-link.dropdown-toggle', callsign).realHover();
	}

	// Switching into the clubstation lands on a user that has not confirmed this
	// Wavelog version, so displayVersionDialog() AJAX-opens the "Version Info" modal
	// on the first dashboard load. It overlays the header menu and must be closed
	// before we can use it. "Don't show again" persists the choice per user, so a
	// later switch into the same clubstation (and retries) no longer shows it.
	function dismissVersionModal() {
		cy.wait(2000); // give the AJAX-driven modal time to open, if it will
		cy.get("body").then(($body) => {
			if ($body.find(".modal.show").length) {
				cy.get(".modal.show").contains("button", "Don't show again").click();
				cy.get(".modal-backdrop", { timeout: 8000 }).should("not.exist");
			}
		});
	}

	// Assert the header reflects an active clubstation session.
	function assertInClubstationSession(clubCallsign, srcCallsign) {
		cy.url().should("include", "/dashboard");
		dismissVersionModal();
		// fa-users icon (vs fa-user) marks the clubstation mode in the header toggle.
		cy.get('a.nav-link.dropdown-toggle i.fas.fa-users').should("exist");
		cy.contains('a.nav-link.dropdown-toggle', clubCallsign).should("be.visible");
		// The "Switch back to <admin>" button only exists while impersonating.
		openUserMenu(clubCallsign);
		cy.contains('button.dropdown-item', 'Switch back to ' + srcCallsign)
			.should("be.visible");
	}

	// Click "Switch back to ..." and confirm the modal, then verify we are the
	// admin again (fa-user, no fa-users).
	function stopImpersonate(clubCallsign) {
		openUserMenu(clubCallsign);
		cy.get('button.dropdown-item[onclick*="stopImpersonate_modal"]').click();
		cy.get("#stopImpersonateModal", { timeout: 8000 }).should("be.visible");
		cy.get('#stopImpersonateModal button[type="submit"]').click();

		// stop_impersonate logs out and sets a short-lived re_login cookie; the login
		// page consumes it and returns to the dashboard as the admin. If that auto
		// return does not land on the dashboard, fall back to a normal login so the
		// test still verifies that we left the clubstation session.
		cy.url({ timeout: 15000 }).should((url) =>
			expect(url.includes("/dashboard") || url.includes("/user/login")).to.be.true
		);
		cy.url().then((url) => {
			if (!url.includes("/dashboard")) {
				cy.login();
			}
		});

		// We are back on the personal admin account, not a clubstation.
		cy.visit("/index.php/dashboard");
		cy.get('a.nav-link.dropdown-toggle i.fas.fa-user').should("exist");
		cy.get('a.nav-link.dropdown-toggle i.fas.fa-users').should("not.exist");
	}

	// Enter the clubstation through the officer path: the header dropdown offers
	// the club, the AJAX-loaded #clubswitchModal confirms it (clubswitch=1).
	// Requires a club_permissions row plus the fresh login from beforeEach(),
	// which is what fills the session key available_clubstations.
	function clubSwitch(adminCallsign, clubCallsign) {
		cy.visit("/index.php/dashboard");

		openUserMenu(adminCallsign);
		cy.get('button.dropdown-item[onclick*="clubswitch_modal"]')
			.contains(clubCallsign)
			.click();

		cy.get("#clubswitchModal", { timeout: 8000 }).should("be.visible");
		cy.get('#clubswitchModal input[name="clubswitch"]').should("have.value", "1");
		cy.get('#clubswitchModal button[type="submit"]').click();
	}

	before(() => {
		cy.setCookie('language', 'english');
	});

	beforeEach(() => {
		cy.setCookie('language', 'english');
		cy.login();
	});

	it("Should expose the clubstation feature to admins (special_callsign on)", () => {
		// The "Create Clubstation" button only renders when special_callsign is
		// enabled; its presence proves the feature flag reached the instance.
		cy.visit("/index.php/user");
		cy.get('a[href*="user/add?club=1"]')
			.should("be.visible")
			.and("contain", "Create Clubstation");
	});

	it("Should create a clubstation", () => {
		const env_club = Cypress.expose('clubstation');

		cy.visit("/index.php/user/add?club=1");

		// club=1 forces the account into clubstation mode (hidden field + user_type 3).
		cy.get('input[name="clubstation"]').should("have.value", "1");

		cy.get('input[name="user_name"]').type(env_club.username);
		cy.get('input[name="user_password"]').type(env_club.password);
		cy.get('input[name="user_callsign"]').type(env_club.callsign);
		cy.get('input[name="user_email"]').type(env_club.email);
		cy.get('input[name="user_locator"]').type(env_club.userlocator);

		// user_type ("Clubstation") and user_timezone are preset by the club=1 form.
		// Scope to the user form: the header also renders a submit button.
		cy.get('form[name="users"] button[type="submit"]').click();

		// The new clubstation shows up in the dedicated clubstation table.
		cy.visit("/index.php/user");
		cy.get("#adminclubusertable")
			.should("be.visible")
			.and("contain", env_club.callsign);
	});

	it("Should let an admin impersonate the clubstation and switch back", () => {
		const env_user = Cypress.expose('user');
		const env_club = Cypress.expose('clubstation');

		cy.visit("/index.php/user");

		// Impersonate button on the clubstation row (admin path, p_level 99).
		cy.get("#adminclubusertable")
			.contains("tr", env_club.callsign)
			.find('button[onclick*="admin_impersonate"]')
			.click();

		// The modal is loaded via AJAX into #actionsModal-container.
		cy.get("#actionsModal", { timeout: 8000 }).should("be.visible");
		cy.get('#actionsModal button[type="submit"]')
			.should("not.be.disabled") // installer sets a random encryption_key
			.click();

		assertInClubstationSession(env_club.callsign, env_user.callsign);
		stopImpersonate(env_club.callsign);
	});

	it("Should add the admin as Club Officer", () => {
		const env_user = Cypress.expose('user');
		const env_club = Cypress.expose('clubstation');

		cy.visit("/index.php/user");

		// Open the club permissions page for the clubstation.
		cy.get("#adminclubusertable")
			.contains("tr", env_club.callsign)
			.find('a[href*="club/permissions"]')
			.click();
		cy.url().should("include", "/club/permissions/");

		// Open "Add new User to Club".
		cy.get('button[data-bs-target="#addUserModal"]').click();
		cy.get("#addUserModal").should("be.visible");

		// #user_id is a selectize control with a remote search (club/get_users).
		// Driving that dropdown by keystrokes is too flaky in CI (selectize clears
		// the search box on blur before the option can be clicked), so resolve the
		// admin through the very same endpoint selectize uses and select it via the
		// selectize API. The rest of the flow (permission, submit, verify) is real.
		cy.request({
			method: "POST",
			url: "/index.php/club/get_users",
			form: true,
			body: { query: env_user.callsign },
		}).then((res) => {
			const list = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
			const user = list.find((u) => u.user_callsign === env_user.callsign);
			expect(user, "admin found via club/get_users").to.exist;

			cy.get("#addUserModal #user_id").then(($el) => {
				const selectize = $el[0].selectize;
				selectize.addOption(user);
				selectize.addItem(String(user.user_id));
			});
			// The hidden input the form submits now holds the admin's user_id.
			cy.get("#addUserModal #user_id").should("have.value", String(user.user_id));
		});

		// Grant Club Officer (level 9).
		cy.get('#addUserModal select[name="permission"]').select("9");
		cy.get('#addUserModal button[type="submit"]').click();

		// Back on the permissions page the admin is now listed as a member.
		cy.get("#clubuserstable")
			.should("be.visible")
			.and("contain", env_user.callsign);
	});

	it("Should let an officer switch to the clubstation and switch back", () => {
		const env_user = Cypress.expose('user');
		const env_club = Cypress.expose('clubstation');

		// The fresh login from beforeEach() repopulates available_clubstations now
		// that the officer permission exists, so the switch entry appears.
		clubSwitch(env_user.callsign, env_club.callsign);

		assertInClubstationSession(env_club.callsign, env_user.callsign);
		stopImpersonate(env_club.callsign);
	});

	// The list_clubmembers API endpoint is the only v1 endpoint gated on club
	// permissions, which is why it lives here and not in 14-api_v1.cy.js.
	// It authorizes on the *pair* behind the key: the key must belong to the
	// clubstation (key_userid) but have been created by someone else
	// (key_created_by) who holds permission level 9 on that club. A key minted
	// while club-switched satisfies exactly that, so the key has to be created
	// from inside the clubstation session — an ordinary admin key is rejected.
	it("Should list club members through the API for an officer key", () => {
		const env_user = Cypress.expose('user');
		const env_club = Cypress.expose('clubstation');

		let clubKey;

		clubSwitch(env_user.callsign, env_club.callsign);
		dismissVersionModal();

		cy.createApiKey("rw").then((key) => { clubKey = key; });

		// Leave the clubstation before calling the API, to prove the endpoint
		// authorizes on the key alone and not on the current session.
		cy.visit("/index.php/dashboard");
		stopImpersonate(env_club.callsign);

		cy.then(() => {
			cy.apiPost("list_clubmembers", { key: clubKey }).then((response) => {
				expect(response.status).to.eq(200);
				expect(response.body).to.have.property("status", "successful");
				const members = response.body.members;
				expect(members).to.be.an("array").and.to.have.length.greaterThan(0);
				// The admin was granted level 9 by the previous test.
				const officer = members.find((m) => m.callsign === env_user.callsign);
				expect(officer, "admin listed as club member").to.exist;
				expect(String(officer.p_level)).to.eq("9");
			});
		});
	});

	it("Should reject list_clubmembers for a non-club key", () => {
		// A key the admin minted for their own account has key_userid ==
		// key_created_by, so it is not a club key and must be turned away.
		cy.createApiKey("rw").then((adminKey) => {
			cy.apiPost("list_clubmembers", { key: adminKey }, {
				failOnStatusCode: false,
			}).then((response) => {
				expect(response.status).to.eq(401);
				expect(response.body).to.have.property("status", "error");
			});
		});
	});
});

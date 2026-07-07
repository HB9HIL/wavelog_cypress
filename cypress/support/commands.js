Cypress.Commands.add("login", () => {

    const env_user = Cypress.expose('user');

	cy.visit("/index.php");
    cy.url().should("include", "/user/login");
    cy.get("body").contains("Username").should("be.visible");

    cy.get('input[name="user_name"]').type(env_user.username);
	cy.get('input[name="user_password"]').type(env_user.password);

    cy.get('button[type="submit"]').wait(100).click();

    cy.url().wait(300).should("include", "/dashboard");
});

Cypress.Commands.add("wrong_login", () => {

    const env_user = Cypress.expose('user');

	cy.visit("/index.php");
    cy.url().should("include", "/user/login");
    cy.get("body").contains("Username").should("be.visible");

    cy.get('input[name="user_name"]').type(env_user.username);
	cy.get('input[name="user_password"]').type(env_user.wrong_password);

    cy.get('button[type="submit"]').wait(100).click();

});

// Wait until the contesting logging engine has finished loading the SCP
// (Super Check Partial) callsign database into the browser. On first load the
// SCP component fetches MASTER.SCP + clublog and stores them in IndexedDB;
// searchCallsign() is a no-op while isLoading is true, so any test that opens
// the engine should wait for this before interacting. The component is exposed
// as window.contestApp.scpComponent (see contest_engine/components/scp.js).
Cypress.Commands.add("waitForScpReady", () => {
    cy.window({ timeout: 30000 }).should((win) => {
        const scp = win.contestApp && win.contestApp.scpComponent;
        expect(scp, "SCP component registered").to.exist;
        expect(scp.isLoading, "SCP still loading").to.eq(false);
        expect(scp.totalCallsigns, "SCP callsign count").to.be.greaterThan(0);
    });
});
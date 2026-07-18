Cypress.Commands.add("login", () => {

    const env_user = Cypress.expose('user');

	cy.visit("/index.php");
    cy.url().should("include", "/user/login");
    cy.get("body").contains("Username").should("be.visible");

    cy.get('input[name="user_name"]').type(env_user.username);
	cy.get('input[name="user_password"]').type(env_user.password);

    cy.get('button[type="submit"]').click();

    // cy.url() retries on its own until the redirect lands; no fixed wait needed.
    cy.url().should("include", "/dashboard");
});

Cypress.Commands.add("wrong_login", () => {

    const env_user = Cypress.expose('user');

	cy.visit("/index.php");
    cy.url().should("include", "/user/login");
    cy.get("body").contains("Username").should("be.visible");

    cy.get('input[name="user_name"]').type(env_user.username);
	cy.get('input[name="user_password"]').type(env_user.wrong_password);

    cy.get('button[type="submit"]').click();

});

// Mint a v1 API key through the web UI (/index.php/api) and yield it.
// There is no API endpoint to create a key, so the UI is the only way. Each
// button POSTs and reloads the page; afterwards the table lists the new key.
// Requires an active admin session (cy.login()).
//
// `type` is 'rw' (read & write) or 'ro' (read-only). The key is read by its
// permission badge rather than by row order, so keys left over from an earlier
// spec cannot shadow the one we just created.
Cypress.Commands.add("createApiKey", (type = "rw") => {
    const button = type === "rw" ? "Create a read & write key" : "Create a read-only key";
    const badge = type === "rw" ? "Read & Write" : "Read-Only";

    cy.visit("/index.php/api");
    cy.get('button').contains(button).click();

    return cy.contains('.badge', badge)
        .closest('tr')
        .find('.api-key')
        .first()
        .invoke('text')
        .then((text) => {
            const key = text.trim();
            expect(key, `${badge} API key`).to.have.length.greaterThan(0);
            return key;
        });
});

// POST a JSON body to a v1 API endpoint. The v1 API expects the key inside the
// body (not a header), so callers pass it there — tests for the missing-key
// case simply leave it out. `options` is merged into the cy.request config,
// which is how error-case tests set failOnStatusCode: false.
Cypress.Commands.add("apiPost", (endpoint, body, options = {}) => {
    return cy.request({
        method: "POST",
        url: `/index.php/api/${endpoint}`,
        body: body,
        ...options,
    });
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
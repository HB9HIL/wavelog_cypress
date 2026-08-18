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

// Mint an API v2 token ("wl2_...") through the web UI and yield its plaintext
// value. Like the v1 keys there is no API endpoint to create one, so the
// session-based controller is the only way: the POST to api_token/generate
// stores the token and flashes the plaintext, and the followed redirect renders
// /index.php/api with the one-time reveal modal we scrape it from.
//
// The token belongs to whoever the *current session* is. Called from a normal
// admin session it yields a personal token (user_id == created_by); called
// while club-switched it yields a club token (user_id = clubstation,
// created_by = the acting member), which is what the clubstation permission
// tests need.
//
// `scopes` is an array of scope ids, `expiry` one of "30" | "90" | "365" or
// anything else for "never".
Cypress.Commands.add("createApiToken", (name, scopes, expiry = "30") => {
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

// ---------------------------------------------------------------------------
// XSS scanning (used by 18-xss.cy.js)
// ---------------------------------------------------------------------------

// Inspect a rendered DOM for traces of the canary payload that escaped its
// context. Returns an array of human-readable findings; empty means clean.
//
// Two checks, because the two output contexts fail in different ways:
//
//   HTML context  An unescaped field turns the payload's <IMG SRC=XSSIMG> into
//                 a real element. Finding that image means some view echoed QSO
//                 data without html_escape().
//
//   JS context    Inline handlers (onclick=, href="javascript:...") only run on
//                 click, so waiting for an alert would never see them. Instead
//                 every handler carrying the canary is parsed with Function():
//                 the payload holds one unbalanced ' and one unbalanced ", so
//                 breaking out of a string literal leaves invalid JS and throws
//                 here. Correctly escaped output parses without complaint.
//
// Handlers *without* the canary are skipped - those are framework code, not
// QSO data, and parsing them would only add noise.
function scanForXss(root) {
    const xss = Cypress.expose('xss');
    const issues = [];

    // `i` flag: some views lower-case the field before printing it.
    if (root.querySelector(`img[src="${xss.image}" i]`)) {
        issues.push(`payload became a real <img src="${xss.image}"> element (HTML context)`);
    }

    const snippets = [];
    root.querySelectorAll("[onclick],[onchange],[onsubmit],[onerror]").forEach((el) => {
        ["onclick", "onchange", "onsubmit", "onerror"].forEach((attr) => {
            const code = el.getAttribute(attr);
            if (code) snippets.push({ where: attr, code: code });
        });
    });
    root.querySelectorAll('a[href^="javascript:" i], area[href^="javascript:" i]').forEach((el) => {
        snippets.push({
            where: "href",
            code: el.getAttribute("href").replace(/^javascript:/i, ""),
        });
    });
    root.querySelectorAll("script:not([src])").forEach((el) => {
        snippets.push({ where: "inline <script>", code: el.textContent });
    });

    snippets
        .filter((s) => s.code.includes(xss.canary))
        .forEach((s) => {
            try {
                new Function(s.code);
            } catch (e) {
                issues.push(`${s.where} is not valid JS (payload broke out): ${s.code.slice(0, 200)}`);
            }
        });

    return issues;
}

// Scan the page currently under test. `label` only shows up in the assertion
// message, so a failing spec names the page without digging through the log.
// Chai renders an array of strings as "Array(1)", which hides the one thing
// worth reading, so the findings are joined into the assertion message itself.
Cypress.Commands.add("checkNoXss", (label) => {
    cy.document().then((doc) => {
        const issues = scanForXss(doc.body);
        expect(issues.join("\n"), `XSS findings on ${label}`).to.equal("");
    });
});

// Same scan for an HTML fragment returned by an AJAX endpoint. A <template> is
// what makes this work: assigning `<tr>`/`<td>` markup to a plain div's
// innerHTML silently drops the table elements (and with them the onclick
// attributes we came for), while a template parses any fragment as-is.
Cypress.Commands.add("checkNoXssInHtml", (html, label) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const issues = scanForXss(tpl.content);
    expect(issues.join("\n"), `XSS findings in ${label}`).to.equal("");
});
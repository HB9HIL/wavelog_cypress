// ***********************************************************
// This support/e2e.js file is automatically processed and
// loaded before your test files in a production environment.
//
// Use this file to set up global configurations and
// behaviors that modify Cypress for your test suite.
//
// For more information, refer to:
// https://on.cypress.io/configuration
// ***********************************************************

// Set global variables
Cypress.expose('db', {
    host: "wavelog-db",
    name: "wavelog",
    user: "wavelog",
    password: "wavelog"
});

Cypress.expose('user', {
    firstname: "John",
    lastname: "Smith",
    callsign: "4W7EST",
    city: "Test City",
    userlocator: "JN47RI",
    dxcc: "switzerl",
    dxcc_selectname: "Switzerland - HB",
    email: "john@example.com",
    username: "john.smith",
    password: "superSafePa33word",
    cnfm_password: "superSafePa33word",
    wrong_password: "wrongPassword"
});

Cypress.expose('stationsetup', {
    public_slug: "cypress",
    logbook_name: "Log 2",
    location_name: "Portable",
    station_callsign: "4W7EST/P",
    station_dxcc: "287",
    station_gridsquare: "JN48RI"
});

// Clubstation used by 13-clubstation.cy.js. A clubstation is just a normal user
// account with the clubstation flag set (created via user/add?club=1). The admin
// (Cypress.expose('user'), callsign 4W7EST) impersonates it directly and is also
// added as Club Officer to test the club-switch path. Avoid a "0" in the callsign
// (the UI renders it as Ø, which complicates text assertions).
Cypress.expose('clubstation', {
    username: "club.test",
    password: "clubSafePa33word",
    callsign: "HB9CLUB",
    email: "club@example.com",
    userlocator: "JN47RI"
});


// Force the English UI for every test. With testIsolation (default since
// Cypress 12) all cookies are cleared before each test, so the language cookie
// has to be re-set here — after the reset, before the test body runs.
// Otherwise Wavelog falls back to the browser/system language (e.g. German).
beforeEach(() => {
    cy.setCookie('language', 'english');
});

// Import commands.js using ES2015 syntax:
import './commands'

// Support for localStorage
import "cypress-localstorage-commands";

// Fail fast: stop the run as soon as the first test fails (see cypress.config.js).
import "cypress-fail-fast";

// Alternatively, you can use CommonJS syntax:
// require('./commands')
import 'cypress-real-events/support';

const pages = [
    { name: "Statistics", url: "/statistics" },
    { name: "Antenna Analytics", url: "/statistics/antennaanalytics" },
    { name: "QSL Statistics", url: "/statistics/qslstats" },
    { name: "Gridsquare Map", url: "/gridmap" },
    { name: "Activated Gridsquares", url: "/activated_gridmap" },
    { name: "Gridsquare Activators", url: "/activators" },
    { name: "Distances Worked", url: "/distances" },
    { name: "Satellite Distance Records", url: "/distancerecords" },
    { name: "Days with QSOs", url: "/dayswithqso" },
    { name: "Timeline", url: "/timeline" },
    { name: "Accumulated Statistics", url: "/accumulated" },
    { name: "Timeplotter", url: "/timeplotter" },
    { name: "Continents", url: "/continents" },
    { name: "Callsign Statistics", url: "/callstats" }
  ];

pages.forEach(page => {
    describe(page.name, () => {
        before(() => {
            cy.setCookie('language', 'english');
            cy.login();
            cy.getCookies().then(cookies => {
                cy.writeFile('cypress/fixtures/cookies.json', cookies);
            });
        });

        beforeEach(() => {
            cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
                cookies.forEach(cookie => {
                    cy.setCookie(cookie.name, cookie.value);
                });
            });
        });

        it("Call the Page from the header menu", () => {
            cy.visit("/index.php/dashboard");

            cy.get(".nav-link")
                .contains("Analytics")
                .realHover();

            cy.get(".dropdown-menu")
                .should("be.visible")
                .contains(page.name)
                .click();

            cy.url().should("include", page.url);
        });
    });
});

// The loop above only proves each analytics page is reachable from the menu.
// This block digs one level deeper into the main Statistics page and checks it
// actually renders its content structure (heading, top-level tabs and the
// General sub-navigation pills), so a broken statistics view is caught.
describe("Statistics page content", () => {
    before(() => {
        cy.setCookie('language', 'english');
        cy.login();
        cy.getCookies().then(cookies => {
            cy.writeFile('cypress/fixtures/cookies.json', cookies);
        });
    });

    beforeEach(() => {
        cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
            cookies.forEach(cookie => {
                cy.setCookie(cookie.name, cookie.value);
            });
        });
    });

    it("Renders the heading and the General statistics pane", () => {
        cy.visit("/index.php/statistics");

        cy.get("h2").should("be.visible");

        // The top-level General/Satellites tab bar (div.tabs) is hidden until
        // there are satellite QSOs, but the General pane is shown by default.
        cy.get("#home")
            .should("have.class", "active");
    });

    it("Shows the General sub-navigation pills", () => {
        cy.visit("/index.php/statistics");

        cy.get("#years-tab").should("be.visible").contains("Years");
        cy.get("#months-tab").should("be.visible").contains("Months");
        cy.get("#mode-tab").should("be.visible").contains("Mode");
        cy.get("#band-tab").should("be.visible").contains("Bands");
    });

    it("Switches between the General sub-tabs", () => {
        cy.visit("/index.php/statistics");

        // The Years pane is active initially; clicking Months activates its pane.
        cy.get("#yearstab").should("have.class", "active");

        cy.get("#months-tab").click();
        cy.get("#monthstab").should("have.class", "active");
        cy.get("#yearstab").should("not.have.class", "active");
    });
});
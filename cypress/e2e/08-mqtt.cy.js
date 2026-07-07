import 'cypress-real-events/support';

// MQTT is a headless, server-side feature: Wavelog publishes events to the
// broker whenever a QSO is logged (UI or API) or the CAT status changes. There
// is no UI to assert on, so these tests trigger each event and then verify the
// published message via a broker subscriber running in the Cypress node process
// (see the mqtt:* tasks in cypress.config.js).
//
// The broker is wired up by the orchestrators (GitHub Actions / GitLab CI /
// run_once.sh): a mosquitto container shares the wavelog docker network under
// the alias "mqtt-broker", and the wavelog image is built with
// mqtt_server=mqtt-broker baked into its config, so publishing is enabled.

describe("MQTT Events", () => {
	// The first (and only) user created by the installer has user_id 1, so all
	// event topics end in "/1".
	const USER_ID = 1;
	// The installer creates a default station location with id 1.
	const STATION_PROFILE_ID = 1;

	let apiKey;

	before(() => {
		cy.setCookie('language', 'english');
		cy.login();
		cy.getCookies().then(cookies => {
			cy.writeFile('cypress/fixtures/cookies.json', cookies);
		});

		// Generate a read & write API key once and remember it for the API tests.
		cy.visit("/index.php/api");
		cy.get('button')
			.contains("Create a read & write key")
			.click();
		cy.get('.api-key')
			.first()
			.invoke('text')
			.then((text) => {
				apiKey = text.trim();
				expect(apiKey, "generated API key").to.have.length.greaterThan(0);
			});
	});

	beforeEach(() => {
		cy.readFile('cypress/fixtures/cookies.json').then(cookies => {
			cookies.forEach(cookie => {
				cy.setCookie(cookie.name, cookie.value);
			});
		});
		// Connect the subscriber (lazily) and clear the buffer so each test only
		// sees messages published by its own action.
		cy.task('mqtt:reset');
	});

	// Poll the buffered broker messages until one matches, then return it.
	function waitForMqtt(matcher, attempts = 40) {
		return cy.task('mqtt:messages').then((messages) => {
			const hit = messages.find(matcher);
			if (hit) {
				return hit;
			}
			if (attempts <= 0) {
				throw new Error(
					"Expected MQTT message not received. Seen topics: " +
						messages.map((m) => m.topic).join(", ")
				);
			}
			return cy.wait(250).then(() => waitForMqtt(matcher, attempts - 1));
		});
	}

	it("Publishes a UI-logged QSO to wavelog/qso/logged/{user_id}", () => {
		cy.visit("/index.php/qso?manual=0");

		// Log a QSO the same way the QSO logging spec does.
		cy.get("#band").select("20m");
		cy.get("#mode").select("SSB");
		cy.get("#callsign").type("DL1MQT").blur();
		// No fixed wait before the click: the confirmation assertion below
		// retries, and retries:2 in the config re-runs the spec if the save
		// handler was not yet bound on the first attempt.
		cy.get('button[id="saveQso"]')
			.click();

		cy.get('body')
			.contains("was added to logbook")
			.should("be.visible");

		waitForMqtt((m) => m.topic === `wavelog/qso/logged/${USER_ID}`).then((message) => {
			const payload = JSON.parse(message.payload);
			expect(payload.COL_CALL).to.match(/DL1MQT/i);
			expect(String(payload.COL_MODE).toUpperCase()).to.eq("SSB");
			expect(String(payload.COL_BAND).toUpperCase()).to.eq("20M");
			// COL_FREQ follows the ADIF convention and is in MHz.
			expect(Number(payload.COL_FREQ)).to.be.greaterThan(0);
			expect(String(payload.user_id)).to.eq(String(USER_ID));
		});
	});

	it("Publishes an API-logged QSO to wavelog/qso/logged/api/{user_id}", () => {
		const adif =
			"<call:6>9A1MQT<qso_date:8>20240101<time_on:4>1201<band:3>15m<mode:3>SSB<eor>";

		cy.request({
			method: "POST",
			url: "/index.php/api/qso",
			body: {
				key: apiKey,
				station_profile_id: STATION_PROFILE_ID,
				type: "adif",
				string: adif,
			},
		}).then((response) => {
			expect(response.status).to.eq(201);
		});

		waitForMqtt((m) => m.topic === `wavelog/qso/logged/api/${USER_ID}`).then((message) => {
			const payload = JSON.parse(message.payload);
			expect(payload.COL_CALL).to.match(/9A1MQT/i);
			expect(String(payload.COL_MODE).toUpperCase()).to.eq("SSB");
			expect(String(payload.user_id)).to.eq(String(USER_ID));
		});
	});

	it("Publishes a CAT update to wavelog/cat/{user_id}", () => {
		cy.request({
			method: "POST",
			url: "/index.php/api/radio",
			body: {
				key: apiKey,
				radio: "CypressRig",
				frequency: 14074000,
				mode: "SSB",
				timestamp: "2024-01-01 12:00:00",
			},
		}).then((response) => {
			expect(response.status).to.eq(200);
			expect(response.body).to.have.property("status", "success");
		});

		waitForMqtt((m) => m.topic === `wavelog/cat/${USER_ID}`).then((message) => {
			const payload = JSON.parse(message.payload);
			// CAT frequencies are in Hz (integer), unlike QSO events (MHz).
			expect(Number(payload.frequency)).to.eq(14074000);
			expect(String(payload.mode).toUpperCase()).to.eq("SSB");
			expect(payload.radio).to.eq("CypressRig");
			expect(String(payload.user_id)).to.eq(String(USER_ID));
		});
	});
});

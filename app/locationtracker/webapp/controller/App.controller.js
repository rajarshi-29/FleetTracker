sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, Fragment, MessageBox, MessageToast) {
  "use strict";

  const MAX_LATENCY_SAMPLES = 200;
  const DEV_ROLE_KEY = "devRole";

  return Controller.extend("com.locationtracker.locationtracker.controller.App", {
    onInit: function () {
      this._watchId = null;
      this._map = null;
      this._polyline = null;
      this._marker = null;
      this._points = [];
      this._clientUpdateLatencyMs = [];
      this._viewModel = this.getOwnerComponent().getModel("appState");
      this._adminCsrfToken = null;
      this._addDriverDialog = null;
      this._leafletLoadPending = false;

      const mapContainer = this.byId("trackerMapContainer");
      if (mapContainer) {
        mapContainer.addEventDelegate({
          onAfterRendering: function () {
            this._ensureMap();
          }.bind(this)
        });
      }

      const mapHost = this.byId("trackerMap");
      if (mapHost) {
        mapHost.addEventDelegate({
          onAfterRendering: function () {
            this._syncPolyline();
          }.bind(this)
        });
      }

      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._ensureMap();
        }.bind(this)
      });

      this._checkAuthStatus();
    },

    onAfterRendering: function () {
      this._ensureMap();
    },

    onLoginTabSelect: function (oEvent) {
      this._viewModel.setProperty("/loginTab", oEvent.getParameter("key"));
    },

    onAdminLoginPress: function () {
      try {
        window.sessionStorage.setItem("adminLoginIntent", "true");
      } catch (e) { /* private browsing may block sessionStorage */ }
      window.location.href = "/login";
    },

    onDriverLoginPress: async function () {
      const credentials = this._viewModel.getProperty("/driverLogin") || {};
      this._viewModel.setProperty("/authError", "");

      try {
        const response = await this._post("/drivers/login", {
          email: credentials.email,
          password: credentials.password
        });

        try {
          window.sessionStorage.setItem("driverLoginIntent", "true");
        } catch (e) { /* private browsing */ }

        this._viewModel.setProperty("/driverLogin/password", "");
        this._viewModel.setProperty("/driverCsrfToken", response.csrfToken || null);
        await this._checkAuthStatus();
        MessageToast.show("Logged in as driver");
      } catch (error) {
        this._clearDriverSessionData();
        this._viewModel.setProperty("/authError", "Invalid email or password.");
        MessageToast.show("Invalid email or password.");
      }
    },

    onLogoutPress: async function () {
      var role = this._viewModel.getProperty("/role");
      if (role === "driver") {
        try {
          await this._post("/drivers/logout", {});
        } catch (error) {
          // Ignore logout errors and reset the UI.
        }
        this._clearDriverSessionData();
        this._setView("loginPage", null);
        return;
      }

      // Clear the admin login intent so the next page load shows
      // the auth chooser instead of auto-detecting the XSUAA session.
      try {
        window.sessionStorage.removeItem("adminLoginIntent");
      } catch (e) { /* private browsing */ }
      window.location.href = "/do/logout";
    },

    onGoToLogin: function () {
      this._viewModel.setProperty("/authError", "");
      this._setView("loginPage", null);
    },

    onOpenAddDriverDialog: async function () {
      if (!this._addDriverDialog) {
        this._addDriverDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.AddDriverDialog",
          controller: this
        });
        this.getView().addDependent(this._addDriverDialog);
      }

      this._viewModel.setProperty("/addDriver", {
        name: "",
        email: "",
        password: "",
        vehicleId: "",
        phone: ""
      });

      this._addDriverDialog.open();
    },

    onCancelAddDriver: function () {
      if (this._addDriverDialog) {
        this._addDriverDialog.close();
      }
    },

    onCreateDriver: async function () {
      const payload = this._viewModel.getProperty("/addDriver") || {};
      if (!payload.name || !payload.email || !payload.password) {
        MessageBox.error("Name, email, and temporary password are required.");
        return;
      }

      try {
        await this._adminPost("/tracker/createDriver", payload);
        if (this._addDriverDialog) {
          this._addDriverDialog.close();
        }
        await this._loadDriverList();
        MessageToast.show("Driver created");
      } catch (error) {
        MessageBox.error(error.message || "Unable to create driver");
      }
    },

    onDeleteDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      if (!driverId) {
        return;
      }

      MessageBox.confirm("Deactivate this driver?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          try {
            await this._adminPost("/tracker/deleteDriver", { driverId });
            await this._loadDriverList();
            MessageToast.show("Driver deactivated");
          } catch (error) {
            MessageBox.error(error.message || "Unable to deactivate driver");
          }
        }.bind(this)
      });
    },

    onReactivateDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      if (!driverId) {
        return;
      }

      MessageBox.confirm("Reactivate this driver?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          try {
            await this._adminPost("/tracker/reactivateDriver", { driverId: driverId });
            await this._loadDriverList();
            MessageToast.show("Driver reactivated");
          } catch (error) {
            MessageBox.error(error.message || "Unable to reactivate driver");
          }
        }.bind(this)
      });
    },

    onPermanentlyDeleteDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      var driverName = context && context.getProperty("name");
      if (!driverId) {
        return;
      }

      MessageBox.warning(
        "Permanently delete driver '" + (driverName || "Unknown") + "'?\n\nThis will remove all associated trips and location data. This action cannot be undone.",
        {
          actions: ["Delete", MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.CANCEL,
          onClose: async function (action) {
            if (action !== "Delete") {
              return;
            }
            try {
              await this._adminPost("/tracker/permanentlyDeleteDriver", { driverId: driverId });
              await this._loadDriverList();
              MessageToast.show("Driver permanently deleted");
            } catch (error) {
              MessageBox.error(error.message || "Unable to delete driver");
            }
          }.bind(this)
        }
      );
    },

    onStartTracking: async function () {
      if (!this._isDriver()) {
        MessageBox.error("Please log in as a driver first.");
        return;
      }

      if (!navigator.geolocation) {
        MessageBox.error("This browser does not support geolocation.");
        return;
      }

      try {
        let trip = this._viewModel.getProperty("/currentTrip");

        if (!trip || trip.status !== "ACTIVE") {
          trip = await this._post("/drivers/startTrip", {
            title: "Trip " + new Date().toLocaleString()
          });
          this._viewModel.setProperty("/currentTrip", trip);
          this._points = [];
          this._syncPolyline();
        }

        this._viewModel.setProperty("/tracking", true);
        this._viewModel.setProperty("/statusText", "Tracking is live");
        this._viewModel.setProperty("/permissionText", "Location access granted");

        this._watchId = navigator.geolocation.watchPosition(
          this._onPositionSuccess.bind(this),
          this._onPositionError.bind(this),
          {
            enableHighAccuracy: true,
            maximumAge: 2000,
            timeout: 10000
          }
        );

        await this.onRefreshPath();
        await this._refreshMetrics();
        MessageToast.show("Trip started");
      } catch (error) {
        MessageBox.error(error.message || "Unable to start tracking.");
      }
    },

    onStopTracking: async function () {
      if (!this._isDriver()) {
        MessageBox.error("Please log in as a driver first.");
        return;
      }

      const trip = this._viewModel.getProperty("/currentTrip");
      if (!trip) {
        return;
      }

      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      try {
        const stoppedTrip = await this._post("/drivers/stopTrip", { tripId: trip.ID });
        this._viewModel.setProperty("/currentTrip", stoppedTrip);
        this._viewModel.setProperty("/tracking", false);
        this._viewModel.setProperty("/statusText", "Tracking stopped");
        await this._refreshMetrics();
        MessageToast.show("Trip stopped");
      } catch (error) {
        MessageBox.error(error.message || "Unable to stop tracking.");
      }
    },

    onRefreshPath: async function () {
      if (!this._isDriver()) {
        return;
      }

      const trip = this._viewModel.getProperty("/currentTrip");
      this._ensureMap();

      if (!trip || !trip.ID) {
        if (this._map) {
          this._map.invalidateSize();
        }
        return;
      }

      try {
        const points = await this._get("/drivers/path/" + trip.ID);
        this._points = (points.value || []).map(function (point) {
          return [Number(point.latitude), Number(point.longitude)];
        });

        const lastPoint = points.value && points.value.length ? points.value[points.value.length - 1] : null;
        this._viewModel.setProperty("/lastPoint", lastPoint);
        this._viewModel.setProperty("/totalPoints", this._points.length);
        this._syncPolyline();
        await this._refreshMetrics();
      } catch (error) {
        MessageBox.error(error.message || "Unable to refresh the path.");
      }
    },

    _checkAuthStatus: async function () {
      this._setView("loading", null);
      this._viewModel.setProperty("/authError", "");

      const devRole = this._readDevRole();
      if (devRole === "driver") {
        this._viewModel.setProperty("/driverProfile", {
          name: "Developer Driver",
          email: "dev-driver@example.com"
        });
        this._setView("driverDashboard", "driver");
        return;
      }
      if (devRole === "admin") {
        this._viewModel.setProperty("/adminProfile", {
          name: "Developer Admin",
          email: "dev-admin@example.com"
        });
        this._setView("adminDashboard", "admin");
        return;
      }

      var driverLoginIntent = false;
      try {
        driverLoginIntent = window.sessionStorage.getItem("driverLoginIntent") === "true";
      } catch (e) { /* private browsing */ }

      if (driverLoginIntent) {
        try {
          const driverResponse = await this._get("/drivers/me");
          if (driverResponse && driverResponse.driver) {
            this._viewModel.setProperty("/driverProfile", driverResponse.driver || null);
            this._viewModel.setProperty("/driverCsrfToken", driverResponse.csrfToken || null);
            this._setView("driverDashboard", "driver");
            await this._loadActiveTrip();
            await this._refreshMetrics();
            return;
          }
        } catch (error) {
          // Driver session not active.
        }
        
        try {
          window.sessionStorage.removeItem("driverLoginIntent");
        } catch (e) { /* private browsing */ }
      }

      // Only probe the XSUAA-protected admin endpoint when the user
      // explicitly clicked "Login as Fleet Admin".  Without this gate
      // the app would auto-detect an existing XSUAA session and skip
      // the auth chooser page entirely.
      var adminLoginIntent = false;
      try {
        adminLoginIntent = window.sessionStorage.getItem("adminLoginIntent") === "true";
      } catch (e) { /* private browsing */ }

      if (adminLoginIntent) {
        try {
          var adminProfile = await this._getAdminProfile();
          if (adminProfile && adminProfile.isFleetAdmin) {
            this._viewModel.setProperty("/adminProfile", adminProfile);
            this._setView("adminDashboard", "admin");
            await this._loadDriverList();
            return;
          }
          if (adminProfile) {
            // Authenticated via XSUAA but does not have the FleetAdmin role.
            this._setView("error401", null);
            return;
          }
        } catch (error) {
          // XSUAA auth failed — fall through to login page.
        }
        // Admin login was intended but auth failed — clear the intent.
        try {
          window.sessionStorage.removeItem("adminLoginIntent");
        } catch (e) { /* private browsing */ }
      }

      this._setView("loginPage", null);
    },

    _loadDriverList: async function () {
      if (!this._isAdmin()) {
        return;
      }

      try {
        const response = await this._adminGet("/tracker/listDrivers()");
        const rawDrivers = this._getODataCollection(response);
        const drivers = rawDrivers.map(function (driver) {
          return this._normalizeDriver(driver);
        }.bind(this));
        this._viewModel.setProperty("/drivers", drivers);
      } catch (error) {
        MessageBox.error(error.message || "Unable to load drivers");
      }
    },

    _getODataCollection: function (response) {
      if (response && Array.isArray(response.value)) {
        return response.value;
      }
      if (response && response.d) {
        if (Array.isArray(response.d.results)) {
          return response.d.results;
        }
        if (Array.isArray(response.d)) {
          return response.d;
        }
      }
      return [];
    },

    _normalizeDriver: function (driver) {
      const safeDriver = driver || {};
      const activeValue = safeDriver.isActive != null ? safeDriver.isActive : safeDriver.ISACTIVE;
      let isActive = null;
      if (activeValue != null) {
        if (typeof activeValue === "boolean") {
          isActive = activeValue;
        } else if (typeof activeValue === "number") {
          isActive = activeValue === 1;
        } else if (typeof activeValue === "string") {
          const normalized = activeValue.trim().toLowerCase();
          isActive = normalized === "true" || normalized === "1";
        } else {
          isActive = Boolean(activeValue);
        }
      }

      const activityStatus = safeDriver.activityStatus || "Idle";

      return {
        ID: safeDriver.ID || safeDriver.Id || safeDriver.id || null,
        name: safeDriver.name || safeDriver.NAME || "",
        email: safeDriver.email || safeDriver.EMAIL || "",
        vehicleId: safeDriver.vehicleId || safeDriver.VEHICLEID || null,
        phone: safeDriver.phone || safeDriver.PHONE || null,
        isActive,
        activityStatus,
        createdAt: safeDriver.createdAt || safeDriver.CREATEDAT || null,
        createdBy: safeDriver.createdBy || safeDriver.CREATEDBY || null,
        modifiedAt: safeDriver.modifiedAt || safeDriver.MODIFIEDAT || null,
        modifiedBy: safeDriver.modifiedBy || safeDriver.MODIFIEDBY || null
      };
    },

    _loadActiveTrip: async function () {
      if (!this._isDriver()) {
        return;
      }

      try {
        const trip = await this._get("/drivers/activeTrip");
        if (trip && trip.ID) {
          this._viewModel.setProperty("/currentTrip", trip);
          this._viewModel.setProperty("/statusText", "Active trip restored");
          await this.onRefreshPath();
        } else {
          this._viewModel.setProperty("/statusText", "Backend reachable, no active trip loaded");
        }
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Backend reachable, no active trip loaded");
      }
    },

    _onPositionSuccess: async function (position) {
      const trip = this._viewModel.getProperty("/currentTrip");
      if (!trip || !trip.ID) {
        return;
      }

      const payload = {
        tripId: trip.ID,
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        accuracy: position.coords.accuracy != null ? Number(position.coords.accuracy.toFixed(2)) : null,
        altitude: position.coords.altitude != null ? Number(position.coords.altitude.toFixed(2)) : null,
        speed: position.coords.speed != null ? Number(position.coords.speed.toFixed(2)) : null,
        heading: position.coords.heading != null ? Number(position.coords.heading.toFixed(2)) : null,
        recordedAt: new Date(position.timestamp).toISOString(),
        source: "browser-geolocation"
      };

      try {
        if (!this._isDriver()) {
          return;
        }

        const clientUpdateStart = this._getHighResTime();
        const point = await this._post("/drivers/recordLocation", payload);
        const latLng = [Number(point.latitude), Number(point.longitude)];
        this._points.push(latLng);
        this._viewModel.setProperty("/lastPoint", point);
        this._viewModel.setProperty("/totalPoints", this._points.length);
        this._viewModel.setProperty("/statusText", "Tracking is live");
        this._syncPolyline(latLng);
        const clientUpdateEnd = this._getHighResTime();
        this._recordClientUpdateLatency(clientUpdateEnd - clientUpdateStart);
        this._refreshMetrics();
      } catch (error) {
        MessageBox.error(error.message || "Unable to persist the current position.");
      }
    },

    _onPositionError: function (error) {
      this._viewModel.setProperty("/permissionText", error.message || "Location permission denied");
      this._viewModel.setProperty("/tracking", false);

      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
    },

    _ensureMap: function () {
      const mapHost = this.byId("trackerMap");
      const mapContainer = mapHost && mapHost.getDomRef();

      if (!mapContainer) {
        return;
      }

      if (!window.L) {
        const component = this.getOwnerComponent();
        if (component && component.getLeafletReady) {
          if (!this._leafletLoadPending) {
            this._leafletLoadPending = true;
            component.getLeafletReady()
              .then(function () {
                this._leafletLoadPending = false;
                this._ensureMap();
              }.bind(this))
              .catch(function () {
                this._leafletLoadPending = false;
                this._viewModel.setProperty("/statusText", "Leaflet failed to load");
              }.bind(this));
          }

          this._viewModel.setProperty("/statusText", "Loading map resources");
          return;
        }

        this._viewModel.setProperty("/statusText", "Leaflet failed to load");
        return;
      }

      const existingContainer = this._map && this._map.getContainer ? this._map.getContainer() : null;
      if (existingContainer && existingContainer !== mapContainer) {
        this._map.remove();
        this._map = null;
        this._polyline = null;
        this._marker = null;
      }

      if (this._map) {
        if (this._map.getContainer && this._map.getContainer() !== mapContainer) {
          this._map.remove();
          this._map = null;
          this._polyline = null;
          this._marker = null;
        } else {
          setTimeout(function () {
            this._map.invalidateSize();
          }.bind(this), 150);
          return;
        }
      }

      try {
        this._map = window.L.map(mapContainer, {
          zoomControl: true
        }).setView([20.5937, 78.9629], 5);

        window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors"
        }).addTo(this._map);

        this._polyline = window.L.polyline([], {
          color: "#0a6ed1",
          weight: 5
        }).addTo(this._map);

        this._viewModel.setProperty("/statusText", "Map ready");

        setTimeout(function () {
          if (this._map) {
            this._map.invalidateSize();
          }
        }.bind(this), 250);
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Map initialization failed");
      }
    },

    _syncPolyline: function (latestPoint) {
      this._ensureMap();

      if (!this._map || !this._polyline) {
        return;
      }

      this._polyline.setLatLngs(this._points);

      if (latestPoint) {
        if (!this._marker) {
          this._marker = window.L.marker(latestPoint).addTo(this._map);
        } else {
          this._marker.setLatLng(latestPoint);
        }

        this._map.setView(latestPoint, 18);
        return;
      }

      if (this._points.length > 1) {
        this._map.fitBounds(this._polyline.getBounds(), { padding: [20, 20] });
      } else if (this._points.length === 1) {
        if (!this._marker) {
          this._marker = window.L.marker(this._points[0]).addTo(this._map);
        } else {
          this._marker.setLatLng(this._points[0]);
        }

        this._map.setView(this._points[0], 18);
      }

      setTimeout(function () {
        if (this._map) {
          this._map.invalidateSize();
        }
      }.bind(this), 150);
    },

    _get: async function (url) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _post: async function (url, payload) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      };
      const csrfToken = this._viewModel.getProperty("/driverCsrfToken");
      if (csrfToken) {
        headers["X-Driver-CSRF-Token"] = csrfToken;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _adminGet: async function (url) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _adminPost: async function (url, payload) {
      const csrfToken = await this._getAdminCsrfToken();
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },


    _getAdminCsrfToken: async function () {
      if (this._adminCsrfToken) {
        return this._adminCsrfToken;
      }

      const response = await fetch("/tracker/$metadata", {
        headers: {
          "X-CSRF-Token": "Fetch",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      this._adminCsrfToken = response.headers.get("X-CSRF-Token");
      return this._adminCsrfToken;
    },

    _extractError: async function (response) {
      try {
        const data = await response.json();
        return data.error && data.error.message ? data.error.message : response.statusText;
      } catch (error) {
        return response.statusText || "Unknown request error";
      }
    },

    _refreshMetrics: async function () {
      try {
        if (!this._isDriver()) {
          this._viewModel.setProperty("/metrics", Object.assign({}, this._viewModel.getProperty("/metrics"), {
            generatedAt: null,
            totalTrips: 0,
            completedTrips: 0,
            completionRate: 0,
            avgPointsPerTrip: 0,
            avgGpsAccuracy: 0,
            avgSessionDurationMs: 0,
            ingestSuccessRate: 0,
            avgIngestLatencyMs: 0,
            avgClientUpdateLatencyMs: 0,
            latestClientUpdateLatencyMs: 0
          }));
          return;
        }

        const metrics = await this._get("/drivers/metrics");
        const averageClientLatency = this._clientUpdateLatencyMs.length
          ? this._clientUpdateLatencyMs.reduce(function (sum, latencyMs) { return sum + latencyMs; }, 0) / this._clientUpdateLatencyMs.length
          : 0;

        const latestLatency = this._clientUpdateLatencyMs.length
          ? this._clientUpdateLatencyMs[this._clientUpdateLatencyMs.length - 1]
          : 0;

        this._viewModel.setProperty("/metrics", Object.assign({}, metrics, {
          avgClientUpdateLatencyMs: Number(averageClientLatency.toFixed(2)),
          latestClientUpdateLatencyMs: Number(latestLatency.toFixed(2))
        }));
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Metrics unavailable");
      }
    },

    _recordClientUpdateLatency: function (latencyMs) {
      if (!Number.isFinite(latencyMs) || latencyMs < 0) {
        return;
      }

      this._clientUpdateLatencyMs.push(latencyMs);
      if (this._clientUpdateLatencyMs.length > MAX_LATENCY_SAMPLES) {
        this._clientUpdateLatencyMs.shift();
      }
    },

    _getHighResTime: function () {
      return window.performance && window.performance.now ? window.performance.now() : Date.now();
    },

    _clearDriverSessionData: function () {
      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      this._viewModel.setProperty("/role", null);
      this._viewModel.setProperty("/driverProfile", null);
      this._viewModel.setProperty("/driverCsrfToken", null);
      this._viewModel.setProperty("/tracking", false);
      this._viewModel.setProperty("/currentTrip", null);
      this._viewModel.setProperty("/lastPoint", null);
      this._viewModel.setProperty("/totalPoints", 0);
      this._viewModel.setProperty("/permissionText", "Awaiting browser location permission");
      this._clientUpdateLatencyMs = [];
      this._points = [];
      this._syncPolyline();
      this._refreshMetrics();
    },

    _setView: function (viewName, role) {
      this._viewModel.setProperty("/sCurrentView", viewName);
      this._viewModel.setProperty("/role", role);
    },

    _readDevRole: function () {
      try {
        const role = window.localStorage.getItem(DEV_ROLE_KEY);
        return role === "admin" || role === "driver" ? role : null;
      } catch (error) {
        return null;
      }
    },

    _isDriver: function () {
      return this._viewModel.getProperty("/role") === "driver";
    },

    _isAdmin: function () {
      return this._viewModel.getProperty("/role") === "admin";
    },

    _getAdminProfile: async function () {
      // Use redirect:"manual" so the approuter's XSUAA 302-redirect to
      // accounts.sap.com is NOT followed by the browser.  Instead we see
      // a "type: opaqueredirect" response and can treat it as "not logged in".
      var response = await fetch("/tracker/me()", {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        redirect: "manual"
      });

      // An opaque redirect (type === "opaqueredirect") means the approuter
      // tried to send us to the IDP login page — treat as unauthenticated.
      if (response.type === "opaqueredirect" || response.status === 0) {
        return null;
      }

      if (!response.ok) {
        var error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      var data = await response.json();

      return {
        name: data && data.name ? data.name : "Fleet Admin",
        email: data && data.email ? data.email : "",
        isFleetAdmin: Boolean(data && data.isAdmin)
      };
    }
  });
});

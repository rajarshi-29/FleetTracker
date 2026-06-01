const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { SELECT, INSERT, UPDATE } = cds.ql;
const { createSecurityContext, XsuaaService, XsaService } = require("@sap/xssec");

module.exports = cds.server;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const nowISO = () => new Date().toISOString();
const PASSWORD_MIN_LENGTH = 8;
const JWT_COOKIE_NAME = "driver_token";
const JWT_EXPIRES_IN = "8h";
const JWT_TTL_MS = 8 * 60 * 60 * 1000;
const DUMMY_BCRYPT_HASH = "$2b$10$hYQfIctt8V3M9zb5z/JEuOsj4dHww64JfQ3MNCWiA3f9aULphQxse";
const roundToTwoDecimals = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const resolveJwtSecret = () => {
  const configuredSecret = process.env.JWT_SECRET_KEY;
  if (configuredSecret) return configuredSecret;
  return process.env.NODE_ENV === "production" ? null : "driver-jwt-dev-secret";
};

let jwtSecret = null;

const issueDriverToken = (driver, csrfToken) => jwt.sign({
  driverId: driver.ID,
  email: driver.email,
  role: "driver",
  csrf: csrfToken
}, jwtSecret, { expiresIn: JWT_EXPIRES_IN });

const readDriverToken = (req) => req.cookies?.[JWT_COOKIE_NAME];
const verifyDriverToken = (token) => {
  try {
    return jwt.verify(token, jwtSecret);
  } catch (error) {
    return null;
  }
};

// Lazily built auth service – created once from XSUAA credentials on first request
let _authService = null;
const getAuthService = () => {
  if (_authService) return _authService;
  const { credentials, config: serviceConfig = {} } = cds.requires.auth || {};
  if (!credentials) return null;
  _authService = credentials.uaadomain
    ? new XsuaaService(credentials, serviceConfig)
    : new XsaService(credentials, serviceConfig);
  return _authService;
};

cds.on("bootstrap", (app) => {
  jwtSecret = resolveJwtSecret();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET_KEY must be configured in production for driver JWT sessions.");
  }

  app.use(cookieParser());
  app.use(require("express").json());

  // After XSUAA authenticates the admin via the /login route, the AppRouter forwards
  // the request here. We immediately redirect the browser to the real app URL so that
  // the UI5 bootstrap resolves "./" correctly against /comlocationtrackerlocationtracker/
  // instead of against /login (which would cause all Component.js/manifest.json loads to 503).
  app.get("/do/admin-login-redirect", (req, res) => {
    res.redirect(302, "/comlocationtrackerlocationtracker/index.html");
  });

  const dbPromise = cds.connect.to("db");
  const driverSelectFields = ["ID", "name", "email", "vehicleId", "phone", "isActive", "admin_ID"];

  const normalizeDriverRecord = (driver) => {
    if (!driver) return null;
    
    let isActive = driver.isActive !== undefined ? driver.isActive : driver.ISACTIVE;
    if (typeof isActive === "number") isActive = isActive === 1;
    else if (typeof isActive === "string") isActive = (isActive.trim().toLowerCase() === "true" || isActive.trim() === "1");
    else isActive = Boolean(isActive);

    return {
      ID: driver.ID || driver.id || driver.Id,
      name: driver.name || driver.NAME,
      email: driver.email || driver.EMAIL,
      vehicleId: driver.vehicleId || driver.VEHICLEID,
      phone: driver.phone || driver.PHONE,
      passwordHash: driver.passwordHash || driver.PASSWORDHASH,
      isActive,
      admin_ID: driver.admin_ID || driver.ADMIN_ID
    };
  };

  const getDriverByEmail = async (db, email) => {
    const res = await db.run(SELECT.one.from("tracker.Drivers").where({ email: normalizeEmail(email) }));
    return normalizeDriverRecord(res);
  };

  const getDriverById = async (db, driverId) => {
    const res = await db.run(SELECT.one.from("tracker.Drivers").columns(...driverSelectFields).where({ ID: driverId }));
    return normalizeDriverRecord(res);
  };

  const normalizeTripRecord = (trip) => {
    if (!trip) return null;
    return {
      ...trip,
      ID: trip.ID || trip.id || trip.Id,
      title: trip.title || trip.TITLE,
      driver_ID: trip.driver_ID || trip.DRIVER_ID,
      startedAt: trip.startedAt || trip.STARTEDAT,
      endedAt: trip.endedAt || trip.ENDEDAT,
      status: trip.status || trip.STATUS
    };
  };

  const getTripById = async (db, tripId) => {
    const res = await db.run(SELECT.one.from("tracker.Trips").where({ ID: tripId }));
    return normalizeTripRecord(res);
  };

  const getActiveTrip = async (db, driverId) => {
    const res = await db.run(
      SELECT.one.from("tracker.Trips")
        .where({ status: "ACTIVE", driver_ID: driverId })
        .orderBy("startedAt desc")
    );
    return normalizeTripRecord(res);
  };

  app.use((req, res, next) => {
    if (req.user) {
      return next();
    }

    const token = readDriverToken(req);
    if (!token) {
      return next();
    }

    const payload = verifyDriverToken(token);
    if (!payload) {
      return next();
    }

    req.driverToken = payload;
    req.user = new cds.User({
      id: payload.email,
      roles: ["Driver"],
      attr: { email: payload.email }
    });
    return next();
  });

  const requireDriverAuth = async (req, res, next) => {
    try {
      const token = readDriverToken(req);
      if (!token) {
        return res.status(401).json({ error: "Driver login required" });
      }

      const payload = verifyDriverToken(token);
      if (!payload) {
        return res.status(401).json({ error: "Driver login required" });
      }

      const db = await dbPromise;
      const driver = await getDriverById(db, payload.driverId);
      if (!driver || !driver.isActive) {
        return res.status(403).json({ error: "No active driver profile is assigned to this login" });
      }

      req.driverToken = payload;
      req.driver = driver;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  const requireDriverCsrf = (req, res, next) => {
    const headerToken = req.headers["x-driver-csrf-token"];
    if (!headerToken || headerToken !== req.driverToken?.csrf) {
      return res.status(403).json({ error: "Invalid or missing CSRF token" });
    }
    return next();
  };

  app.post("/drivers/login", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const db = await dbPromise;
      const driver = await getDriverByEmail(db, email);
      const hashToCompare = driver?.passwordHash || DUMMY_BCRYPT_HASH;
      const passwordOk = await bcrypt.compare(password, hashToCompare);
      if (!driver || !driver.isActive || !driver.passwordHash || !passwordOk) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const csrfToken = crypto.randomBytes(32).toString("hex");
      const token = issueDriverToken(driver, csrfToken);

      res.cookie(JWT_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "Strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: JWT_TTL_MS
      });

      return res.json({
        success: true,
        driver: {
          id: driver.ID,
          name: driver.name,
          email: driver.email
        },
        csrfToken
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/me", async (req, res) => {
    const token = readDriverToken(req);
    if (!token) {
      return res.status(401).json({ error: "Driver login required" });
    }

    const payload = verifyDriverToken(token);
    if (!payload) {
      return res.status(401).json({ error: "Driver login required" });
    }

    const db = await dbPromise;
    const driver = await getDriverById(db, payload.driverId);
    if (!driver || !driver.isActive) {
      return res.status(401).json({ error: "Driver login required" });
    }

    return res.json({
      driver,
      csrfToken: payload.csrf || null
    });
  });

  app.post("/drivers/logout", requireDriverAuth, requireDriverCsrf, async (req, res) => {
    res.clearCookie(JWT_COOKIE_NAME);
    return res.json({ ok: true });
  });

  app.get("/drivers/activeTrip", requireDriverAuth, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const trip = await getActiveTrip(db, req.driver.ID);
      return res.json(trip || null);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/startTrip", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const activeTrip = await getActiveTrip(db, req.driver.ID);
      if (activeTrip) {
        return res.json(activeTrip);
      }

      const entry = {
        ID: cds.utils.uuid(),
        title: req.body?.title || `Trip ${nowISO()}`,
        driver_ID: req.driver.ID,
        startedAt: nowISO(),
        status: "ACTIVE"
      };

      await db.run(INSERT.into("tracker.Trips").entries(entry));
      return res.json(entry);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/stopTrip", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
    try {
      const tripId = req.body?.tripId;
      if (!tripId) {
        return res.status(400).json({ error: "tripId is required" });
      }

      const db = await dbPromise;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }

      await db.run(
        UPDATE("tracker.Trips")
          .set({ status: "COMPLETED", endedAt: nowISO() })
          .where({ ID: tripId })
      );

      const stoppedTrip = await getTripById(db, tripId);
      return res.json(stoppedTrip);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/recordLocation", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
    try {
      const { tripId, latitude, longitude } = req.body || {};
      if (!tripId) {
        return res.status(400).json({ error: "tripId is required" });
      }
      if (latitude == null || longitude == null) {
        return res.status(400).json({ error: "latitude and longitude are required" });
      }

      const db = await dbPromise;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }
      if (trip.status !== "ACTIVE") {
        return res.status(400).json({ error: "Trip is not active" });
      }

      const payload = {
        ID: cds.utils.uuid(),
        trip_ID: tripId,
        latitude,
        longitude,
        accuracy: req.body?.accuracy ?? null,
        altitude: req.body?.altitude ?? null,
        speed: req.body?.speed ?? null,
        heading: req.body?.heading ?? null,
        recordedAt: req.body?.recordedAt || nowISO(),
        createdAt: nowISO(),
        source: req.body?.source || "browser-geolocation"
      };

      await db.run(INSERT.into("tracker.LocationPoints").entries(payload));
      return res.json(payload);
    } catch (error) {
      return next(error);
    }
  });

  const normalizePointRecord = (point) => {
    if (!point) return null;
    return {
      ...point,
      ID: point.ID || point.id || point.Id,
      trip_ID: point.trip_ID || point.TRIP_ID,
      latitude: point.latitude !== undefined ? point.latitude : point.LATITUDE,
      longitude: point.longitude !== undefined ? point.longitude : point.LONGITUDE,
      accuracy: point.accuracy !== undefined ? point.accuracy : point.ACCURACY,
      altitude: point.altitude !== undefined ? point.altitude : point.ALTITUDE,
      speed: point.speed !== undefined ? point.speed : point.SPEED,
      heading: point.heading !== undefined ? point.heading : point.HEADING,
      recordedAt: point.recordedAt || point.RECORDEDAT,
      createdAt: point.createdAt || point.CREATEDAT,
      source: point.source || point.SOURCE
    };
  };

  app.get("/drivers/path/:tripId", requireDriverAuth, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const { tripId } = req.params;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }

      const points = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ trip_ID: tripId })
          .orderBy("recordedAt asc")
      );

      const normalizedPoints = (points || []).map(normalizePointRecord);
      return res.json({ value: normalizedPoints });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/metrics", requireDriverAuth, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const [tripCountRow] = await db.run(
        SELECT.from("tracker.Trips").where({ driver_ID: req.driver.ID }).columns("count(1) as count")
      );
      const [completedTripCountRow] = await db.run(
        SELECT.from("tracker.Trips")
          .where({ driver_ID: req.driver.ID, status: "COMPLETED" })
          .columns("count(1) as count")
      );

      const trips = await db.run(
        SELECT.from("tracker.Trips")
          .columns("ID", "startedAt", "endedAt", "status")
          .where({ driver_ID: req.driver.ID })
      );
      const tripIds = trips.map((t) => t.ID || t.id || t.Id);

      let totalPoints = 0;
      let avgGpsAccuracy = 0;
      let ingestSuccessRate = 0;
      let avgIngestLatencyMs = 0;

      if (tripIds.length > 0) {
        const [pointCountRow] = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds } })
            .columns("count(1) as count")
        );
        totalPoints = Number(pointCountRow?.count || pointCountRow?.COUNT || 0);

        const [accuracyAverageRow] = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds }, accuracy: { "!=": null } })
            .columns("avg(accuracy) as avgAccuracy")
        );
        avgGpsAccuracy = roundToTwoDecimals(Number(accuracyAverageRow?.avgAccuracy || accuracyAverageRow?.AVGACCURACY || 0));

        const timePoints = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds } })
            .columns("recordedAt", "createdAt")
        );

        const latencies = timePoints
          .map((p) => {
            const rAt = p.recordedAt || p.RECORDEDAT;
            const cAt = p.createdAt || p.CREATEDAT;
            return rAt && cAt ? new Date(cAt).getTime() - new Date(rAt).getTime() : -1;
          })
          .filter((l) => l >= 0);

        if (totalPoints > 0) {
          ingestSuccessRate = 100;
        }

        if (latencies.length > 0) {
          avgIngestLatencyMs = roundToTwoDecimals(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        }
      }

      const totalTrips = Number(tripCountRow?.count || tripCountRow?.COUNT || 0);
      const totalCompletedTrips = Number(completedTripCountRow?.count || completedTripCountRow?.COUNT || 0);
      const completionRate = totalTrips ? roundToTwoDecimals((totalCompletedTrips / totalTrips) * 100) : 0;
      const avgPointsPerTrip = totalTrips ? roundToTwoDecimals(totalPoints / totalTrips) : 0;

      const durations = trips
        .filter((trip) => {
          const status = trip.status || trip.STATUS;
          return status === "COMPLETED";
        })
        .map((trip) => {
          const startedAt = trip.startedAt || trip.STARTEDAT;
          const endedAt = trip.endedAt || trip.ENDEDAT;
          return {
            startedAt: startedAt ? new Date(startedAt).getTime() : null,
            endedAt: endedAt ? new Date(endedAt).getTime() : null
          };
        })
        .filter((trip) => Number.isFinite(trip.startedAt) && Number.isFinite(trip.endedAt) && trip.endedAt >= trip.startedAt)
        .map((trip) => trip.endedAt - trip.startedAt);

      const avgSessionDurationMs = durations.length
        ? roundToTwoDecimals(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : 0;

      return res.json({
        generatedAt: nowISO(),
        totalTrips,
        completedTrips: totalCompletedTrips,
        completionRate,
        totalPoints,
        avgPointsPerTrip,
        avgGpsAccuracy,
        avgSessionDurationMs,
        ingestSuccessRate,
        avgIngestLatencyMs
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/tracker/path/:tripId", async (req, res, next) => {
    try {
      const { tripId } = req.params;
      const db = await cds.connect.to("db");
      const authConfig = cds.requires.auth || {};

      if (authConfig.kind === "xsuaa") {
        // Require a Bearer token
        if (!req.headers.authorization) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const svc = getAuthService();
        if (!svc) {
          return res.status(500).json({ error: "XSUAA service not configured" });
        }

        // Verify the JWT – xssec extracts it from req.headers.authorization automatically
        let secCtx;
        try {
          secCtx = await createSecurityContext(svc, { req });
        } catch (err) {
          cds.log("server").warn("JWT verification failed:", err.message);
          return res.status(401).json({ error: "Invalid or expired token" });
        }

        const isDriver = secCtx.checkLocalScope("Driver");
        const isAdmin = secCtx.checkLocalScope("FleetAdmin");

        if (!isDriver && !isAdmin) {
          return res.status(403).json({ error: "Forbidden: requires Driver or FleetAdmin role" });
        }

        const email = normalizeEmail(secCtx.getLogonName());

        if (isDriver) {
          // Fail fast: check driver profile before fetching the trip
          const driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ email })
          );
          if (!driver || !driver.isActive) {
            return res.status(403).json({ error: "No active driver profile is assigned to this login" });
          }
          const trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          if (!trip) {
            return res.status(404).json({ error: "Trip not found" });
          }
          if (trip.driver_ID !== driver.ID) {
            return res.status(403).json({ error: "Drivers can only access their own trips" });
          }
        } else {
          // Fail fast: check admin profile before fetching the trip
          const admin = await db.run(
            SELECT.one.from("tracker.Admins").where({ email })
          );
          if (!admin) {
            return res.status(403).json({ error: "No admin profile found for this login" });
          }
          const trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          if (!trip) {
            return res.status(404).json({ error: "Trip not found" });
          }
          const driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ ID: trip.driver_ID })
          );
          if (!driver || driver.admin_ID !== admin.ID) {
            return res.status(403).json({ error: "Fleet admins can only access their own drivers' trips" });
          }
        }
      }

      const points = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ trip_ID: tripId })
          .orderBy("recordedAt asc")
      );

      res.json({ value: points });
    } catch (error) {
      next(error);
    }
  });
});

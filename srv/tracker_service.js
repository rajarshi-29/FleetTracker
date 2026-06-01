const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const PASSWORD_SALT_ROUNDS = 12;

module.exports = cds.service.impl(function () {
  const { Admins, Drivers, Trips, LocationPoints, MetricSnapshots } = this.entities;

  // Direct DB connection — bypasses the service projection so that
  // write-only columns like passwordHash are not silently stripped.
  const dbDirectPromise = cds.connect.to("db");
  const operationMetrics = {
    startTrip: createMetricBucket(),
    stopTrip: createMetricBucket(),
    recordLocation: createMetricBucket()
  };
  let lastSnapshotAt = null;

  const withOperationMetrics = async (operationName, fn) => {
    const bucket = operationMetrics[operationName];
    const startedAt = Date.now();

    bucket.attempts += 1;

    try {
      const result = await fn();
      bucket.success += 1;
      return result;
    } catch (error) {
      bucket.failure += 1;
      throw error;
    } finally {
      bucket.totalLatencyMs += Date.now() - startedAt;
    }
  };

  const nowISO = () => new Date().toISOString();
  const userId = (req) => req.user?.id;
  const userName = (req) => {
    const attr = req.user?.attr || {};
    const first = attr.firstname || attr.given_name || attr.firstName || attr.givenName || "";
    const last = attr.lastname || attr.family_name || attr.lastName || attr.familyName || "";
    const full = `${first} ${last}`.trim();
    return full || userId(req);
  };
  const isAdmin = (req) => req.user?.is("FleetAdmin");
  const isDriver = (req) => req.user?.is("Driver");

  const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

  const getAdminByEmail = (db, email) =>
    db.run(
      SELECT.one
        .from("tracker.Admins")
        .columns("ID", "name", "email")
        .where({ email: normalizeEmail(email) })
    );

  const getDriverByEmail = (db, email) =>
    db.run(
      SELECT.one
        .from("tracker.Drivers")
        .columns("ID", "name", "email", "vehicleId", "phone", "isActive", "admin_ID")
        .where({ email: normalizeEmail(email) })
    );

  const getTripById = (id) =>
    SELECT.one.from(Trips).where({ ID: id });

  const ensureAdminProfile = async (req) => {
    if (!isAdmin(req)) return null;

    const db = cds.tx(req);
    const email = normalizeEmail(userId(req));
    let admin = await getAdminByEmail(db, email);
    if (admin) return admin;

    admin = {
      ID: cds.utils.uuid(),
      name: userName(req),
      email
    };

    await db.run(INSERT.into("tracker.Admins").entries(admin));
    return admin;
  };

  const requireDriverProfile = async (req) => {
    const driver = await getDriverByEmail(cds.tx(req), userId(req));
    if (!driver || !driver.isActive) {
      return req.reject(403, "No active driver profile is assigned to this login");
    }
    return driver;
  };

  const safeDriverColumns = [
    "ID",
    "createdAt",
    "createdBy",
    "modifiedAt",
    "modifiedBy",
    "name",
    "email",
    "vehicleId",
    "phone",
    "isActive"
  ];

  const getActiveTrip = (driverId) =>
    SELECT.one.from(Trips)
      .where({ status: "ACTIVE", driver_ID: driverId })
      .orderBy("startedAt desc");

  const rejectIfNotTripDriver = async (req, tripId) => {
    const driver = await requireDriverProfile(req);
    if (!driver) return null;

    const trip = await getTripById(tripId);
    if (!trip) return req.reject(404, "Trip not found");
    if (trip.driver_ID !== driver.ID) {
      return req.reject(403, "Drivers can only access their own trips");
    }

    return { trip, driver };
  };

  this.before("READ", Admins, (req) => {
    req.query.where({ email: normalizeEmail(userId(req)) });
  });

  this.before("READ", Drivers, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ email: normalizeEmail(userId(req)) });
  });

  this.before("READ", Trips, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "driver.admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ "driver.email": normalizeEmail(userId(req)) });
  });

  this.before("READ", LocationPoints, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "trip.driver.admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ "trip.driver.email": normalizeEmail(userId(req)) });
  });

  this.on("me", async (req) => {
    return {
      email: normalizeEmail(userId(req)),
      name: userName(req),
      isAdmin: isAdmin(req),
      isDriver: isDriver(req),
      adminId: null,
      driverId: null
    };
  });

  this.on("createDriver", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can create drivers");

    // Use the direct DB handle so passwordHash (which is excluded from the
    // service projection) is not silently stripped from INSERT / UPDATE.
    const rawDb = await dbDirectPromise;
    const email = normalizeEmail(req.data.email);
    const password = String(req.data.password || "");
    if (!email) return req.reject(400, "Driver email is required");
    if (!password || password.length < 8) {
      return req.reject(400, "Driver password is required and must be at least 8 characters");
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);

    const existingDriver = await rawDb.run(
      SELECT.one.from("tracker.Drivers")
        .columns("ID", "name", "email", "vehicleId", "phone", "isActive", "admin_ID")
        .where({ email })
    );
    if (existingDriver && existingDriver.admin_ID !== admin.ID) {
      return req.reject(409, "A driver with this email is already assigned to another admin");
    }

    if (existingDriver) {
      await rawDb.run(UPDATE("tracker.Drivers")
        .set({
          name: req.data.name || existingDriver.name,
          phone: req.data.phone || existingDriver.phone,
          vehicleId: req.data.vehicleId || existingDriver.vehicleId,
          passwordHash,
          isActive: true
        })
        .where({ ID: existingDriver.ID }));
      return rawDb.run(
        SELECT.one.from("tracker.Drivers").columns(...safeDriverColumns).where({ ID: existingDriver.ID })
      );
    }

    const entry = {
      ID: cds.utils.uuid(),
      name: req.data.name || email,
      email,
      vehicleId: req.data.vehicleId || null,
      phone: req.data.phone || null,
      passwordHash,
      isActive: true,
      admin_ID: admin.ID
    };

    await rawDb.run(INSERT.into("tracker.Drivers").entries(entry));
    return rawDb.run(
      SELECT.one.from("tracker.Drivers").columns(...safeDriverColumns).where({ ID: entry.ID })
    );
  });

  this.on("listDrivers", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can list drivers");

    const db = cds.tx(req);
    const drivers = await db.run(
      SELECT.from("tracker.Drivers")
        .columns(...safeDriverColumns)
        .where({ admin_ID: admin.ID })
    );

    const driverIds = drivers.map((d) => d.ID).filter(Boolean);
    let activeTrips = [];
    if (driverIds.length > 0) {
      activeTrips = await db.run(
        SELECT.from("tracker.Trips")
          .columns("driver_ID")
          .where({ status: "ACTIVE", driver_ID: { in: driverIds } })
      );
    }

    const activeDriverIds = new Set(activeTrips.map((t) => t.driver_ID));
    return drivers.map((d) => ({
      ...d,
      activityStatus: activeDriverIds.has(d.ID) ? "On Trip" : "Idle"
    }));
  });

  this.on("deleteDriver", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can deactivate drivers");

    const rawDb = await dbDirectPromise;
    const driverId = req.data?.driverId;
    if (!driverId) return req.reject(400, "driverId is required");

    // Query with admin_ID in the WHERE clause so CAP/HANA handles the column name
    // mapping correctly. Comparing driver.admin_ID in JavaScript fails on HANA because
    // raw DB results return the FK column as ADMIN_ID (uppercase), not admin_ID.
    const driver = await rawDb.run(
      SELECT.one.from("tracker.Drivers")
        .columns("ID")
        .where({ ID: driverId, admin_ID: admin.ID })
    );
    if (!driver) {
      return req.reject(404, "Driver not found");
    }

    await rawDb.run(
      UPDATE("tracker.Drivers")
        .set({ isActive: false })
        .where({ ID: driverId })
    );

    return rawDb.run(
      SELECT.one.from("tracker.Drivers").columns(...safeDriverColumns).where({ ID: driverId })
    );
  });

  this.on("reactivateDriver", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can reactivate drivers");

    const rawDb = await dbDirectPromise;
    const driverId = req.data?.driverId;
    if (!driverId) return req.reject(400, "driverId is required");

    const driver = await rawDb.run(
      SELECT.one.from("tracker.Drivers")
        .columns("ID", "isActive")
        .where({ ID: driverId, admin_ID: admin.ID })
    );
    if (!driver) return req.reject(404, "Driver not found");
    if (driver.isActive) return req.reject(400, "Driver is already active");

    await rawDb.run(
      UPDATE("tracker.Drivers")
        .set({ isActive: true })
        .where({ ID: driverId })
    );

    return rawDb.run(
      SELECT.one.from("tracker.Drivers").columns(...safeDriverColumns).where({ ID: driverId })
    );
  });

  this.on("permanentlyDeleteDriver", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can permanently delete drivers");

    const rawDb = await dbDirectPromise;
    const driverId = req.data?.driverId;
    if (!driverId) return req.reject(400, "driverId is required");

    const driver = await rawDb.run(
      SELECT.one.from("tracker.Drivers")
        .columns("ID")
        .where({ ID: driverId, admin_ID: admin.ID })
    );
    if (!driver) return req.reject(404, "Driver not found");

    // Cascade-delete associated data: LocationPoints → Trips → Sessions → Driver
    const trips = await rawDb.run(
      SELECT.from("tracker.Trips").columns("ID").where({ driver_ID: driverId })
    );
    const tripIds = trips.map((t) => t.ID);

    if (tripIds.length > 0) {
      for (const tid of tripIds) {
        await rawDb.run(DELETE.from("tracker.LocationPoints").where({ trip_ID: tid }));
      }
      await rawDb.run(DELETE.from("tracker.Trips").where({ driver_ID: driverId }));
    }

    await rawDb.run(DELETE.from("tracker.DriverSessions").where({ driver_ID: driverId }));
    await rawDb.run(DELETE.from("tracker.Drivers").where({ ID: driverId }));

    return { message: "Driver permanently deleted" };
  });


  this.on("startTrip", async (req) => {
    return withOperationMetrics("startTrip", async () => {
      const driver = await requireDriverProfile(req);
      if (!driver) return null;

      const activeTrip = await getActiveTrip(driver.ID);
      if (activeTrip) return activeTrip;

      const entry = {
        ID: cds.utils.uuid(),
        title: req.data.title || `Trip ${nowISO()}`,
        driver_ID: driver.ID,
        startedAt: nowISO(),
        status: "ACTIVE"
      };

      await INSERT.into(Trips).entries(entry);
      return entry;
    });
  });

  this.on("stopTrip", async (req) => {
    return withOperationMetrics("stopTrip", async () => {
      const { tripId } = req.data;
      if (!tripId) {
        return req.reject(400, "tripId is required");
      }

      const result = await rejectIfNotTripDriver(req, tripId);
      if (!result) return null;

      await UPDATE(Trips)
        .set({ status: "COMPLETED", endedAt: nowISO() })
        .where({ ID: tripId });

      const stoppedTrip = await getTripById(tripId);
      await captureSnapshotIfDue(true);
      return stoppedTrip;
    });
  });

  this.on("recordLocation", async (req) => {
    return withOperationMetrics("recordLocation", async () => {
      const { tripId, latitude, longitude } = req.data;
      if (!tripId) {
        return req.reject(400, "tripId is required");
      }
      if (latitude == null || longitude == null) {
        return req.reject(400, "latitude and longitude are required");
      }

      const result = await rejectIfNotTripDriver(req, tripId);
      if (!result) return null;
      if (result.trip.status !== "ACTIVE") {
        return req.reject(400, "Trip is not active");
      }

      const payload = {
        ID: cds.utils.uuid(),
        trip_ID: tripId,
        latitude,
        longitude,
        accuracy: req.data.accuracy ?? null,
        altitude: req.data.altitude ?? null,
        speed: req.data.speed ?? null,
        heading: req.data.heading ?? null,
        recordedAt: req.data.recordedAt || nowISO(),
        source: req.data.source || "browser-geolocation"
      };

      await INSERT.into(LocationPoints).entries(payload);
      return payload;
    });
  });

  this.on("activeTrip", async (req) => {
    const driver = await requireDriverProfile(req);
    if (!driver) return null;
    return (await getActiveTrip(driver.ID)) || null;
  });

  this.on("metrics", async () => {
    await captureSnapshotIfDue(false);
    return readCurrentMetrics();
  });

  const captureSnapshotIfDue = async (forceSnapshot) => {
    const now = Date.now();
    const shouldCapture = forceSnapshot || !lastSnapshotAt || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;

    if (!shouldCapture) {
      return null;
    }

    const metrics = await readCurrentMetrics();
    const snapshotEntry = {
      capturedAt: metrics.generatedAt,
      totalTrips: metrics.totalTrips,
      completedTrips: metrics.completedTrips,
      completionRate: metrics.completionRate,
      totalPoints: metrics.totalPoints,
      avgPointsPerTrip: metrics.avgPointsPerTrip,
      avgGpsAccuracy: metrics.avgGpsAccuracy,
      avgSessionDurationMs: metrics.avgSessionDurationMs,
      ingestSuccessRate: metrics.ingestSuccessRate,
      avgIngestLatencyMs: metrics.avgIngestLatencyMs
    };

    await INSERT.into(MetricSnapshots).entries(snapshotEntry);
    lastSnapshotAt = now;
    return snapshotEntry;
  };

  const readCurrentMetrics = async () => {
    const [tripCountRow] = await SELECT.from(Trips).columns("count(1) as count");
    const [completedTripCountRow] = await SELECT.from(Trips).where({ status: "COMPLETED" }).columns("count(1) as count");
    const [pointCountRow] = await SELECT.from(LocationPoints).columns("count(1) as count");
    const [accuracyAverageRow] = await SELECT.from(LocationPoints)
      .where({ accuracy: { "!=": null } })
      .columns("avg(accuracy) as avgAccuracy");

    const completedTrips = await SELECT.from(Trips)
      .where({ status: "COMPLETED" })
      .columns("startedAt", "endedAt");

    const totalTrips = Number(tripCountRow?.count || 0);
    const totalCompletedTrips = Number(completedTripCountRow?.count || 0);
    const totalPoints = Number(pointCountRow?.count || 0);
    const completionRate = totalTrips ? roundToTwoDecimals((totalCompletedTrips / totalTrips) * 100) : 0;
    const avgPointsPerTrip = totalTrips ? roundToTwoDecimals(totalPoints / totalTrips) : 0;
    const avgGpsAccuracy = roundToTwoDecimals(Number(accuracyAverageRow?.avgAccuracy || 0));

    const durations = completedTrips
      .map((trip) => ({
        startedAt: trip.startedAt ? new Date(trip.startedAt).getTime() : null,
        endedAt: trip.endedAt ? new Date(trip.endedAt).getTime() : null
      }))
      .filter((trip) => Number.isFinite(trip.startedAt) && Number.isFinite(trip.endedAt) && trip.endedAt >= trip.startedAt)
      .map((trip) => trip.endedAt - trip.startedAt);

    const avgSessionDurationMs = durations.length
      ? roundToTwoDecimals(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : 0;

    const ingestAttempts = operationMetrics.recordLocation.attempts;
    const ingestSuccess = operationMetrics.recordLocation.success;
    const ingestFailure = operationMetrics.recordLocation.failure;
    const ingestSuccessRate = ingestAttempts ? roundToTwoDecimals((ingestSuccess / ingestAttempts) * 100) : 0;
    const avgIngestLatencyMs = ingestAttempts
      ? roundToTwoDecimals(operationMetrics.recordLocation.totalLatencyMs / ingestAttempts)
      : 0;

    return {
      generatedAt: new Date().toISOString(),
      totalTrips,
      completedTrips: totalCompletedTrips,
      completionRate,
      totalPoints,
      avgPointsPerTrip,
      avgGpsAccuracy,
      avgSessionDurationMs,
      ingestAttempts,
      ingestSuccess,
      ingestFailure,
      ingestSuccessRate,
      avgIngestLatencyMs
    };
  };
});

function createMetricBucket() {
  return {
    attempts: 0,
    success: 0,
    failure: 0,
    totalLatencyMs: 0
  };
}

function roundToTwoDecimals(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

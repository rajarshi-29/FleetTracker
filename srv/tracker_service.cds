using tracker from '../db/schema';

@requires: 'authenticated-user'
service TrackerService @(path : '/tracker') {
  type UserContext {
    email    : String;
    name     : String;
    isAdmin  : Boolean;
    isDriver : Boolean;
    adminId  : UUID;
    driverId : UUID;
  }

  @restrict: [
    { grant: 'READ', to: 'FleetAdmin' },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'FleetAdmin' }
  ]
  entity Admins as projection on tracker.Admins;

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'FleetAdmin' }
  ]
  entity Drivers as projection on tracker.Drivers {
    ID,
    createdAt,
    createdBy,
    modifiedAt,
    modifiedBy,
    name,
    email,
    vehicleId,
    phone,
    isActive,
    admin,
    trips
  };

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'FleetAdmin' }
  ]
  entity Trips as projection on tracker.Trips;

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'FleetAdmin' }
  ]
  entity LocationPoints as projection on tracker.LocationPoints;

  @restrict: [
    { grant: '*', to: 'FleetAdmin' }
  ]
  entity Vehicles as projection on tracker.Vehicles;

  entity MetricSnapshots as projection on tracker.MetricSnapshots;

  function me() returns UserContext;

  @requires: 'FleetAdmin'
  action createDriver(
    name     : String,
    email    : String,
    password : String,
    vehicleId: String,
    phone    : String
  ) returns Drivers;

  @requires: 'FleetAdmin'
  function listDrivers() returns array of Drivers;

  @requires: 'FleetAdmin'
  action deleteDriver(driverId : UUID) returns Drivers;

  @requires: 'FleetAdmin'
  action reactivateDriver(driverId : UUID) returns Drivers;

  @requires: 'FleetAdmin'
  action permanentlyDeleteDriver(driverId : UUID) returns String;

  @requires: 'Driver'
  action startTrip(title : String) returns Trips;

  @requires: 'Driver'
  action stopTrip(tripId : UUID) returns Trips;

  @requires: 'Driver'
  action recordLocation(
    tripId      : UUID,
    latitude    : Decimal(9, 6),
    longitude   : Decimal(9, 6),
    accuracy    : Decimal(9, 2),
    altitude    : Decimal(9, 2),
    speed       : Decimal(9, 2),
    heading     : Decimal(9, 2),
    recordedAt  : Timestamp,
    source      : String(30)
  ) returns LocationPoints;

  @requires: 'Driver'
  function activeTrip() returns Trips;

  function metrics() returns TrackerMetrics;
}

type TrackerMetrics {
  generatedAt          : Timestamp;
  totalTrips           : Integer;
  completedTrips       : Integer;
  completionRate       : Decimal(5, 2);
  totalPoints          : Integer;
  avgPointsPerTrip     : Decimal(9, 2);
  avgGpsAccuracy       : Decimal(9, 2);
  avgSessionDurationMs : Decimal(15, 2);
  ingestAttempts       : Integer;
  ingestSuccess        : Integer;
  ingestFailure        : Integer;
  ingestSuccessRate    : Decimal(5, 2);
  avgIngestLatencyMs   : Decimal(9, 2);
}

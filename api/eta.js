import AdmZip from "adm-zip";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const API_VERSION = "eta-vehiclepos-v1";

const STATIC_GTFS_URL = "https://www.stops.lt/vilnius/vilnius/gtfs.zip";
const VEHICLE_POSITIONS_URL = "https://www.stops.lt/vilnius/vehicle_positions.pb";
const ROUTE_SHORT_NAME = "4G";

const STATIC_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REALTIME_TIMEOUT_MS = 15000;
const MAX_ETA_MIN = 90;
const STALE_VEHICLE_SEC = 1800; // 30 min

const CORRIDORS = [
  {
    id: "pilaite",
    title: "Šilo tiltas → Europos aikštė",
    originLabel: "1129",
    destinationLabel: "0104",
    originStopName: "Šilo tiltas",
    destinationStopName: "Europos aikštė"
  },
  {
    id: "sauletekis",
    title: "Europos aikštė → Šilo tiltas",
    originLabel: "0103",
    destinationLabel: "1139",
    originStopName: "Europos aikštė",
    destinationStopName: "Šilo tiltas"
  }
];

let staticCache = {
  loadedAt: 0,
  data: null
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(value);
      value = "";

      if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    value += char;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(h => String(h || "").trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = cols[idx] != null ? String(cols[idx]).trim() : "";
    });
    return obj;
  });
}

function getZipText(zip, filename) {
  const entry = zip.getEntry(filename);
  if (!entry) {
    throw new Error(`Missing ${filename} in GTFS zip`);
  }
  return entry.getData().toString("utf8");
}

async function fetchBuffer(url, timeoutMs = REALTIME_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function parseGtfsTimeToSeconds(value) {
  const s = String(value || "").trim();
  const parts = s.split(":").map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function getServiceDayBaseUnix(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
}

function gtfsSecondsToUnix(gtfsSeconds, now = new Date()) {
  if (!Number.isFinite(gtfsSeconds)) return null;
  return getServiceDayBaseUnix(now) + gtfsSeconds;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function minutesFromNow(timestampSec, nowSec) {
  if (!Number.isFinite(timestampSec)) return null;
  return Math.max(0, Math.ceil((timestampSec - nowSec) / 60));
}

function chooseBestStopPair(stopsForTrip, stopsById, corridor) {
  const originCandidates = stopsForTrip.filter(s => {
    const stopMeta = stopsById.get(s.stopId);
    return stopMeta && stopMeta.stopNameNorm === normalizeName(corridor.originStopName);
  });

  const destinationCandidates = stopsForTrip.filter(s => {
    const stopMeta = stopsById.get(s.stopId);
    return stopMeta && stopMeta.stopNameNorm === normalizeName(corridor.destinationStopName);
  });

  if (!originCandidates.length || !destinationCandidates.length) return null;

  let bestPair = null;

  for (const origin of originCandidates) {
    for (const destination of destinationCandidates) {
      if (origin.sequence >= destination.sequence) continue;

      if (
        !bestPair ||
        destination.sequence - origin.sequence < bestPair.destinationSequence - bestPair.originSequence
      ) {
        bestPair = {
          originStopId: origin.stopId,
          destinationStopId: destination.stopId,
          originSequence: origin.sequence,
          destinationSequence: destination.sequence,
          originScheduledSecs: origin.scheduledSecs,
          destinationScheduledSecs: destination.scheduledSecs
        };
      }
    }
  }

  return bestPair;
}

async function loadStaticGtfs() {
  const now = Date.now();

  if (staticCache.data && now - staticCache.loadedAt < STATIC_CACHE_TTL_MS) {
    return staticCache.data;
  }

  const zipBuffer = await fetchBuffer(STATIC_GTFS_URL, 30000);
  const zip = new AdmZip(zipBuffer);

  const routes = parseCsv(getZipText(zip, "routes.txt"));
  const trips = parseCsv(getZipText(zip, "trips.txt"));
  const stopTimes = parseCsv(getZipText(zip, "stop_times.txt"));
  const stops = parseCsv(getZipText(zip, "stops.txt"));

  const targetRouteIds = new Set(
    routes
      .filter(r => String(r.route_short_name || "").trim().toLowerCase() === ROUTE_SHORT_NAME.toLowerCase())
      .map(r => String(r.route_id || "").trim())
  );

  if (!targetRouteIds.size) {
    throw new Error("Could not find route 4G in static GTFS");
  }

  const stopsById = new Map();
  for (const stop of stops) {
    const stopId = String(stop.stop_id || "").trim();
    if (!stopId) continue;

    stopsById.set(stopId, {
      stopId,
      stopName: String(stop.stop_name || "").trim(),
      stopNameNorm: normalizeName(stop.stop_name || ""),
      lat: Number(stop.stop_lat),
      lon: Number(stop.stop_lon)
    });
  }

  const tripsById = new Map();
  for (const trip of trips) {
    const routeId = String(trip.route_id || "").trim();
    const tripId = String(trip.trip_id || "").trim();
    if (!tripId || !targetRouteIds.has(routeId)) continue;

    tripsById.set(tripId, {
      tripId,
      routeId,
      headsign: String(trip.trip_headsign || "").trim(),
      directionId: String(trip.direction_id || "").trim(),
      serviceId: String(trip.service_id || "").trim()
    });
  }

  const stopTimesByTrip = new Map();

  for (const st of stopTimes) {
    const tripId = String(st.trip_id || "").trim();
    if (!tripsById.has(tripId)) continue;

    const stopId = String(st.stop_id || "").trim();
    const sequence = Number(st.stop_sequence);
    const arrivalSecs = parseGtfsTimeToSeconds(st.arrival_time);
    const departureSecs = parseGtfsTimeToSeconds(st.departure_time);
    const scheduledSecs = Number.isFinite(arrivalSecs) ? arrivalSecs : departureSecs;

    if (!stopId || !Number.isFinite(sequence) || !Number.isFinite(scheduledSecs)) continue;

    if (!stopTimesByTrip.has(tripId)) {
      stopTimesByTrip.set(tripId, []);
    }

    stopTimesByTrip.get(tripId).push({
      stopId,
      sequence,
      arrivalSecs,
      departureSecs,
      scheduledSecs
    });
  }

  for (const [, list] of stopTimesByTrip.entries()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  const corridorTripIndex = new Map();
  for (const corridor of CORRIDORS) {
    corridorTripIndex.set(corridor.id, new Map());
  }

  for (const [tripId, stopsForTrip] of stopTimesByTrip.entries()) {
    const stopTimesBySequence = new Map();

    for (const stop of stopsForTrip) {
      const stopMeta = stopsById.get(stop.stopId);
      stopTimesBySequence.set(stop.sequence, {
        stopId: stop.stopId,
        scheduledSecs: stop.scheduledSecs,
        lat: stopMeta?.lat ?? null,
        lon: stopMeta?.lon ?? null
      });
    }

    for (const corridor of CORRIDORS) {
      const pair = chooseBestStopPair(stopsForTrip, stopsById, corridor);
      if (!pair) continue;

      corridorTripIndex.get(corridor.id).set(tripId, {
        ...pair,
        stopTimesBySequence
      });
    }
  }

  const data = {
    routesCount: targetRouteIds.size,
    tripsById,
    corridorTripIndex
  };

  staticCache = {
    loadedAt: now,
    data
  };

  return data;
}

function estimateEtaFromVehiclePosition({
  vehicleLat,
  vehicleLon,
  vehicleTimestamp,
  corridorInfo,
  nowSec,
  now
}) {
  if (!Number.isFinite(vehicleLat) || !Number.isFinite(vehicleLon)) return null;
  if (!Number.isFinite(vehicleTimestamp)) return null;

  let nearestSequence = null;
  let nearestDistance = Infinity;

  for (const [sequence, stopInfo] of corridorInfo.stopTimesBySequence.entries()) {
    if (!Number.isFinite(stopInfo.lat) || !Number.isFinite(stopInfo.lon)) continue;

    const d = haversineMeters(vehicleLat, vehicleLon, stopInfo.lat, stopInfo.lon);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearestSequence = Number(sequence);
    }
  }

  if (!Number.isFinite(nearestSequence)) return null;

  const nearestStop = corridorInfo.stopTimesBySequence.get(nearestSequence);
  if (!nearestStop || !Number.isFinite(nearestStop.scheduledSecs)) return null;

  const scheduledNearestTs = gtfsSecondsToUnix(nearestStop.scheduledSecs, now);
  if (!Number.isFinite(scheduledNearestTs)) return null;

  const estimatedDelay = vehicleTimestamp - scheduledNearestTs;

  const originScheduledTs = gtfsSecondsToUnix(corridorInfo.originScheduledSecs, now);
  const destinationScheduledTs = gtfsSecondsToUnix(corridorInfo.destinationScheduledSecs, now);

  if (!Number.isFinite(originScheduledTs)) return null;

  const originTs = originScheduledTs + estimatedDelay;
  const destinationTs = Number.isFinite(destinationScheduledTs)
    ? destinationScheduledTs + estimatedDelay
    : null;

  if (originTs < nowSec - 120) return null;

  return {
    originTs,
    destinationTs,
    nearestSequence,
    nearestDistance,
    estimatedDelay
  };
}

async function loadRealtimeEta(debugMode = false) {
  const staticData = await loadStaticGtfs();
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const vehicleBuffer = await fetchBuffer(VEHICLE_POSITIONS_URL, REALTIME_TIMEOUT_MS);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(vehicleBuffer);

  const results = {};
  for (const corridor of CORRIDORS) {
    results[corridor.id] = [];
  }

  const debug = {
    version: API_VERSION,
    staticRouteIdsFound: staticData.routesCount,
    static4GTripsFound: staticData.tripsById.size,
    staticCorridorTrips: Object.fromEntries(
      CORRIDORS.map(c => [c.id, staticData.corridorTripIndex.get(c.id)?.size || 0])
    ),
    vehicleEntities: 0,
    vehiclePositions: 0,
    matching4GVehicles: 0,
    corridorVehicleMatchesSeen: {
      pilaite: 0,
      sauletekis: 0
    },
    estimatedRows: {
      pilaite: 0,
      sauletekis: 0
    },
    samples: {
      pilaiteRows: [],
      sauletekisRows: []
    }
  };

  for (const entity of feed.entity || []) {
    debug.vehicleEntities += 1;

    const vehicle = entity.vehicle;
    if (!vehicle || !vehicle.trip) continue;

    debug.vehiclePositions += 1;

    const tripId = String(vehicle.trip.tripId || "").trim();
    if (!tripId) continue;

    const tripMeta = staticData.tripsById.get(tripId);
    if (!tripMeta) continue;

    debug.matching4GVehicles += 1;

    const vehicleLat = Number(vehicle.position?.latitude);
    const vehicleLon = Number(vehicle.position?.longitude);
    const vehicleTs = vehicle.timestamp != null ? Number(vehicle.timestamp) : null;
    const vehicleId = vehicle.vehicle?.id ? String(vehicle.vehicle.id) : null;

    if (!Number.isFinite(vehicleTs)) continue;
    if (vehicleTs < nowSec - STALE_VEHICLE_SEC) continue;

    for (const corridor of CORRIDORS) {
      const corridorInfo = staticData.corridorTripIndex.get(corridor.id)?.get(tripId);
      if (!corridorInfo) continue;

      debug.corridorVehicleMatchesSeen[corridor.id] += 1;

      const eta = estimateEtaFromVehiclePosition({
        vehicleLat,
        vehicleLon,
        vehicleTimestamp: vehicleTs,
        corridorInfo,
        nowSec,
        now
      });

      if (!eta) continue;

      const originEtaMin = minutesFromNow(eta.originTs, nowSec);
      const destinationEtaMin = Number.isFinite(eta.destinationTs)
        ? minutesFromNow(eta.destinationTs, nowSec)
        : null;

      if (!Number.isFinite(originEtaMin)) continue;
      if (originEtaMin > MAX_ETA_MIN) continue;

      const row = {
        tripId,
        headsign: tripMeta.headsign || null,
        vehicleId,
        originEtaMin,
        destinationEtaMin,
        travelMinutes:
          Number.isFinite(destinationEtaMin) && Number.isFinite(originEtaMin)
            ? Math.max(0, destinationEtaMin - originEtaMin)
            : null,
        estimateSource: "vehicle_position",
        nearestSequence: eta.nearestSequence,
        nearestDistanceMeters: Math.round(eta.nearestDistance)
      };

      results[corridor.id].push(row);
      debug.estimatedRows[corridor.id] += 1;

      if (debug.samples[`${corridor.id}Rows`].length < 5) {
        debug.samples[`${corridor.id}Rows`].push(row);
      }
    }
  }

  for (const corridor of CORRIDORS) {
    const deduped = new Map();

    for (const item of results[corridor.id]) {
      const existing = deduped.get(item.tripId);
      if (!existing || item.originEtaMin < existing.originEtaMin) {
        deduped.set(item.tripId, item);
      }
    }

    results[corridor.id] = Array.from(deduped.values())
      .sort((a, b) => a.originEtaMin - b.originEtaMin)
      .slice(0, 3);
  }

  return {
    generatedAt: new Date().toISOString(),
    corridors: CORRIDORS.map(corridor => ({
      id: corridor.id,
      title: corridor.title,
      originStopId: corridor.originLabel,
      destinationStopId: corridor.destinationLabel,
      arrivals: results[corridor.id]
    })),
    ...(debugMode ? { debug } : {})
  };
}

export default async function handler(req, res) {
  try {
    const debugMode = String(req.query.debug || "").trim() === "1";
    const payload = await loadRealtimeEta(debugMode);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      ...payload
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      error: "Failed to build realtime ETA",
      details: String(err)
    });
  }
}

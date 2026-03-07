import AdmZip from "adm-zip";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const STATIC_GTFS_URL = "https://www.stops.lt/vilnius/vilnius/gtfs.zip";
const TRIP_UPDATES_URL = "https://www.stops.lt/vilnius/trip_updates.pb";
const ROUTE_SHORT_NAME = "4G";

const STATIC_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REALTIME_TIMEOUT_MS = 15000;

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

function getServiceDateParts(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { y, m, d };
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

function getStopUpdateTime(stopUpdate) {
  const arrivalTime = stopUpdate?.arrival?.time != null ? Number(stopUpdate.arrival.time) : null;
  const departureTime = stopUpdate?.departure?.time != null ? Number(stopUpdate.departure.time) : null;

  if (Number.isFinite(arrivalTime) && arrivalTime > 0) return arrivalTime;
  if (Number.isFinite(departureTime) && departureTime > 0) return departureTime;
  return null;
}

function getStopUpdateDelay(stopUpdate) {
  const arrivalDelay = stopUpdate?.arrival?.delay != null ? Number(stopUpdate.arrival.delay) : null;
  const departureDelay = stopUpdate?.departure?.delay != null ? Number(stopUpdate.departure.delay) : null;

  if (Number.isFinite(arrivalDelay)) return arrivalDelay;
  if (Number.isFinite(departureDelay)) return departureDelay;
  return null;
}

function minutesFromNow(timestampSec, nowSec) {
  if (!Number.isFinite(timestampSec)) return null;
  return Math.max(0, Math.ceil((timestampSec - nowSec) / 60));
}

function findStopUpdate(updates, stopId, stopSequence) {
  if (!Array.isArray(updates) || !updates.length) {
    return { match: null, mode: null };
  }

  const byStopId = updates.find(
    u => String(u.stopId || "").trim() === String(stopId || "").trim()
  );
  if (byStopId) {
    return { match: byStopId, mode: "stop_id" };
  }

  const bySequence = updates.find(u => {
    const seq = Number(u.stopSequence);
    return Number.isFinite(seq) && seq === Number(stopSequence);
  });
  if (bySequence) {
    return { match: bySequence, mode: "stop_sequence" };
  }

  return { match: null, mode: null };
}

function estimateDelaySeconds(updates, targetSequence, stopTimesBySequence) {
  if (!Array.isArray(updates) || !updates.length) return null;

  let best = null;

  for (const update of updates) {
    const seq = Number(update.stopSequence);
    if (!Number.isFinite(seq)) continue;

    const scheduled = stopTimesBySequence.get(seq);
    if (!scheduled) continue;

    const exactTime = getStopUpdateTime(update);
    const explicitDelay = getStopUpdateDelay(update);

    let delay = null;

    if (Number.isFinite(explicitDelay)) {
      delay = explicitDelay;
    } else if (Number.isFinite(exactTime) && Number.isFinite(scheduled.scheduledTs)) {
      delay = exactTime - scheduled.scheduledTs;
    }

    if (!Number.isFinite(delay)) continue;

    const distance = Math.abs(seq - targetSequence);

    if (!best || distance < best.distance) {
      best = { delay, distance, sourceSequence: seq };
    }
  }

  return best;
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
      stopNameNorm: normalizeName(stop.stop_name || "")
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
      directionId: String(trip.direction_id || "").trim()
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
    for (const corridor of CORRIDORS) {
      const originCandidates = stopsForTrip.filter(s => {
        const stopMeta = stopsById.get(s.stopId);
        return stopMeta && stopMeta.stopNameNorm === normalizeName(corridor.originStopName);
      });

      const destinationCandidates = stopsForTrip.filter(s => {
        const stopMeta = stopsById.get(s.stopId);
        return stopMeta && stopMeta.stopNameNorm === normalizeName(corridor.destinationStopName);
      });

      if (!originCandidates.length || !destinationCandidates.length) continue;

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

      if (!bestPair) continue;

      const stopTimesBySequence = new Map();
      for (const stop of stopsForTrip) {
        stopTimesBySequence.set(stop.sequence, {
          stopId: stop.stopId,
          scheduledSecs: stop.scheduledSecs
        });
      }

      corridorTripIndex.get(corridor.id).set(tripId, {
        ...bestPair,
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

async function loadRealtimeEta(debugMode = false) {
  const staticData = await loadStaticGtfs();
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const realtimeBuffer = await fetchBuffer(TRIP_UPDATES_URL, REALTIME_TIMEOUT_MS);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(realtimeBuffer);

  const results = {};
  for (const corridor of CORRIDORS) {
    results[corridor.id] = [];
  }

  const debug = {
    staticRouteIdsFound: staticData.routesCount,
    static4GTripsFound: staticData.tripsById.size,
    staticCorridorTrips: Object.fromEntries(
      CORRIDORS.map(c => [c.id, staticData.corridorTripIndex.get(c.id)?.size || 0])
    ),
    realtimeEntities: 0,
    realtimeTripUpdates: 0,
    realtimeTripIdsMatchingStatic4G: 0,
    corridorTripMatchesSeen: {
      pilaite: 0,
      sauletekis: 0
    },
    exactOriginMatches: 0,
    exactDestinationMatches: 0,
    estimatedOriginMatches: 0,
    estimatedDestinationMatches: 0,
    samples: {
      pilaiteRows: [],
      sauletekisRows: []
    }
  };

  const seenMatchingTripIds = new Set();

  for (const entity of feed.entity || []) {
    debug.realtimeEntities += 1;

    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || !tripUpdate.trip) continue;

    debug.realtimeTripUpdates += 1;

    const tripId = String(tripUpdate.trip.tripId || "").trim();
    if (!tripId) continue;

    const tripMeta = staticData.tripsById.get(tripId);
    if (!tripMeta) continue;

    seenMatchingTripIds.add(tripId);

    const updates = Array.isArray(tripUpdate.stopTimeUpdate) ? tripUpdate.stopTimeUpdate : [];

    for (const corridor of CORRIDORS) {
      const corridorInfo = staticData.corridorTripIndex.get(corridor.id)?.get(tripId);
      if (!corridorInfo) continue;

      debug.corridorTripMatchesSeen[corridor.id] += 1;

      const originResult = findStopUpdate(
        updates,
        corridorInfo.originStopId,
        corridorInfo.originSequence
      );

      const destinationResult = findStopUpdate(
        updates,
        corridorInfo.destinationStopId,
        corridorInfo.destinationSequence
      );

      let originTs = getStopUpdateTime(originResult.match);
      let destinationTs = getStopUpdateTime(destinationResult.match);

      if (Number.isFinite(originTs)) {
        debug.exactOriginMatches += 1;
      }
      if (Number.isFinite(destinationTs)) {
        debug.exactDestinationMatches += 1;
      }

      if (!Number.isFinite(originTs)) {
        const delayInfo = estimateDelaySeconds(
          updates,
          corridorInfo.originSequence,
          corridorInfo.stopTimesBySequence
        );

        if (delayInfo && Number.isFinite(corridorInfo.originScheduledSecs)) {
          originTs = gtfsSecondsToUnix(corridorInfo.originScheduledSecs, now) + delayInfo.delay;
          debug.estimatedOriginMatches += 1;
        }
      }

      if (!Number.isFinite(destinationTs)) {
        const delayInfo = estimateDelaySeconds(
          updates,
          corridorInfo.destinationSequence,
          corridorInfo.stopTimesBySequence
        );

        if (delayInfo && Number.isFinite(corridorInfo.destinationScheduledSecs)) {
          destinationTs = gtfsSecondsToUnix(corridorInfo.destinationScheduledSecs, now) + delayInfo.delay;
          debug.estimatedDestinationMatches += 1;
        }
      }

      if (!Number.isFinite(originTs)) continue;
      if (originTs < nowSec - 120) continue;

      const row = {
        tripId,
        headsign: tripMeta.headsign || null,
        vehicleId: tripUpdate.vehicle?.id ? String(tripUpdate.vehicle.id) : null,
        originEtaMin: minutesFromNow(originTs, nowSec),
        destinationEtaMin: Number.isFinite(destinationTs) ? minutesFromNow(destinationTs, nowSec) : null,
        travelMinutes:
          Number.isFinite(destinationTs) && destinationTs >= originTs
            ? Math.round((destinationTs - originTs) / 60)
            : null
      };

      results[corridor.id].push(row);

      if (debug.samples[`${corridor.id}Rows`].length < 5) {
        debug.samples[`${corridor.id}Rows`].push(row);
      }
    }
  }

  debug.realtimeTripIdsMatchingStatic4G = seenMatchingTripIds.size;

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
      ...payload
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Failed to build realtime ETA",
      details: String(err)
    });
  }
}

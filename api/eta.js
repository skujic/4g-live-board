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
    originStopId: "1129",
    destinationStopId: "0104"
  },
  {
    id: "sauletekis",
    title: "Europos aikštė → Šilo tiltas",
    originStopId: "0103",
    destinationStopId: "1139"
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

  const targetRouteIds = new Set(
    routes
      .filter(r => String(r.route_short_name || "").trim().toLowerCase() === ROUTE_SHORT_NAME.toLowerCase())
      .map(r => String(r.route_id || "").trim())
  );

  if (!targetRouteIds.size) {
    throw new Error("Could not find route 4G in static GTFS");
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
    if (!stopId || !Number.isFinite(sequence)) continue;

    if (!stopTimesByTrip.has(tripId)) {
      stopTimesByTrip.set(tripId, []);
    }

    stopTimesByTrip.get(tripId).push({
      stopId,
      sequence
    });
  }

  for (const [, list] of stopTimesByTrip.entries()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  const corridorTripIndex = new Map();

  for (const corridor of CORRIDORS) {
    corridorTripIndex.set(corridor.id, new Map());
  }

  for (const [tripId, stops] of stopTimesByTrip.entries()) {
    for (const corridor of CORRIDORS) {
      const origin = stops.find(s => s.stopId === corridor.originStopId);
      const destination = stops.find(s => s.stopId === corridor.destinationStopId);

      if (!origin || !destination) continue;
      if (origin.sequence >= destination.sequence) continue;

      corridorTripIndex.get(corridor.id).set(tripId, {
        originStopId: corridor.originStopId,
        destinationStopId: corridor.destinationStopId,
        originSequence: origin.sequence,
        destinationSequence: destination.sequence
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

function getStopUpdateTime(stopUpdate) {
  const arrival = stopUpdate?.arrival?.time ? Number(stopUpdate.arrival.time) : null;
  const departure = stopUpdate?.departure?.time ? Number(stopUpdate.departure.time) : null;

  if (Number.isFinite(arrival) && arrival > 0) return arrival;
  if (Number.isFinite(departure) && departure > 0) return departure;
  return null;
}

function minutesFromNow(timestampSec, nowSec) {
  if (!Number.isFinite(timestampSec)) return null;
  return Math.max(0, Math.ceil((timestampSec - nowSec) / 60));
}

function findStopUpdate(updates, stopId, stopSequence) {
  if (!Array.isArray(updates) || !updates.length) return { match: null, mode: null };

  const byStopId = updates.find(
    u => String(u.stopId || "").trim() === String(stopId || "").trim()
  );
  if (byStopId) return { match: byStopId, mode: "stop_id" };

  const bySequence = updates.find(u => {
    const seq = Number(u.stopSequence);
    return Number.isFinite(seq) && seq === Number(stopSequence);
  });
  if (bySequence) return { match: bySequence, mode: "stop_sequence" };

  return { match: null, mode: null };
}

async function loadRealtimeEta(debugMode = false) {
  const staticData = await loadStaticGtfs();
  const nowSec = Math.floor(Date.now() / 1000);

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
    realtimeTripIdsSeen: 0,
    realtimeTripIdsMatchingStatic4G: 0,
    corridorTripMatchesSeen: {
      pilaite: 0,
      sauletekis: 0
    },
    stopMatchModes: {
      originByStopId: 0,
      originBySequence: 0,
      destinationByStopId: 0,
      destinationBySequence: 0
    },
    samples: {
      realtimeTripIds: [],
      matchingTripIds: [],
      pilaiteRows: [],
      sauletekisRows: []
    }
  };

  const seenRealtimeTripIds = new Set();
  const seenMatchingTripIds = new Set();

  for (const entity of feed.entity || []) {
    debug.realtimeEntities += 1;

    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || !tripUpdate.trip) continue;

    debug.realtimeTripUpdates += 1;

    const tripId = String(tripUpdate.trip.tripId || "").trim();
    if (!tripId) continue;

    if (!seenRealtimeTripIds.has(tripId)) {
      seenRealtimeTripIds.add(tripId);
      if (debug.samples.realtimeTripIds.length < 10) {
        debug.samples.realtimeTripIds.push(tripId);
      }
    }

    const tripMeta = staticData.tripsById.get(tripId);
    if (!tripMeta) continue;

    if (!seenMatchingTripIds.has(tripId)) {
      seenMatchingTripIds.add(tripId);
      if (debug.samples.matchingTripIds.length < 10) {
        debug.samples.matchingTripIds.push(tripId);
      }
    }

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

      if (originResult.mode === "stop_id") debug.stopMatchModes.originByStopId += 1;
      if (originResult.mode === "stop_sequence") debug.stopMatchModes.originBySequence += 1;
      if (destinationResult.mode === "stop_id") debug.stopMatchModes.destinationByStopId += 1;
      if (destinationResult.mode === "stop_sequence") debug.stopMatchModes.destinationBySequence += 1;

      const originTs = getStopUpdateTime(originResult.match);
      const destinationTs = getStopUpdateTime(destinationResult.match);

      if (!originTs || originTs < nowSec - 120) continue;

      const row = {
        tripId,
        headsign: tripMeta.headsign || null,
        vehicleId: tripUpdate.vehicle?.id ? String(tripUpdate.vehicle.id) : null,
        originStopId: corridorInfo.originStopId,
        destinationStopId: corridorInfo.destinationStopId,
        originSequence: corridorInfo.originSequence,
        destinationSequence: corridorInfo.destinationSequence,
        originTimestamp: originTs,
        destinationTimestamp: destinationTs || null,
        originEtaMin: minutesFromNow(originTs, nowSec),
        destinationEtaMin: destinationTs ? minutesFromNow(destinationTs, nowSec) : null,
        travelMinutes:
          destinationTs && destinationTs >= originTs
            ? Math.round((destinationTs - originTs) / 60)
            : null
      };

      results[corridor.id].push(row);

      if (debug.samples[`${corridor.id}Rows`].length < 5) {
        debug.samples[`${corridor.id}Rows`].push(row);
      }
    }
  }

  debug.realtimeTripIdsSeen = seenRealtimeTripIds.size;
  debug.realtimeTripIdsMatchingStatic4G = seenMatchingTripIds.size;

  for (const corridor of CORRIDORS) {
    const deduped = new Map();

    for (const item of results[corridor.id]) {
      const existing = deduped.get(item.tripId);
      if (!existing || item.originTimestamp < existing.originTimestamp) {
        deduped.set(item.tripId, item);
      }
    }

    results[corridor.id] = Array.from(deduped.values())
      .sort((a, b) => a.originTimestamp - b.originTimestamp)
      .slice(0, 3);
  }

  return {
    generatedAt: new Date().toISOString(),
    corridors: CORRIDORS.map(corridor => ({
      id: corridor.id,
      title: corridor.title,
      originStopId: corridor.originStopId,
      destinationStopId: corridor.destinationStopId,
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

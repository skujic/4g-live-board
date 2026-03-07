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
    if (!targetRouteIds.has(routeId) || !tripId) continue;

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
  if (!Array.isArray(updates) || !updates.length) return null;

  // First try exact stop_id match
  const byStopId = updates.find(
    u => String(u.stopId || "").trim() === String(stopId || "").trim()
  );
  if (byStopId) return byStopId;

  // Then try exact stop_sequence match
  const bySequence = updates.find(u => {
    const seq = Number(u.stopSequence);
    return Number.isFinite(seq) && seq === Number(stopSequence);
  });
  if (bySequence) return bySequence;

  return null;
}

async function loadRealtimeEta() {
  const staticData = await loadStaticGtfs();
  const nowSec = Math.floor(Date.now() / 1000);

  const realtimeBuffer = await fetchBuffer(TRIP_UPDATES_URL, REALTIME_TIMEOUT_MS);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(realtimeBuffer);

  const results = {};
  for (const corridor of CORRIDORS) {
    results[corridor.id] = [];
  }

  for (const entity of feed.entity || []) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || !tripUpdate.trip) continue;

    const tripId = String(tripUpdate.trip.tripId || "").trim();
    if (!tripId) continue;

    const tripMeta = staticData.tripsById.get(tripId);
    if (!tripMeta) continue;

    const updates = Array.isArray(tripUpdate.stopTimeUpdate) ? tripUpdate.stopTimeUpdate : [];

    for (const corridor of CORRIDORS) {
      const corridorInfo = staticData.corridorTripIndex.get(corridor.id)?.get(tripId);
      if (!corridorInfo) continue;

      const originUpdate = findStopUpdate(
        updates,
        corridorInfo.originStopId,
        corridorInfo.originSequence
      );

      const destinationUpdate = findStopUpdate(
        updates,
        corridorInfo.destinationStopId,
        corridorInfo.destinationSequence
      );

      const originTs = getStopUpdateTime(originUpdate);
      const destinationTs = getStopUpdateTime(destinationUpdate);

      if (!originTs || originTs < nowSec - 120) continue;

      results[corridor.id].push({
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
      });
    }
  }

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
    }))
  };
}

export default async function handler(req, res) {
  try {
    const payload = await loadRealtimeEta();

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

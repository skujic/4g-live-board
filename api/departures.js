export default async function handler(req, res) {

  const stopId = String(req.query.stop || "").trim();
  const lineFilter = String(req.query.line || "4G").trim().toLowerCase();
  const directionFilter = String(req.query.direction || "").trim().toLowerCase();

  if (!stopId) {
    return res.status(400).json({
      ok: false,
      error: "Missing stop id"
    });
  }

  const url = `https://www.stops.lt/vilnius/departures2.php?stopid=${encodeURIComponent(stopId)}`;

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/plain,text/html,application/xhtml+xml"
      }
    });

    const text = await response.text();

    const rows = text
      .split("\n")
      .map(r => r.trim())
      .filter(Boolean);

    const departures = rows
      .map((row, index) => {

        const parts = row.split(",").map(v => (v || "").trim());
        if (parts.length < 8) return null;

        const type = parts[0].toLowerCase();
        const line = parts[1].toLowerCase();
        const direction = parts[2].toLowerCase();
        const tripId = parts[3];
        const vehicle = parts[4];
        const destination = parts[5];

        if (!["bus","expressbus","trol"].includes(type)) return null;
        if (line !== lineFilter) return null;

        if (directionFilter && direction !== directionFilter) {
          return null;
        }

        return {
          type,
          line: line.toUpperCase(),
          direction,
          tripId,
          vehicle,
          destination,
          etaMinutes: null,
          queueIndex: index + 1,
          raw: row
        };

      })
      .filter(Boolean);

    res.setHeader("Access-Control-Allow-Origin","*");

    return res.status(200).json({
      ok: true,
      stopId,
      lineFilter: lineFilter.toUpperCase(),
      directionFilter: directionFilter || null,
      count: departures.length,
      departures,
      preview: rows.slice(0,10)
    });

  } catch (err) {

    return res.status(500).json({
      ok:false,
      error:"Fetch failed",
      details:String(err)
    });

  }

}

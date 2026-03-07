export default async function handler(req, res) {
  const stopId = req.query.stop;
  const lineFilter = (req.query.line || "4G").trim().toLowerCase();

  if (!stopId) {
    res.status(400).json({ error: "missing stop id", ok: false });
    return;
  }

  const url = `https://www.stops.lt/vilnius/departures2.php?stopid=${stopId}`;

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

    const parsed = [];

    for (const row of rows) {
      const parts = row.split(",");

      // Example:
      // expressbus,4g,b-a,36547,8002KWZ,Pilaitė,-1,45
      if (parts.length < 8) continue;

      const type = (parts[0] || "").trim().toLowerCase();
      const line = (parts[1] || "").trim().toLowerCase();
      const direction = (parts[2] || "").trim();
      const tripId = (parts[3] || "").trim();
      const vehicle = (parts[4] || "").trim();
      const destination = (parts[5] || "").trim();
      const field7 = (parts[6] || "").trim();
      const field8 = (parts[7] || "").trim();
      const numericValue = Number(field8);

      if (!["bus", "expressbus", "trol"].includes(type)) continue;
      if (line !== lineFilter) continue;

      parsed.push({
        type,
        line: line.toUpperCase(),
        direction,
        tripId,
        vehicle,
        destination,
        minutes: Number.isFinite(numericValue) ? numericValue : null,
        rawField: field8,
        raw: row
      });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      stopId,
      lineFilter: lineFilter.toUpperCase(),
      count: parsed.length,
      departures: parsed,
      ok: true,
      preview: rows.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({
      error: "fetch failed",
      details: String(err),
      ok: false
    });
  }
}

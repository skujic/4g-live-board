export default async function handler(req, res) {
  const stopId = req.query.stop;
  const lineFilter = (req.query.line || "4G").trim();

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

      // Expected format:
      // bus,119,a-b,35751,575KWNZ,Egliškės,-1,45
      if (parts.length < 8) continue;

      const type = parts[0]?.trim();
      const line = parts[1]?.trim();
      const destination = parts[5]?.trim();
      const minutesRaw = parts[7]?.trim();
      const minutes = Number(minutesRaw);

      if (type !== "bus") continue;
      if (line !== lineFilter) continue;
      if (!Number.isFinite(minutes)) continue;

      parsed.push({
        line,
        destination,
        minutes
      });
    }

    const unique = [];
    const seen = new Set();

    for (const item of parsed.sort((a, b) => a.minutes - b.minutes)) {
      const key = `${item.line}|${item.destination}|${item.minutes}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      stopId,
      lineFilter,
      count: unique.length,
      departures: unique,
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

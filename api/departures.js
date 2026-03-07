export default async function handler(req, res) {
  const stopId = req.query.stop;

  if (!stopId) {
    res.status(400).json({ error: "missing stop id", ok: false });
    return;
  }

  const url = `https://www.stops.lt/vilnius/departures2.php?stopid=${stopId}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    const html = await response.text();

    // Make parsing much more tolerant
    const text = html.replace(/\s+/g, " ");

    const matches = [
      ...text.matchAll(/4G.{0,200}?(\d+)\s*min/gi),
      ...text.matchAll(/4G.{0,200}?>(\d+)</gi),
      ...text.matchAll(/4G.{0,200}?\b(\d{1,2})\b/gi)
    ];

    const minutes = [...new Set(
      matches
        .map(m => Number(m[1]))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 120)
    )].sort((a, b) => a - b);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      stopId,
      minutes,
      ok: true
    });

  } catch (err) {
    res.status(500).json({
      error: "fetch failed",
      details: String(err),
      ok: false
    });
  }
}

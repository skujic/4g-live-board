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

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      stopId,
      ok: true,
      preview: html.slice(0, 3000)
    });

  } catch (err) {
    res.status(500).json({
      error: "fetch failed",
      details: String(err),
      ok: false
    });
  }
}

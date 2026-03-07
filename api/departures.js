export default async function handler(req, res) {
  const stopId = req.query.stop;

  if (!stopId) {
    res.status(400).json({ error: "missing stop id" });
    return;
  }

  const url = `https://www.stops.lt/vilnius/departures2.php?stopid=${stopId}`;

  try {
    const response = await fetch(url);
    const html = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(html);
  } catch (err) {
    res.status(500).json({ error: "fetch failed" });
  }
}

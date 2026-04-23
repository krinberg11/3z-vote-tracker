const Anthropic = require("@anthropic-ai/sdk");

const MAX_BYTES = 200 * 1024 * 1024; // 200MB

const MATTRESS_BRANDS = [
  "Bear Elite Hybrid",
  "Brooklyn Bedding Aurora Luxe",
  "Helix Midnight Luxe",
  "Leesa Sapira Chill Hybrid",
  "Nolah Evolution 15",
];
const PILLOW_BRANDS = ["Helix ComfortAdjust", "Nolah ArcticCore"];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ error: "No boundary in multipart form" });

    const boundary = "--" + boundaryMatch[1];
    const parts = parseMultipart(body, boundary);

    const namePart = parts.find((p) => p.name === "name");
    const videoPart = parts.find((p) => p.name === "video");

    if (!namePart) return res.status(400).json({ error: "Missing name field" });
    if (!videoPart) return res.status(400).json({ error: "Missing video file" });

    const submitterName = namePart.data.toString("utf8").trim();
    const videoBuffer = videoPart.data;
    const videoMime = videoPart.contentType || "video/mp4";

    if (videoBuffer.length > MAX_BYTES) {
      return res.status(413).json({ 
        error: `Video is ${Math.round(videoBuffer.length / 1024 / 1024)}MB which exceeds the 95MB limit. Please trim your recording to under 2 minutes.` 
      });
    }

    const videoBase64 = videoBuffer.toString("base64");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are verifying Newsweek Reader's Choice 2026 vote submissions for 3Z Brands.

Watch this screen recording carefully. Your job is to count every confirmed vote submission.

A vote is confirmed when:
- The Typeform ballot is visible with a product selected (highlighted/outlined)
- The Submit button is clicked and the screen transitions away from the ballot

Do NOT require a "Thank you" screen — the screen changing after Submit is enough.

Mattress products to watch for: ${MATTRESS_BRANDS.join(", ")}
Pillow products to watch for: ${PILLOW_BRANDS.join(", ")}

The category is determined by the Typeform heading:
- "Best Mattress?" = mattress category
- "Best Pillow?" = pillow category

For each confirmed submission you see, record:
- The product selected
- The category (mattress or pillow)
- The approximate timestamp in seconds

Return ONLY valid JSON, no markdown, no explanation:
{
  "submissions": [
    { "product": "Helix Midnight Luxe", "category": "mattress", "timestamp_seconds": 17 },
    { "product": "Helix Midnight Luxe", "category": "mattress", "timestamp_seconds": 26 }
  ],
  "total_count": 2,
  "notes": "any observations about the recording"
}

If you cannot identify any confirmed submissions, return { "submissions": [], "total_count": 0, "notes": "reason" }`
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: videoMime,
                data: videoBase64,
              },
            },
          ],
        },
      ],
    });

    const rawText = message.content.find((b) => b.type === "text")?.text || "{}";
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch (e) {
      return res.status(500).json({ error: "Claude returned unparseable response", raw: rawText });
    }

    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    const grouped = {};
    (parsed.submissions || []).forEach((s) => {
      const key = `${s.product}||${s.category}`;
      if (!grouped[key]) grouped[key] = { product: s.product, category: s.category, timestamps: [] };
      grouped[key].timestamps.push(s.timestamp_seconds);
    });

    const entries = Object.values(grouped).map((g) => ({
      id: now + Math.random(),
      name: submitterName,
      brand: g.product,
      category: g.category,
      count: g.timestamps.length,
      timestamps: g.timestamps,
      date: today,
      ts: now,
      status: "verified",
    }));

    return res.status(200).json({
      success: true,
      submitter: submitterName,
      total_votes: parsed.total_count || 0,
      entries,
      notes: parsed.notes || "",
      raw_submissions: parsed.submissions || [],
    });
  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
};

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(boundary);

  let start = 0;
  while (start < buffer.length) {
    const bIdx = indexOf(buffer, boundaryBuf, start);
    if (bIdx === -1) break;

    const afterBoundary = bIdx + boundaryBuf.length;
    if (buffer.slice(afterBoundary, afterBoundary + 2).toString() === "--") break;

    let pos = afterBoundary + 2;

    const headers = {};
    while (pos < buffer.length) {
      const lineEnd = indexOf(buffer, Buffer.from("\r\n"), pos);
      if (lineEnd === -1) break;
      const line = buffer.slice(pos, lineEnd).toString("utf8");
      if (line === "") { pos = lineEnd + 2; break; }
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        headers[line.slice(0, colonIdx).toLowerCase().trim()] = line.slice(colonIdx + 1).trim();
      }
      pos = lineEnd + 2;
    }

    const nextBIdx = indexOf(buffer, boundaryBuf, pos);
    const dataEnd = nextBIdx === -1 ? buffer.length : nextBIdx - 2;
    const data = buffer.slice(pos, dataEnd);

    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const contentType = headers["content-type"] || null;

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType,
      data,
    });

    start = nextBIdx === -1 ? buffer.length : nextBIdx;
  }

  return parts;
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

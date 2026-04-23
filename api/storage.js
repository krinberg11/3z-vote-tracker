// Save a verified entry to Vercel KV storage
// This keeps the leaderboard shared across all users

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { kv } = require("@vercel/kv");
  const SK = "votes_3z_v1";

  try {
    if (req.method === "GET") {
      // Return all entries
      const data = await kv.get(SK);
      return res.status(200).json({ entries: data || [] });
    }

    if (req.method === "POST") {
      const { entries: newEntries } = req.body;
      if (!newEntries || !Array.isArray(newEntries)) {
        return res.status(400).json({ error: "entries must be an array" });
      }

      // Load existing, append new, save back
      const existing = (await kv.get(SK)) || [];
      const merged = [...existing, ...newEntries];
      await kv.set(SK, merged);

      return res.status(200).json({ success: true, total: merged.length });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Storage error:", err);
    return res.status(500).json({ error: err.message });
  }
};

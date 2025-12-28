// netlify/functions/compass.js
// Put your key in Netlify Environment Variables:
//   OPENAI_API_KEY = <your key>

const recent = new Map(); // best-effort rate limit per warm instance

function rateLimit(ip, windowMs = 2500) {
  const now = Date.now();
  const last = recent.get(ip) || 0;
  if (now - last < windowMs) return false;
  recent.set(ip, now);
  return true;
}

function safeString(x, max = 800) {
  return String(x || "").slice(0, max);
}

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const ip =
      req.headers.get("x-nf-client-connection-ip") ||
      req.headers.get("x-forwarded-for") ||
      "unknown";

    if (!rateLimit(ip)) {
      return new Response("Too many requests. Please slow down.", { status: 429 });
    }

    const { ingredients } = await req.json().catch(() => ({}));
    const userInput = safeString(ingredients, 700).trim();
    if (!userInput) {
      return new Response("Missing ingredients", { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response("Server missing OPENAI_API_KEY", { status: 500 });
    }

    const system = `
You are Cooking Compass: a calm, practical cooking coach.
You create ONE coherent meal direction from a messy ingredient list.

STRICT INGREDIENT RULES
1) Core ingredients: you may use ONLY what the user typed.
2) Allowed universal staples (always allowed): oil, butter, salt, black pepper, sugar, vinegar, water.
3) Optional pantry items (ONLY as "Optional: ... if you have it"): onion, garlic, chili flakes, paprika powder, cumin, dried oregano, dried thyme, bay leaf.
   - Never assume these exist. Never include them as required ingredients.
4) Do not introduce any other ingredients, sauces, herbs, spices, dairy, broths, etc.

OUTPUT GOAL
- Prefer recognizable/traditional-ish structures: stir-fry, omelet/frittata, traybake/roast, simple soup, basic pasta-style, rice bowl, salad.
- If the user's ingredients strongly suggest a known dish direction, lean into that.
- Do NOT force every ingredient into the dish; select what supports the idea.

CLARITY RULES (NO VAGUE STEPS)
- No exact grams/ml/minutes.
- Each step must be actionable and specific.
- Use sensory cues: "until browned", "until fragrant", "until it smells nutty", "until it tastes balanced".
- If an ingredient needs prep (cut small, pat dry), say it.

FORMAT
Return VALID JSON only (no markdown), with keys:
{
  "title": string,
  "intro": string (1-2 sentences),
  "steps": string[] (5-8 bullets),
  "optional": string[] (2-5 bullets, each must begin with "Optional:"),
  "note": string (1 sentence, helpful)
}
`.trim();

    const user = `
User ingredients/notes:
${userInput}

Return JSON only.
`.trim();

    const body = {
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.65,
      max_tokens: 650
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return new Response(errText || "OpenAI request failed", { status: 502 });
    }

    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}$/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("Model did not return JSON.");
    }

    const out = {
      title: safeString(parsed.title, 140),
      intro: safeString(parsed.intro, 420),
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 8).map(s => safeString(s, 220)) : [],
      optional: Array.isArray(parsed.optional)
        ? parsed.optional.slice(0, 5).map(s => safeString(s, 220)).map(s => s.startsWith("Optional:") ? s : `Optional: ${s}`)
        : [],
      note: safeString(parsed.note, 260)
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response("Server error", { status: 500 });
  }
};

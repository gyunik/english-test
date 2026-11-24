// Vercel Serverless Function: POST /api/generate-exam
// Reads 1..10 base64 images and uses Google Gemini to generate a structured exam JSON.

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX_REQUESTS = 10; // per IP per window
const ipHits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    ipHits.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_MAX_REQUESTS) {
    return false;
  }
  entry.count += 1;
  return true;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildPrompt({ examType, questionCount, gradeLevel, language, extraNotes }) {
  const typeInstruction =
    examType === "multiple-choice"
      ? `ALL ${questionCount} questions MUST have "type": "mc" with exactly 4 distinct options ("options": [string, string, string, string]) and "answer" as an integer 0..3 (balance the correct answer positions across 0, 1, 2, 3).`
      : examType === "fill-in-the-blanks"
      ? `ALL ${questionCount} questions MUST have "type": "fill", with "___" inside "q" where the student types the missing word/phrase, "answer" as the primary expected string, and "accept" as an array of valid lowercase spellings/variants (including the primary answer). Every answer within a section should be unique so the section's Word Bank has no duplicates.`
      : `Create a MIXED exam: roughly half "type": "mc" (4 options, integer "answer" 0..3) and half "type": "fill" (with "___" in "q", string "answer", and "accept" array). Put MC questions in their own section(s) and Fill-in-the-Blank questions in their own section(s).`;

  const langInstruction =
    language === "spanish"
      ? "Write all questions, options, section titles, and explanations in Spanish (except exact English terms shown in the screenshots if it is an English study sheet)."
      : language === "bilingual"
      ? "Write the question prompts and explanations in Spanish, and keep the target vocabulary/answers in English (ideal for Spanish-speaking students studying English)."
      : "Write all questions, options, section titles, and explanations in clear, natural English.";

  return `You are an expert school teacher creating a high-quality exam strictly based on the study material shown in the uploaded screenshot(s).

REQUIREMENTS:
- Target student level: ${gradeLevel}. Keep sentences clear, friendly, unambiguous, and age-appropriate.
- Total questions: EXACTLY ${questionCount}.
- Question format: ${typeInstruction}
- Language: ${langInstruction}
- Group the questions into 1 to 6 logical thematic sections based on the topics visible in the screenshots.
- Every question MUST test concepts, vocabulary, or grammar actually present in the uploaded images.
- Every question MUST have exactly ONE unambiguous correct answer and a brief, helpful 1-sentence "explanation".
${extraNotes ? `- Additional teacher/parent instructions: ${extraNotes}` : ""}

Return ONLY valid JSON matching this exact schema (no markdown fences, no extra commentary):
{
  "title": "Short descriptive exam title",
  "subtitle": "1-sentence instructions for the student",
  "sections": [
    {
      "id": 1,
      "title": "Section topic title",
      "questions": [
        {
          "type": "mc",
          "topic": "Short topic label",
          "q": "Question text with ___ if fill-in sentence",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "answer": 1,
          "explanation": "Short clear explanation of why this is correct."
        },
        {
          "type": "fill",
          "topic": "Short topic label",
          "q": "Sentence with ___ for the missing word.",
          "hint": "Optional short hint in parentheses or empty string",
          "answer": "exact word",
          "accept": ["exact word"],
          "explanation": "Short clear explanation."
        }
      ]
    }
  ]
}`;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server is missing GEMINI_API_KEY environment variable."
    });
  }

  // Optional access code check
  const requiredCode = (process.env.EXAM_ACCESS_CODE || "").trim();
  const body = req.body || {};

  if (requiredCode) {
    const provided = String(body.accessCode || "").trim();
    if (!provided || provided.toLowerCase() !== requiredCode.toLowerCase()) {
      return res.status(401).json({
        error: "Código de acceso incorrecto o faltante. Pedile el código al administrador."
      });
    }
  }

  // Rate limit by IP
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Demasiadas solicitudes en poco tiempo. Esperá unos minutos e intentá de nuevo."
    });
  }

  // Validate images
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) {
    return res.status(400).json({ error: "Tenés que subir al menos una captura de pantalla." });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: "Podés subir hasta 10 imágenes por examen." });
  }

  const validTypes = new Set(["multiple-choice", "fill-in-the-blanks", "mixed"]);
  const examType = validTypes.has(body.examType) ? body.examType : "multiple-choice";
  const questionCount = Math.min(50, Math.max(5, parseInt(body.questionCount, 10) || 15));
  const gradeLevel = String(body.gradeLevel || "5th grade primary (10-11 years old)").slice(0, 100);
  const language = ["english", "spanish", "bilingual"].includes(body.language) ? body.language : "english";
  const extraNotes = String(body.extraNotes || "").trim().slice(0, 400);

  const parts = [];
  for (const img of images) {
    if (!img || typeof img.data !== "string" || typeof img.mimeType !== "string") {
      return res.status(400).json({ error: "Formato de imagen inválido." });
    }
    if (!img.mimeType.startsWith("image/")) {
      return res.status(400).json({ error: "Solo se permiten archivos de imagen." });
    }
    parts.push({
      inline_data: {
        mime_type: img.mimeType,
        data: img.data
      }
    });
  }

  parts.push({
    text: buildPrompt({ examType, questionCount, gradeLevel, language, extraNotes })
  });

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return res.status(502).json({
        error: `Error al consultar la IA (${geminiRes.status}). Revisá la API Key o intentá de nuevo.`
      });
    }

    const geminiJson = await geminiRes.json();
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      return res.status(502).json({
        error: "La IA no devolvió contenido. Probá con imágenes más nítidas."
      });
    }

    // Strip accidental markdown fences if any
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const exam = JSON.parse(cleaned);

    if (!exam || !Array.isArray(exam.sections) || exam.sections.length === 0) {
      return res.status(502).json({
        error: "La respuesta de la IA no tuvo el formato esperado. Intentá de nuevo."
      });
    }

    return res.status(200).json({ exam });
  } catch (err) {
    console.error("generate-exam error:", err);
    return res.status(500).json({
      error: "Ocurrió un error interno al generar el examen. Intentá nuevamente."
    });
  }
};

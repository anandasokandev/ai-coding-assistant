import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json()); // IMPORTANT

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const MODEL = "gpt-4o-mini";

// ------------- Helper for missing body ---------------
function safeBody(req: express.Request, res: express.Response, required: string[]) {
    if (!req.body) {
        res.status(400).json({ error: "Missing JSON body" });
        return null;
    }

    for (const key of required) {
        if (!(key in req.body)) {
            res.status(400).json({ error: `Missing required field: ${key}` });
            return null;
        }
    }

    return req.body;
}

// Safe wrapper for AI requests with simple retry logic
async function safeAIRequest<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (retries <= 0) throw err;
        console.warn("AI request failed, retrying...", err);
        // wait a bit before retrying
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return safeAIRequest(fn, retries - 1);
    }
}

// ---------------- ANALYZE -----------------
app.post("/analyze", async (req, res) => {
    const body = safeBody(req, res, ["code", "language"]);
    if (!body) return;

    const { code, language } = body;

    try {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: [
                {
                    role: "system",
                    content:
                        "Return ONLY JSON array of issues: " +
                        "[{\"message\": \"...\", \"start\": {\"line\":0, \"character\":0}, \"end\": {\"line\":0, \"character\":1}}]"
                }
                ,
                {
                    role: "user",
                    content: `Analyze this ${language} code:\n\n${code}`
                }
            ]
        });

        let issues = [];
        try {
            issues = JSON.parse(response.choices[0].message.content || "[]");
        } catch {
            issues = [];
        }

        res.json({ issues });
    } catch (err) {
        console.error("Analyze error:", err);
        res.status(500).json({ error: "Analyze failed" });
    }
});

// ---------------- FIX -----------------
app.post("/fix", async (req, res) => {
    const { code, language } = req.body;

    if (!code) {
        return res.status(400).json({ error: "Missing code" });
    }

    try {
        const ai = await safeAIRequest(() =>
            client.chat.completions.create({
                model: MODEL,
                messages: [
                    {
                        role: "system",
                        content: `
Fix the code. Return ONLY the fixed code.
Do NOT include explanations.
Do NOT include markdown.
Do NOT include backticks.
Do NOT include code fences.
Always return plain raw code only.
`
                    },
                    { role: "user", content: code }
                ],
                max_tokens: 500
            })
        );

        let raw = ai.choices[0].message.content || "";

        // 🔥 Remove markdown fences: ```ts ... ```
        raw = raw.replace(/```[\s\S]*?```/g, "");

        // 🔥 Remove standalone ```
        raw = raw.replace(/```/g, "");

        // 🔥 Remove language tag markers like ```typescript
        raw = raw.replace(/```[a-zA-Z]*/g, "");

        raw = raw.trim();

        if (!raw) {
            return res.status(500).json({ error: "AI returned empty fix" });
        }

        return res.json({
            success: true,
            output: raw
        });

    } catch (err) {
        console.error("Fix error:", err);
        return res.status(500).json({ error: "Fix failed", details: err });
    }
});


// ---------------- EXPLAIN -----------------
app.post("/explain", async (req, res) => {
    const body = safeBody(req, res, ["code", "language"]);
    if (!body) return;

    const { code, language } = body;

    try {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: [
                { role: "system", content: "Explain this code clearly and simply." },
                { role: "user", content: `Language: ${language}\n\nCode:\n${code}` }
            ]
        });

        res.json({ output: response.choices[0].message.content });
    } catch (err) {
        console.error("Explain error:", err);
        res.status(500).json({ error: "Explain failed" });
    }
});

const PORT = 4000;
app.listen(PORT, () => console.log(`AI Server running on 4000`));

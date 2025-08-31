import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const app = express();
app.use(express.json());

const userFinancialData = []; // Array to store analysis results

app.post("/analyze", async (req, res) => {
  const userText = req.body.text;

  // Enhanced prompt for Gemini to analyze debt and income
  const prompt = `
    Analyze the following financial information. 
    Extract the user's total debt and total income. 
    Respond in JSON format: { "debt": number, "income": number, "summary": string }.
    Text: ${userText}
  `;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" + process.env.AIzaSyCqaGNkClH81Grqg7fbG2cevDzmwug4Xyg,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  const data = await response.json();

  // Try to extract the JSON from Gemini's response
  let analysis = {};
  try {
    const geminiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    analysis = JSON.parse(geminiText.match(/{[\s\S]*}/)?.[0] || "{}");
  } catch (e) {
    analysis = { error: "Could not parse Gemini response." };
  }

  // After parsing analysis
  userFinancialData.push({
    timestamp: Date.now(),
    debt: analysis.debt,
    income: analysis.income,
    summary: analysis.summary
  });

  // Save analysis to file
  const dataFolder = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataFolder)) fs.mkdirSync(dataFolder);

  const filePath = path.join(dataFolder, `${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    debt: analysis.debt,
    income: analysis.income,
    summary: analysis.summary
  }, null, 2));

  res.json(analysis);
});

// Optional: Add an endpoint to get all saved data
app.get("/data", (req, res) => {
  res.json(userFinancialData);
});

app.listen(3000, () => console.log("Server running on port 3000"));

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
dotenv.config();

const app = express();

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json({ limit: '10mb' })); // Add request size limit

const MAX_STORED_RECORDS = 1000; // Prevent memory leak
const userFinancialData = []; // Array to store analysis results

// AI Provider Configuration
const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini'; // 'openai' or 'gemini'
let openaiClient = null;

// Initialize OpenAI client if OpenAI is configured
if (process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

// Helper function to load saved data from disk
function loadSavedData() {
  const dataFolder = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataFolder)) {
    return [];
  }

  try {
    const files = fs.readdirSync(dataFolder).filter(f => f.endsWith('.json'));
    return files.map(file => {
      const filePath = path.join(dataFolder, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      return {
        timestamp: parseInt(path.basename(file, '.json')),
        ...data
      };
    }).sort((a, b) => b.timestamp - a.timestamp); // Sort by newest first
  } catch (error) {
    console.error('Error loading saved data:', error);
    return [];
  }
}

// Analyze financial data using OpenAI (using direct fetch for better compatibility)
async function analyzeWithOpenAI(userText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a financial analyst. Analyze financial information and extract total debt and total income. Respond ONLY with valid JSON in this exact format: {\"debt\": number, \"income\": number, \"summary\": string}"
          },
          {
            role: "user",
            content: `Analyze this financial information: ${userText}`
          }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    const analysis = JSON.parse(responseText);

    // Validate and normalize the response
    if (typeof analysis.debt !== 'number') {
      analysis.debt = parseFloat(analysis.debt) || 0;
    }
    if (typeof analysis.income !== 'number') {
      analysis.income = parseFloat(analysis.income) || 0;
    }
    if (!analysis.summary) {
      analysis.summary = "Financial analysis completed";
    }

    return analysis;
  } catch (error) {
    console.error('OpenAI API Error Details:', error.message);
    throw new Error(error.message || "OpenAI request failed");
  }
}

// Analyze financial data using Gemini
async function analyzeWithGemini(userText) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `
    Analyze the following financial information.
    Extract the user's total debt and total income.
    Respond in JSON format: { "debt": number, "income": number, "summary": string }.
    Text: ${userText}
  `;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error("Gemini API returned an error");
  }

  const geminiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!geminiText) {
    throw new Error("No response text from Gemini");
  }

  const jsonMatch = geminiText.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in Gemini response");
  }

  const analysis = JSON.parse(jsonMatch[0]);

  // Validate and normalize the response
  if (typeof analysis.debt !== 'number') {
    analysis.debt = parseFloat(analysis.debt) || 0;
  }
  if (typeof analysis.income !== 'number') {
    analysis.income = parseFloat(analysis.income) || 0;
  }
  if (!analysis.summary) {
    analysis.summary = "Financial analysis completed";
  }

  return analysis;
}

app.post("/analyze", async (req, res) => {
  try {
    // Input validation
    if (!req.body || !req.body.text) {
      return res.status(400).json({
        error: "Missing required field 'text' in request body"
      });
    }

    const userText = req.body.text;

    // Validate text is not empty
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      return res.status(400).json({
        error: "Field 'text' must be a non-empty string"
      });
    }

    // Allow per-request provider override via query parameter
    const provider = req.query.provider || AI_PROVIDER;

    // Validate provider configuration
    if (provider === 'openai' && !openaiClient) {
      return res.status(500).json({
        error: "OpenAI is not configured. Please set OPENAI_API_KEY in environment variables."
      });
    }

    if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Gemini is not configured. Please set GEMINI_API_KEY in environment variables."
      });
    }

    // Analyze using selected provider
    let analysis = {};
    try {
      if (provider === 'openai') {
        console.log('Analyzing with OpenAI...');
        analysis = await analyzeWithOpenAI(userText);
      } else if (provider === 'gemini') {
        console.log('Analyzing with Gemini...');
        analysis = await analyzeWithGemini(userText);
      } else {
        return res.status(400).json({
          error: `Invalid AI provider: ${provider}. Use 'openai' or 'gemini'.`
        });
      }
    } catch (e) {
      console.error(`Error with ${provider} analysis:`, e.message);
      return res.status(502).json({
        error: `Failed to analyze with ${provider}. ${e.message}`
      });
    }

    // Use a more unique timestamp with random component to avoid collisions
    const timestamp = Date.now();
    const uniqueId = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;

    // Prepare data to store
    const dataToStore = {
      timestamp: timestamp,
      debt: analysis.debt,
      income: analysis.income,
      summary: analysis.summary,
      provider: provider // Track which AI provider was used
    };

    // Save analysis to file
    const dataFolder = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataFolder)) {
      fs.mkdirSync(dataFolder, { recursive: true });
    }

    const filePath = path.join(dataFolder, `${uniqueId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(dataToStore, null, 2));

    // After parsing analysis, add to in-memory array
    userFinancialData.push(dataToStore);

    // Prevent memory leak - keep only latest records
    if (userFinancialData.length > MAX_STORED_RECORDS) {
      userFinancialData.shift(); // Remove oldest record
    }

    res.status(200).json(analysis);
  } catch (error) {
    console.error('Unexpected error in /analyze:', error);
    res.status(500).json({
      error: "An unexpected error occurred. Please try again later."
    });
  }
});

// Get all saved data (from disk for consistency)
app.get("/data", (req, res) => {
  try {
    const savedData = loadSavedData();
    res.status(200).json({
      count: savedData.length,
      data: savedData
    });
  } catch (error) {
    console.error('Error retrieving data:', error);
    res.status(500).json({
      error: "Failed to retrieve saved data"
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: Date.now()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found"
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    error: "Internal server error"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});

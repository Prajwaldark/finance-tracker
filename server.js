import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import cors from "cors";
dotenv.config();

const app = express();

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json({ limit: '10mb' })); // Add request size limit

const MAX_STORED_RECORDS = 1000; // Prevent memory leak
const userFinancialData = []; // Array to store analysis results

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

    // Check for API key
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not configured');
      return res.status(500).json({
        error: "Server configuration error: API key not found"
      });
    }

    // Enhanced prompt for Gemini to analyze debt and income
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

    // Validate fetch response
    if (!response.ok) {
      console.error(`Gemini API error: ${response.status} ${response.statusText}`);
      return res.status(502).json({
        error: `External API error: ${response.status}`
      });
    }

    const data = await response.json();

    // Check for API errors
    if (data.error) {
      console.error('Gemini API returned error:', data.error);
      return res.status(502).json({
        error: "Failed to analyze financial data"
      });
    }

    // Try to extract the JSON from Gemini's response
    let analysis = {};
    try {
      const geminiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!geminiText) {
        throw new Error("No response text from Gemini");
      }

      const jsonMatch = geminiText.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in Gemini response");
      }

      analysis = JSON.parse(jsonMatch[0]);

      // Validate parsed analysis has required fields
      if (typeof analysis.debt !== 'number' || typeof analysis.income !== 'number') {
        // Try to convert strings to numbers if needed
        if (analysis.debt !== undefined) analysis.debt = parseFloat(analysis.debt) || 0;
        if (analysis.income !== undefined) analysis.income = parseFloat(analysis.income) || 0;
      }

      if (!analysis.summary) {
        analysis.summary = "Financial analysis completed";
      }
    } catch (e) {
      console.error('Error parsing Gemini response:', e.message);
      return res.status(500).json({
        error: "Could not parse AI response. Please try again with clearer financial information."
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
      summary: analysis.summary
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

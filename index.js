const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: "https://progathon-frontend.vercel.app",
  credentials: true
}));

const twilio = require("twilio");

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

// Improved MongoDB connection with better error handling
mongoose
    .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("MongoDB Connected"))
    .catch((err) => {
        console.error("MongoDB Connection Error:", err);
        process.exit(1); // Exit if cannot connect to database
    });

// Schemas
const FirstAidSchema = new mongoose.Schema({
    title: String,
    description: String,
    steps: [String],
    imageUrl: String,
});
const FirstAid = mongoose.model("FirstAid", FirstAidSchema);

const SosSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: String,
    phone: String,
    email: String,
    bloodGroup: String,
    medicalHistory: String,
    emergencyContacts: [{ name: String, phone: String }] // Array for multiple contacts
});
const SOS = mongoose.model("SOS", SosSchema);

// Google Places API endpoint
app.get("/api/nearby-hospitals", async (req, res) => {
    try {
        const { lat, lng } = req.query;
        console.log("Received request for nearby hospitals with coordinates:", { lat, lng });

        if (!lat || !lng) {
            console.log("Missing coordinates in request");
            return res.status(400).json({ error: "Latitude and longitude are required" });
        }

        // Validate coordinates
        const latNum = parseFloat(lat);
        const lngNum = parseFloat(lng);

        if (isNaN(latNum) || isNaN(lngNum)) {
            console.log("Invalid coordinates:", { lat, lng });
            return res.status(400).json({ error: "Invalid coordinates provided" });
        }

        if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
            console.log("Coordinates out of range:", { lat: latNum, lng: lngNum });
            return res.status(400).json({ error: "Coordinates are out of valid range" });
        }

        if (!process.env.GOOGLE_MAPS_API_KEY) {
            console.error("Google Maps API key is not configured");
            return res.status(500).json({ error: "Server configuration error" });
        }

        console.log("Making request to Google Places API...");
        const response = await axios.get(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json`,
            {
                params: {
                    location: `${latNum},${lngNum}`,
                    radius: 5000,
                    type: "hospital",
                    key: process.env.GOOGLE_MAPS_API_KEY
                }
            }
        );

        console.log("Google Places API response received");

        if (response.data.status !== "OK") {
            console.error("Google Places API error:", response.data.status);
            return res.status(400).json({
                error: "Failed to fetch hospitals",
                details: response.data.status
            });
        }

        console.log("Number of hospitals found:", response.data.results?.length || 0);
        res.json(response.data);
    } catch (error) {
        console.error("Error in nearby-hospitals endpoint:", error);

        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error("Error response:", error.response.data);
            return res.status(error.response.status).json({
                error: "Failed to fetch hospitals",
                details: error.response.data
            });
        } else if (error.request) {
            // The request was made but no response was received
            console.error("No response received:", error.request);
            return res.status(503).json({
                error: "Service unavailable",
                details: "No response from Google Places API"
            });
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error("Error setting up request:", error.message);
            return res.status(500).json({
                error: "Server error",
                details: error.message
            });
        }
    }
});

// First Aid Endpoint
app.get("/api/first-aid", async (req, res) => {
    try {
        const data = await FirstAid.find();
        res.json(data);
    } catch (error) {
        console.error("Error fetching first aid data:", error);
        res.status(500).json({ error: "Server error" });
    }
});

// SOS Endpoints
app.post("/api/sos", async (req, res) => {
    const { userId, name, phone, email, bloodGroup, medicalHistory, emergencyContacts } = req.body;
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    try {
        let sosData = await SOS.findOne({ userId });
        if (sosData) {
            sosData.name = name;
            sosData.phone = phone;
            sosData.email = email;
            sosData.bloodGroup = bloodGroup;
            sosData.medicalHistory = medicalHistory;
            sosData.emergencyContacts = emergencyContacts;
            await sosData.save();
            return res.json({ message: "Emergency info updated!" });
        } else {
            const newSos = new SOS({ userId, name, phone, email, bloodGroup, medicalHistory, emergencyContacts });
            await newSos.save();
            return res.json({ message: "Emergency info saved!" });
        }
    } catch (error) {
        console.error("Error saving SOS data:", error);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/sos/:userId", async (req, res) => {
    try {
        const sosData = await SOS.findOne({ userId: req.params.userId });
        if (!sosData) return res.status(404).json({ message: "No emergency contacts found" });
        res.json(sosData);
    } catch (err) {
        console.error("Error fetching SOS data:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/sos/alert", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "User ID is required" });

        const sosData = await SOS.findOne({ userId });
        if (!sosData) return res.status(404).json({ message: "No emergency contacts found" });

        console.log(`🚨 ALERT! ${sosData.name} triggered SOS! Sending SMS...`);

        const messageBody = `🚨 EMERGENCY ALERT! ${sosData.name} needs help! 
        Blood Group: ${sosData.bloodGroup}, Contact: ${sosData.phone}.`;

        // Send SMS to each emergency contact
        const smsPromises = sosData.emergencyContacts.map((contact) => {
            return twilioClient.messages
                .create({
                    body: messageBody,
                    from: twilioPhone,
                    to: contact.phone, 
                })
                .then((message) => console.log(✔ SMS sent to ${contact.name} (${contact.phone}): ${message.sid}))
                .catch((error) => console.error(❌ Error sending SMS to ${contact.name}:, error.message));
        });

        await Promise.all(smsPromises); // Wait for all SMS to be sent

        res.json({ message: "🚨 SOS Alert Sent Successfully!" });
    } catch (error) {
        console.error("❌ Error processing SOS alert:", error);
        res.status(500).json({ error: "Server error while sending SMS." });
    }
});
// Medical Advisor Chat
const SYSTEM_PROMPT = `
You are MedAI, a professional medical advisor AI.
Keep responses short and concise, about 50 words.
Provide accurate medical advice for emergencies or general queries.
Prioritize safety, recommend professional help when needed, avoid diagnoses.
Offer step-by-step first aid, explain symptoms, suggest emergency care.
Redirect non-medical queries to professionals.
`;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

app.post("/api/chat", async (req, res) => {
    const { message, chatHistory } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API key is not configured" });

    try {
        // Format chat history for Gemini with clear conversation structure
        let formattedHistory = "";
        if (chatHistory && Array.isArray(chatHistory) && chatHistory.length > 0) {
            // Create a more structured conversation format
            formattedHistory = "CONVERSATION HISTORY:\n";
            
            // Log the chat history for debugging
            console.log("Received chat history:", JSON.stringify(chatHistory, null, 2));
            
            chatHistory.forEach((msg, index) => {
                if (msg.sender === "user") {
                    formattedHistory += `Human: ${msg.text}\n`;
                } else if (msg.sender === "bot") {
                    formattedHistory += `Assistant: ${msg.text}\n`;
                }
            });
            
            formattedHistory += "\nCURRENT CONVERSATION:\n";
        }

        // Prepare the prompt with system prompt, chat history, and current message
        const fullPrompt = `${SYSTEM_PROMPT}\n\n${formattedHistory}Human: ${message}\nAssistant:`;

        console.log("Sending to Gemini:", fullPrompt);

        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: [{
                    role: "user",
                    parts: [{ text: fullPrompt }],
                }],
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 1024,
                },
            },
            { headers: { "Content-Type": "application/json" } }
        );

        const botResponseText = response.data.candidates[0].content.parts[0].text;
        res.json({ reply: botResponseText });
    } catch (error) {
        console.error("Error fetching response from Gemini API:", error.message);
        res.status(500).json({ error: "Sorry, I couldn't process your request. Please try again." });
    }
});

// Server Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

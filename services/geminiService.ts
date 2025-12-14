import { GoogleGenAI, Type, Schema } from "@google/genai";
import { NutritionalData, UserPlan } from "../types";

// Initialize Gemini Client
// CRITICAL: We use the API key from the environment variable as per instructions.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    foodName: {
      type: Type.STRING,
      description: "A short, descriptive name of the identified food or meal.",
    },
    calories: {
      type: Type.NUMBER,
      description: "Estimated total calories.",
    },
    protein: {
      type: Type.NUMBER,
      description: "Estimated protein in grams.",
    },
    carbs: {
      type: Type.NUMBER,
      description: "Estimated carbohydrates in grams.",
    },
    fat: {
      type: Type.NUMBER,
      description: "Estimated fat in grams.",
    },
    notes: {
      type: Type.STRING,
      description: "Brief nutritional advice or health notes about this meal.",
    },
  },
  required: ["foodName", "calories", "protein", "carbs", "fat", "notes"],
};

export const analyzeMealWithGemini = async (
  textInput: string,
  imageBase64?: string
): Promise<NutritionalData> => {
  try {
    const parts: any[] = [];

    // Add image if present
    if (imageBase64) {
      // Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
      const base64Data = imageBase64.split(',')[1] || imageBase64;
      
      parts.push({
        inlineData: {
          mimeType: "image/jpeg", // Assuming JPEG for simplicity/conversion
          data: base64Data,
        },
      });
    }

    // Add text prompt
    const promptText = textInput 
      ? `Analyze this meal described as: "${textInput}". Provide nutritional estimates.` 
      : "Analyze the food in this image. Provide nutritional estimates.";
    
    parts.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: parts,
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        systemInstruction: "You are an expert nutritionist AI. Your goal is to provide accurate calorie and macro estimations based on food descriptions or images. Be conservative but realistic in your estimates.",
      },
    });

    if (response.text) {
      const data = JSON.parse(response.text) as NutritionalData;
      return data;
    } else {
      throw new Error("No data returned from Gemini.");
    }

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};

export interface WebhookResponse {
  success: boolean;
  data?: any;
  message?: string;
}

/**
 * Sends data to an n8n webhook and returns the response.
 * Implements a CORS fallback strategy.
 */
export const syncToN8nWebhook = async (
  data: NutritionalData, 
  userEmail: string, 
  userId: string,
  userPlan: string
): Promise<WebhookResponse> => {
  // ---------------------------------------------------------------------------
  // CONFIGURATION: Replace this URL with your actual n8n Webhook URL for DATA SYNC
  // ---------------------------------------------------------------------------
  const N8N_DATA_WEBHOOK_URL = 'https://zainwater99.app.n8n.cloud/webhook-test/analyse/data'; 
  
  const payload = {
    userId,
    userEmail,
    userPlan,
    timestamp: new Date().toISOString(),
    entryData: data,
    source: 'CaloriesAI_Web_Client'
  };

  console.log(`[n8n] Syncing data for user ${userId} (${userPlan})...`, payload);

  return attemptFetch(N8N_DATA_WEBHOOK_URL, payload);
};

export const createStripeCheckout = async (userId: string, userEmail: string): Promise<string> => {
  const N8N_STRIPE_WEBHOOK_URL = 'https://zainwater99.app.n8n.cloud/webhook/pay/stipe';

  // Determine where to return the user after payment
  const callbackUrl = window.location.origin + window.location.pathname;

  const payload = {
    userId,
    email: userEmail,
    callbackUrl
  };

  console.log("[Stripe] Requesting checkout...", payload);

  const res = await fetch(N8N_STRIPE_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const data = await res.json();
  console.log("[Stripe] Received response:", data);
  const checkoutUrl = data.url || data.data?.url;
  if (!checkoutUrl) {
    throw new Error("No URL returned from webhook");
  }

  return checkoutUrl;
};

export const fetchUserPlanStatus = async (userId: string, userEmail: string): Promise<UserPlan> => {
  const N8N_STATUS_WEBHOOK_URL = 'https://zainwater99.app.n8n.cloud/webhook/user/status';
  const payload = {
    userId,
    email: userEmail,
    action: 'get_user_status'
  };

  const response = await attemptFetch(N8N_STATUS_WEBHOOK_URL, payload);
  if (response.success && response.data) {
    const plan = response.data.plan || response.data.userPlan || (typeof response.data === 'string' ? response.data : null);
    const normalizedPlan = typeof plan === 'string' ? plan.trim().toUpperCase() : '';
    if (normalizedPlan === 'PRO' || normalizedPlan === UserPlan.PRO) {
      return UserPlan.PRO;
    }
  }
  
  return UserPlan.FREE;
};


async function attemptFetch(url: string, payload: any): Promise<WebhookResponse> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const contentType = response.headers.get("content-type");
    let responseBody: any;
    
    if (contentType && contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    if (response.ok) {
      return { 
        success: true, 
        data: responseBody,
        message: 'Success'
      };
    } else {
      return { 
        success: false, 
        data: responseBody,
        message: `Request failed: ${response.statusText}`
      };
    }

  } catch (error) {
    console.warn(`[n8n] Standard fetch failed for ${url}, trying fallback...`, error);

    try {
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors', 
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
      });

      return { 
        success: true, 
        message: "Request sent (Opaque response)",
        data: { info: "no-cors mode" }
      };

    } catch (fallbackError) {
      return { 
        success: false, 
        message: error instanceof Error ? error.message : "Network error" 
      };
    }
  }
}
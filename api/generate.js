// Vercel serverless function — proxies supported AI provider requests.
// Reads API keys from Vercel environment variables (never exposed to the browser).
module.exports = async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt, provider = 'gemini' } = req.body || {};
    if (!prompt) {
        return res.status(400).json({ error: 'Missing prompt' });
    }

    const providers = {
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
            buildBody: () => ({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 16384,
                    candidateCount: 1,
                    responseMimeType: 'application/json',
                },
            }),
            buildUrl: apiKey => `${providers.gemini.apiUrl}?key=${apiKey}`,
        },
        groq: {
            apiKey: process.env.GROQ_API_KEY,
            apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
            buildBody: () => ({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 4096,
                response_format: { type: 'json_object' },
            }),
            buildUrl: () => providers.groq.apiUrl,
        },
    };
    const selectedProvider = providers[provider];
    if (!selectedProvider) {
        return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const apiKey = selectedProvider.apiKey;
    if (!apiKey) {
        const envVar = provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
        return res.status(500).json({ error: `${envVar} not configured in Vercel environment variables` });
    }

    try {
        const isGemini = provider === 'gemini';
        const response = await fetch(selectedProvider.buildUrl(apiKey), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(isGemini ? {} : { Authorization: `Bearer ${apiKey}` }),
            },
            body: JSON.stringify(selectedProvider.buildBody()),
        });

        const data = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({ error: data });
        }

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
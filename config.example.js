// API configuration template — copy this file to config.js and add your API keys.
// config.js is excluded from git via .gitignore.
// NOTE: config.js is OPTIONAL. script.js has a built-in default config, so the
// app works on Vercel even without config.js. If you load config.js locally
// (via <script src="config.js"></script>), it overrides the default via window.apiConfig.
// For a free/no-credit setup, use Gemini only.
window.apiConfig = {
    kanjiCount: 10,
    maxRetries: 2, // Retries per provider before moving to the next

    // On Vercel: useProxy true → api/generate.js reads GEMINI_API_KEY and GROQ_API_KEY.
    // Local dev: set useProxy false and add your provider API keys below.
    useProxy: true,
    proxyUrl: '/api/generate',

    providers: [
        {
            name: 'gemini',
            apiKey: '', // ← Only needed when useProxy is false (local direct API)
            model: 'gemini-3.5-flash',
            apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
        },
        {
            name: 'groq',
            apiKey: '', // ← Set your Groq API key when useProxy is false
            model: 'llama-3.3-70b-versatile',
            apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        },
    ],
};

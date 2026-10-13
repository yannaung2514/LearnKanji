// Kanji are loaded from kanjidata.js, then enriched with AI-generated data (compound, Myanmar, examples with hiragana).
// Falls back to built-in data if the data file or API is unavailable.
// The apiConfig below is defined inline so the app works as a pure static site on Vercel
// (config.js is git-ignored and would 404 on deployment). If config.js IS present locally,
// it overrides this default via window.apiConfig.
let kanjiData = [];

// Default AI configuration — uses the Vercel serverless function (api/generate.js)
// which reads provider API keys from environment variables (never exposed to the browser).
// For local development, create a config.js with your key and useProxy: false (see config.example.js).
const apiConfig = window.apiConfig || {
    kanjiCount: 10,
    maxRetries: 2, // Retries before giving up
    useProxy: true, // Use Vercel serverless function (api/generate.js)
    proxyUrl: '/api/generate',

    providers: [
        {
            name: 'gemini',
            apiKey: '', // Not needed when useProxy is true (key is on the server)
            model: 'gemini-3.5-flash',
            apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
        },
        {
            name: 'groq',
            apiKey: '', // Not needed when useProxy is true (key is on the server)
            model: 'openai/gpt-oss-120b',
            apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        },
    ],
};

const serviceUnavailableRetryDelayMs = 60 * 1000;

// ===== Supabase Integration =====
// Fetch kanji data from Supabase via the Vercel serverless function (api/supabase.js)
async function fetchKanjiFromSupabase(limit = 100) {
    try {
        const response = await fetch(`/api/supabase?limit=${limit}`, { method: 'GET' });
        if (!response.ok) return null;
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        // Map Supabase rows to the app's kanjiData format
        return data.map(row => ({
            char: row.char,
            compound: (row.compounds && row.compounds[0]?.word) || '',
            compounds: row.compounds || [],
            on: row.on_yomi || '',
            kun: row.kun_yomi || '',
            myanmar: row.myanmar || row.english || '',
            english: row.english || '',
            ex: row.examples || [],
            notes: row.notes || null,
            learned: row.learned === true,
        }));
    } catch (e) {
        console.warn('Supabase read failed (will use local data):', e.message);
        return null;
    }
}

// Save AI-enriched kanji data back to Supabase (overrides original data)
// Uses PATCH per kanji to update existing rows (avoids 409 conflict on insert)
async function saveKanjiToSupabase(kanjiItems) {
    let saved = 0;
    for (const k of kanjiItems) {
        try {
            const response = await fetch(`/api/supabase?char=${encodeURIComponent(k.char)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    on_yomi: k.on || '',
                    kun_yomi: k.kun || '',
                    english: k.english || '',
                    myanmar: k.myanmar || '',
                    compounds: k.compounds || [],
                    examples: k.ex || [],
                }),
            });
            if (response.ok) {
                saved++;
            } else {
                console.warn(`Supabase save failed for ${k.char}: ${response.status}`);
            }
        } catch (e) {
            console.warn(`Supabase save failed for ${k.char}:`, e.message);
        }
    }
    console.log(`Saved ${saved}/${kanjiItems.length} kanji to Supabase`);
    return saved > 0;
}

// Update a single kanji in Supabase (used for edits and notes)
async function updateKanjiInSupabase(char, updates) {
    try {
        const response = await fetch(`/api/supabase?char=${encodeURIComponent(char)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!response.ok) {
            throw new Error(`Supabase update failed: ${response.status}`);
        }
        return true;
    } catch (e) {
        console.warn('Supabase update failed:', e.message);
        return false;
    }
}

// Call AI to enrich a list of kanji (returns enriched data or null)
async function callAIForKanji(kanjiList) {
    const kanjiChars = kanjiList.map(k => k.char).join(', ');
    const useProxy = apiConfig.useProxy === true;
    const proxyUrl = apiConfig.proxyUrl || '/api/generate';
    const providers = (apiConfig.providers || []).filter(p => useProxy ? p.name : p.apiKey);
    if (providers.length === 0) return null;

    const prompt = `For each of the following kanji characters: ${kanjiChars}, provide a JSON object with a "kanji" property containing an array of objects. Each object must include: "char" (the kanji character), "compounds" (an array of 3-5 common compound word objects, each with "word" (the compound word), "hira" (full hiragana reading of the compound word), and "meaning" (Myanmar/Burmese translation of the compound word written in Burmese script ONLY — never Korean, never Chinese, never English)), "on" (on'yomi reading in katakana), "kun" (kun'yomi reading), "myanmar" (Myanmar/Burmese meaning written in Burmese script ONLY — never Korean, never Chinese, never English), and "ex" (array of 2 example objects). Each object in "ex" must have: "jp" (Japanese example sentence), "hira" (full hiragana reading of the sentence), and "meaning" (Myanmar/Burmese translation written in Burmese script ONLY — never Korean). Output only JSON without explanation.`;

    let kanjiResult = null;

    for (const provider of providers) {
        try {
            let jsonText = null;
            for (let attempt = 0; attempt <= apiConfig.maxRetries; attempt++) {
                let response;
                if (useProxy) {
                    response = await fetch(proxyUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ provider: provider.name, prompt }),
                    });
                } else if (provider.name === 'gemini') {
                    response = await fetch(`${provider.apiUrl}?key=${provider.apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: {
                                temperature: 0.2,
                                maxOutputTokens: 16384,
                                candidateCount: 1,
                                responseMimeType: 'application/json',
                            },
                        }),
                    });
                } else if (provider.name === 'openrouter') {
                    response = await fetch(provider.apiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${provider.apiKey}`,
                            'HTTP-Referer': window.location.origin || 'http://localhost',
                            'X-Title': 'LearnKanji',
                        },
                        body: JSON.stringify({
                            model: provider.model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 4096,
                            response_format: { type: 'json_object' },
                        }),
                    });
                } else {
                    response = await fetch(provider.apiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${provider.apiKey}`,
                        },
                        body: JSON.stringify({
                            model: provider.model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 4096,
                            response_format: { type: 'json_object' },
                        }),
                    });
                }

                const responseText = await response.text();
                if (response.status === 503 && attempt < apiConfig.maxRetries) {
                    console.warn(`${provider.name} returned 503 Service Unavailable. Retrying in 60s...`);
                    await sleep(serviceUnavailableRetryDelayMs);
                    continue;
                }
                if (response.status === 429 && attempt < apiConfig.maxRetries) {
                    const waitMs = Math.pow(2, attempt) * 1000;
                    await sleep(waitMs);
                    continue;
                }
                if (!response.ok) {
                    const error = new Error(`${provider.name} API failed (${response.status}): ${responseText.substring(0, 200)}`);
                    error.status = response.status;
                    throw error;
                }
                const data = JSON.parse(responseText);
                if (provider.name === 'gemini') {
                    jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                } else {
                    jsonText = data?.choices?.[0]?.message?.content;
                }
                break;
            }

            if (!jsonText) throw new Error(`${provider.name} returned no usable response text.`);
            jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            let parsed;
            try {
                parsed = JSON.parse(jsonText);
            } catch (e) {
                parsed = recoverTruncatedJSON(jsonText);
                if (!parsed) throw e;
            }
            const resultArr = Array.isArray(parsed) ? parsed : (parsed.kanji || parsed.data || []);
            if (!Array.isArray(resultArr) || resultArr.length === 0) {
                throw new Error(`${provider.name} did not return a kanji array.`);
            }
            kanjiResult = resultArr;
            break;
        } catch (error) {
            console.warn(`${provider.name} failed:`, error.message);
        }
    }

    if (!kanjiResult || kanjiResult.length === 0) return null;

    kanjiResult = cleanAIResponse(kanjiResult);
    const csvMap = new Map(kanjiList.map(k => [k.char, k]));
    return kanjiResult.map(item => {
        const csv = csvMap.get(item.char);
        let compounds = item.compounds || [];
        if ((!compounds || compounds.length === 0) && item.compound) {
            compounds = [{ word: item.compound, hira: '' }];
        }
        if ((!compounds || compounds.length === 0) && csv?.compounds && csv.compounds.length > 0) {
            compounds = csv.compounds;
        }
        return {
            char: item.char,
            compounds: compounds,
            compound: item.compound || (compounds[0]?.word || ''),
            on: item.on || csv?.on || '',
            kun: item.kun || csv?.kun || '',
            myanmar: item.myanmar || csv?.myanmar || csv?.english || '',
            ex: item.ex || [],
        };
    });
}

// Preload the next batch of kanji with AI data in the background
async function preloadNextBatch(currentChars) {
    try {
        let allKanji = await fetchKanjiFromSupabase(2000);
        if (!allKanji || allKanji.length === 0) {
            allKanji = await loadLocalKanjiData();
        }
        if (!allKanji || allKanji.length === 0) return;

        const currentSet = new Set(currentChars);
        const learnedSet = new Set(savedLearnedKanji.map(k => k.char));
        const nextBatch = allKanji
            .filter(k => !currentSet.has(k.char) && !learnedSet.has(k.char))
            .sort(() => 0.5 - Math.random())
            .slice(0, apiConfig.kanjiCount);

        if (nextBatch.length === 0) return;

        console.log(`Preloading next ${nextBatch.length} kanji with AI...`);
        const enriched = await callAIForKanji(nextBatch);
        if (enriched && enriched.length > 0) {
            await saveKanjiToSupabase(enriched);
            // Remember these chars so the next restart shows this AI-ready batch first.
            savePreloadedChars(enriched.map(k => k.char));
            console.log(`Preloaded ${enriched.length} kanji to Supabase`);
        }
    } catch (e) {
        console.warn('Preload failed:', e.message);
    }
}

// Fallback kanji data — used when CSV or API is unavailable.
const fallbackKanji = [
    {
        char: '確', compound: '確認', on: 'カク', kun: 'たしか.める', myanmar: 'သေချာသည်',
        ex: [
            { jp: '予定を確認してください。', hira: 'よていをかくにんしてください。', meaning: 'အစီအစဉ်ကို သေချာပါ။' },
            { jp: '彼の成功は確実だ。', hira: 'かれのせいこうはかくじつだ。', meaning: 'သူ့အောင်မြင်မှုသည် သေချာပြီ။' },
        ],
    },
    {
        char: '規', compound: '規則', on: 'キ', kun: 'のり', myanmar: 'စည်းကမ်း',
        ex: [
            { jp: '学校の規則を守る。', hira: 'がっこうのきそくをまもる。', meaning: 'ကျောင်းစည်းကမ်းကို လိုက်နာသည်။' },
            { jp: 'この規模は大きすぎる。', hira: 'このきぼはおおきすぎる。', meaning: 'ဤအတိုင်းအဆင်းသည် အလွန်ကြီးသည်။' },
        ],
    },
    {
        char: '限', compound: '制限', on: 'ゲン', kun: 'かぎ.る', myanmar: 'ကန့်သတ်သည်',
        ex: [
            { jp: '速度制限に気をつけて。', hira: 'そくどせいげんにきをつけて。', meaning: 'အရှိန်ကန့်သတ်ချက်ကို သတိပြုပါ။' },
            { jp: '時間が限られている。', hira: 'じかんがかぎられている。', meaning: 'အချိန် ကန့်သတ်ထားသည်။' },
        ],
    },
    {
        char: '構', compound: '構造', on: 'コウ', kun: 'かま.える', myanmar: 'တည်ဆောက်ပုံ',
        ex: [
            { jp: '文の構造を分析する。', hira: 'ぶんのこうぞうをぶんせきする。', meaning: 'ဝါကျတည်ဆောက်ပုံကို ဆန်းစစ်သည်။' },
            { jp: '気にしないで構わない。', hira: 'きにしないでかまわない。', meaning: 'စိတ်မပူဘဲ ဖြစ်သည်။' },
        ],
    },
    {
        char: '資', compound: '資料', on: 'シ', kun: '-', myanmar: 'အရင်းအမြစ်',
        ex: [
            { jp: '資料を集めている。', hira: 'しりょうをあつめている。', meaning: 'အချက်အလက်များကို စုဆောင်းနေသည်။' },
            { jp: '人材を探している。', hira: 'じんざいをさがしている。', meaning: 'လူ့စွမ်းအားကို ရှာဖွေနေသည်။' },
        ],
    },
    {
        char: '集', compound: '集合', on: 'シュウ', kun: 'あつ.める', myanmar: 'စုဆောင်းသည်',
        ex: [
            { jp: '駅前に集合してください。', hira: 'えきまえにしゅうごうしてください。', meaning: 'ဘူတာရှေ့တွင် စုဝေးပါ။' },
            { jp: '切手を集めている。', hira: 'きってをあつめている。', meaning: 'တံဆိပ်များကို စုဆောင်းနေသည်။' },
        ],
    },
    {
        char: '週', compound: '今週', on: 'シュウ', kun: '-', myanmar: 'ရက်သတ္တပတ်',
        ex: [
            { jp: '今週は忙しい。', hira: 'こんしゅうはいそがしい。', meaning: 'ဤရက်သတ္တပတ်တွင် အလုပ်များသည်။' },
            { jp: '来週の予定を教えて。', hira: 'らいしゅうのよていをおしえて。', meaning: 'လာမည့်ရက်သတ္တပတ် အစီအစဉ်ကို ပြောပြပါ။' },
        ],
    },
    {
        char: '伸', compound: '伸長', on: 'シン', kun: 'の.びる', myanmar: 'ဆန့်တန်းသည်',
        ex: [
            { jp: '背が伸びた。', hira: 'せがのびた。', meaning: 'အရပ်ရှည်လာသည်။' },
            { jp: '才能を伸ばす。', hira: 'さいのうをのばす。', meaning: 'အရည်အချင်းကို တိုးတက်စေသည်။' },
        ],
    },
    {
        char: '退', compound: '退屈', on: 'タイ', kun: 'しりぞ.く', myanmar: 'ပျင်းရိသည်',
        ex: [
            { jp: 'この映画は退屈だ。', hira: 'このえいがはたいくつだ。', meaning: 'ဤရုပ်ရှင်သည် ပျင်းရိစရာဖြစ်သည်။' },
            { jp: '仕事を退職した。', hira: 'しごとをたいしょくした。', meaning: 'အလုပ်မှ အနားယူသည်။' },
        ],
    },
    {
        char: '展', compound: '展示', on: 'テン', kun: '-', myanmar: 'ပြသာဆန်း',
        ex: [
            { jp: '美術館で展示会がある。', hira: 'びじゅつかんでてんじかいがある。', meaning: 'အနုပညာပြတိုက်တွင် ပြပွဲရှိသည်။' },
            { jp: '発展的な計画を立てる。', hira: 'はってんてきなけいかくをたてる。', meaning: 'တိုးတက်မှုဆိုင်ရာ အစီအစဉ် ချမှတ်သည်။' },
        ],
    },
];

let viewedKanji = new Set();
let currentQuestionIndex = 0;
let currentModalIndex = 0; // Index of the kanji currently shown in the modal
let currentModalItem = null; // Item currently shown in the modal (works for grid + learned/database kanji)
let score = 0;
let testQuestions = [];
let learnedKanji = []; // Kanji answered correctly in the test (current session)
let savedLearnedKanji = []; // Kanji saved in localStorage (persistent)

// localStorage key for saved learned kanji
const LEARNED_KANJI_STORAGE_KEY = 'learnkanji_learned';

// localStorage key for the batch of kanji that was pre-loaded with AI data
// in the background, so a restart can show it immediately without waiting.
const PRELOADED_BATCH_STORAGE_KEY = 'learnkanji_preloaded_batch';

// Load the chars of the previously preloaded (AI-ready) batch from localStorage
function loadPreloadedChars() {
    try {
        const stored = localStorage.getItem(PRELOADED_BATCH_STORAGE_KEY);
        return Array.isArray(JSON.parse(stored)) ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

// Remember which chars were just preloaded with AI data so a restart can use them
function savePreloadedChars(chars) {
    try {
        localStorage.setItem(PRELOADED_BATCH_STORAGE_KEY, JSON.stringify(Array.isArray(chars) ? chars : []));
    } catch (e) {
        console.warn('Failed to save preloaded batch:', e.message);
    }
}

// Load saved learned kanji from localStorage
function loadSavedLearnedKanji() {
    try {
        const stored = localStorage.getItem(LEARNED_KANJI_STORAGE_KEY);
        if (stored) {
            savedLearnedKanji = JSON.parse(stored);
            console.log('Loaded', savedLearnedKanji.length, 'saved learned kanji from localStorage');
        }
    } catch (e) {
        console.warn('Failed to load learned kanji from localStorage:', e.message);
        savedLearnedKanji = [];
    }
}

// Save learned kanji to localStorage
function saveLearnedKanji() {
    try {
        // Merge current session learned kanji with saved ones (no duplicates)
        for (const item of learnedKanji) {
            if (!savedLearnedKanji.some(k => k.char === item.char)) {
                savedLearnedKanji.push(item);
            }
        }
        localStorage.setItem(LEARNED_KANJI_STORAGE_KEY, JSON.stringify(savedLearnedKanji));
        console.log('Saved', savedLearnedKanji.length, 'learned kanji to localStorage');
    } catch (e) {
        console.warn('Failed to save learned kanji to localStorage:', e.message);
    }
}

// Reset all saved learned kanji
function resetLearnedKanji() {
    savedLearnedKanji = [];
    learnedKanji = [];
    try {
        localStorage.removeItem(LEARNED_KANJI_STORAGE_KEY);
    } catch (e) {
        console.warn('Failed to reset learned kanji:', e.message);
    }
    // Reset learned status in Supabase for all kanji in current data
    for (const item of kanjiData) {
        updateKanjiInSupabase(item.char, { learned: false });
    }
    renderLearnedKanji();
    console.log('Learned kanji reset');
}

const gridEl = document.getElementById('kanjiGrid');
const progressBar = document.getElementById('progressBar');
const startTestBtn = document.getElementById('startTestBtn');
const loadingMessage = document.getElementById('loadingMessage');

// Sleep helper for retry backoff
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadLocalKanjiData() {
    if (typeof kanjiMasterData !== 'undefined' && Array.isArray(kanjiMasterData) && kanjiMasterData.length) {
        return kanjiMasterData;
    }

    try {
        const response = await fetch('kanjidata.js');
        if (!response.ok) throw new Error(`kanjidata.js fetch failed (${response.status})`);
        const text = await response.text();
        const match = text.match(/const kanjiMasterData = (\[[\s\S]*?);/);
        if (!match) {
            console.warn('kanjidata.js did not contain kanjiMasterData');
            return [];
        }
        const data = JSON.parse(match[1]);
        if (Array.isArray(data)) return data;
        console.warn('kanjidata.js did not contain an array');
        return [];
    } catch (error) {
        console.warn('Failed to load kanjidata.js:', error.message);
        return [];
    }
}

// Attempt to recover a truncated JSON response by finding the last complete object
function recoverTruncatedJSON(text) {
    const idx = text.lastIndexOf('},');
    if (idx === -1) return null;
    let fixed = text.substring(0, idx + 1);
    const openSq = (fixed.match(/\[/g) || []).length;
    const closeSq = (fixed.match(/\]/g) || []).length;
    const openCu = (fixed.match(/\{/g) || []).length;
    const closeCu = (fixed.match(/\}/g) || []).length;
    for (let i = 0; i < openSq - closeSq; i++) fixed += ']';
    for (let i = 0; i < openCu - closeCu; i++) fixed += '}';
    try {
        return JSON.parse(fixed);
    } catch (e) {
        console.error('JSON recovery failed:', e.message);
        return null;
    }
}

function buildKanjiDataFromCSV(selectedKanji) {
    return selectedKanji.map(k => {
        // Use compound words from kanjidata.js (added via translate/add_compounds.mjs)
        const compounds = Array.isArray(k.compounds) && k.compounds.length > 0
            ? k.compounds
            : [];
        return {
            char: k.char,
            compound: compounds[0]?.word || '',
            compounds: compounds,
            on: k.on || '',
            kun: k.kun || '',
            myanmar: k.myanmar || k.english || '',
            ex: Array.isArray(k.ex) ? k.ex : [],
        };
    });
}

async function fetchKanjiData() {
    loadingMessage.style.display = 'block';
    loadingMessage.textContent = 'Loading kanji from Supabase…';
    loadingMessage.style.color = '#333';

    // Step 1: Try loading from Supabase first (has AI-overridden data).
    let csvKanji = await fetchKanjiFromSupabase(2000);

    if (!csvKanji || csvKanji.length === 0) {
        // Step 1b: Fall back to local kanjidata.js if Supabase is unavailable/empty.
        loadingMessage.textContent = 'Loading kanji from local data…';
        csvKanji = await loadLocalKanjiData();
    }

    if (!csvKanji || csvKanji.length === 0) {
        console.warn('Local kanji data not loaded — using fallback data.');
        kanjiData = [...fallbackKanji];
        loadingMessage.textContent = 'Could not load local kanji data. Using built-in sample kanji.';
        loadingMessage.style.color = '#e67e22';
        renderGrid();
        setTimeout(() => { loadingMessage.style.display = 'none'; }, 6000);
        return;
    }

    // Step 2: Select kanji for this session, excluding already-learned kanji.
    // Prefer the batch that was pre-loaded with AI data in the background so a
    // restart shows AI-ready kanji immediately (no foreground wait).
    const availableKanji = csvKanji.filter(k => !isKanjiLearned(k.char));
    const preloadedSet = new Set(loadPreloadedChars());
    const preloadedAvailable = availableKanji.filter(k => preloadedSet.has(k.char));

    let selectedKanji = [...preloadedAvailable]
        .sort(() => 0.5 - Math.random())
        .slice(0, apiConfig.kanjiCount);

    // Fill any remaining slots with random unlearned kanji.
    if (selectedKanji.length < apiConfig.kanjiCount) {
        const used = new Set(selectedKanji.map(k => k.char));
        const rest = [...availableKanji]
            .filter(k => !used.has(k.char))
            .sort(() => 0.5 - Math.random())
            .slice(0, apiConfig.kanjiCount - selectedKanji.length);
        selectedKanji.push(...rest);
    }

    // If not enough unlearned kanji, fill with learned ones.
    if (selectedKanji.length < apiConfig.kanjiCount) {
        const learnedChars = new Set(savedLearnedKanji.map(k => k.char));
        const learnedRemaining = csvKanji.filter(k => learnedChars.has(k.char));
        const fillCount = apiConfig.kanjiCount - selectedKanji.length;
        const fillKanji = [...learnedRemaining]
            .sort(() => 0.5 - Math.random())
            .slice(0, fillCount);
        selectedKanji.push(...fillKanji);
    }

    // Are all selected kanji already AI-ready (preloaded) in Supabase?
    // If so, we can skip the foreground AI call and show them instantly.
    const allAIReady = selectedKanji.length > 0 && selectedKanji.every(sel => {
        const src = csvKanji.find(c => c.char === sel.char);
        return src &&
            Array.isArray(src.ex) && src.ex.length > 0 &&
            Array.isArray(src.compounds) && src.compounds.some(c => c && c.meaning);
    });

    // Render immediately using local data while API enrichment runs in the background.
    kanjiData = buildKanjiDataFromCSV(selectedKanji);
    // Apply any user edits saved in localStorage
    applyUserEdits();
    renderGrid();
    renderLearnedKanji();

    // If the whole selected batch is already AI-loaded (from a background preload),
    // show it instantly and preload the NEXT batch in the background — no wait.
    if (allAIReady) {
        loadingMessage.style.display = 'none';
        saveKanjiToSupabase(kanjiData);
        preloadNextBatch(kanjiData.map(k => k.char));
        return;
    }

    const kanjiChars = selectedKanji.map(k => k.char).join(', ');
    const useProxy = apiConfig.useProxy === true;
    const proxyUrl = apiConfig.proxyUrl || '/api/generate';
    const providers = (apiConfig.providers || []).filter(p => useProxy ? p.name : p.apiKey);
    if (providers.length === 0) {
        loadingMessage.textContent = 'No API key configured — showing kanji from data without AI examples.';
        loadingMessage.style.color = '#e67e22';
        setTimeout(() => { loadingMessage.style.display = 'none'; }, 5000);
        return;
    }

    // Step 4: Try each provider in configured order.
    const prompt = `For each of the following kanji characters: ${kanjiChars}, provide a JSON object with a "kanji" property containing an array of objects. Each object must include: "char" (the kanji character), "compounds" (an array of 3-5 common compound word objects, each with "word" (the compound word), "hira" (full hiragana reading of the compound word), and "meaning" (Myanmar/Burmese translation of the compound word written in Burmese script ONLY — never Korean, never Chinese, never English)), "on" (on'yomi reading in katakana), "kun" (kun'yomi reading), "myanmar" (Myanmar/Burmese meaning written in Burmese script ONLY — never Korean, never Chinese, never English), and "ex" (array of 2 example objects). Each object in "ex" must have: "jp" (Japanese example sentence), "hira" (full hiragana reading of the sentence), and "meaning" (Myanmar/Burmese translation written in Burmese script ONLY — never Korean). Output only JSON without explanation.`;

    let kanjiResult = null;
    let lastError = null;
    let usedProviderName = '';

    for (const provider of providers) {
        loadingMessage.textContent = `Generating data for ${selectedKanji.length} kanji via ${provider.name} (${provider.model})…`;

        try {
            let jsonText = null;

            for (let attempt = 0; attempt <= apiConfig.maxRetries; attempt++) {
                let response;

                if (useProxy) {
                    response = await fetch(proxyUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            provider: provider.name,
                            prompt,
                        }),
                    });
                } else if (provider.name === 'gemini') {
                    // Gemini API format
                    response = await fetch(`${provider.apiUrl}?key=${provider.apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: {
                                temperature: 0.2,
                                maxOutputTokens: 16384,
                                candidateCount: 1,
                                responseMimeType: 'application/json',
                            },
                        }),
                    });
                } else if (provider.name === 'openrouter') {
                    // OpenRouter API format (chat completions with extra headers)
                    response = await fetch(provider.apiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${provider.apiKey}`,
                            'HTTP-Referer': window.location.origin || 'http://localhost',
                            'X-Title': 'LearnKanji',
                        },
                        body: JSON.stringify({
                            model: provider.model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 4096,
                            response_format: { type: 'json_object' },
                        }),
                    });
                } else {
                    // OpenAI / DeepSeek API format (both use chat completions)
                    response = await fetch(provider.apiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${provider.apiKey}`,
                        },
                        body: JSON.stringify({
                            model: provider.model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 4096,
                            response_format: { type: 'json_object' },
                        }),
                    });
                }

                const responseText = await response.text();

                if (response.status === 503 && attempt < apiConfig.maxRetries) {
                    loadingMessage.textContent = `${provider.name} returned 503 Service Unavailable. Retrying in 60s…`;
                    await sleep(serviceUnavailableRetryDelayMs);
                    continue;
                }

                // Retry on rate limit (429)
                if (response.status === 429 && attempt < apiConfig.maxRetries) {
                    const waitMs = Math.pow(2, attempt) * 1000;
                    loadingMessage.textContent = `${provider.name} rate limited. Retrying in ${waitMs / 1000}s…`;
                    await sleep(waitMs);
                    continue;
                }

                if (!response.ok) {
                    const error = new Error(`${provider.name} API failed (${response.status}): ${responseText.substring(0, 200)}`);
                    error.status = response.status;
                    throw error;
                }

                const data = JSON.parse(responseText);

                // Extract text from response (different formats per provider)
                if (provider.name === 'gemini') {
                    jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                } else {
                    // OpenAI / DeepSeek
                    jsonText = data?.choices?.[0]?.message?.content;
                }
                break;
            }

            if (!jsonText) {
                throw new Error(`${provider.name} returned no usable response text.`);
            }

            // Strip markdown code fences if present
            jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

            let parsed;
            try {
                parsed = JSON.parse(jsonText);
            } catch (e) {
                console.warn(`${provider.name}: JSON parse failed, attempting recovery...`, e.message);
                parsed = recoverTruncatedJSON(jsonText);
                if (!parsed) throw e;
            }

            const resultArr = Array.isArray(parsed) ? parsed : (parsed.kanji || parsed.data || []);
            if (!Array.isArray(resultArr) || resultArr.length === 0) {
                throw new Error(`${provider.name} did not return a kanji array.`);
            }

            kanjiResult = resultArr;
            usedProviderName = provider.name;
            console.log(`Success with ${provider.name} — got ${resultArr.length} kanji`);
            break; // Success — stop trying other providers

        } catch (error) {
            console.warn(`${provider.name} failed:`, error.message);
            lastError = error;
            // Continue to next provider
        }
    }

    if (kanjiResult && kanjiResult.length > 0) {
        kanjiResult = cleanAIResponse(kanjiResult);

        const csvMap = new Map(selectedKanji.map(k => [k.char, k]));
        kanjiData = kanjiResult.map(item => {
            const csv = csvMap.get(item.char);
            // Use AI compounds if provided; otherwise fall back to local compounds from kanjidata.js
            let compounds = item.compounds || [];
            if ((!compounds || compounds.length === 0) && item.compound) {
                compounds = [{ word: item.compound, hira: '' }];
            }
            if ((!compounds || compounds.length === 0) && csv?.compounds && csv.compounds.length > 0) {
                compounds = csv.compounds;
            }
            return {
                char: item.char,
                compounds: compounds,
                compound: item.compound || (compounds[0]?.word || ''),
                on: item.on || csv?.on || '',
                kun: item.kun || csv?.kun || '',
                // Use AI Myanmar if provided; otherwise fall back to local Myanmar from kanjidata.js
                myanmar: item.myanmar || csv?.myanmar || csv?.english || '',
                ex: item.ex || [],
            };
        });

        kanjiData = kanjiData.slice(0, apiConfig.kanjiCount);
        loadingMessage.style.display = 'none';
        renderGrid();
        renderLearnedKanji();

        // Save AI-enriched data back to Supabase (overrides original data)
        saveKanjiToSupabase(kanjiData);

        // Preload the next batch of kanji with AI in the background
        preloadNextBatch(kanjiData.map(k => k.char));
    } else {
        // All AI providers failed — kanjiData already contains local data with compounds
        // and Myanmar meanings from buildKanjiDataFromCSV (set before the API call).
        console.error('All AI providers failed. Last error:', lastError?.message);
        loadingMessage.textContent = lastError?.status === 503
            ? 'AI provider error 503 Service Unavailable. Showing kanji with compounds and meanings from local data.'
            : 'All AI providers unavailable. Showing kanji with compounds and meanings from local data.';
        loadingMessage.style.color = '#e67e22';
        renderGrid();
        renderLearnedKanji();
        setTimeout(() => { loadingMessage.style.display = 'none'; }, 5000);
    }
}

// Convert katakana to hiragana for furigana display
function katakanaToHiragana(text) {
    return text.replace(/[\u30a1-\u30f6]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0x60)
    );
}

// Check if a string contains Korean characters
function containsKorean(text) {
    if (!text) return false;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        // Hangul syllables, Jamo, and compatibility Jamo
        if ((code >= 0xac00 && code <= 0xd7af) ||
            (code >= 0x1100 && code <= 0x11ff) ||
            (code >= 0x3130 && code <= 0x318f)) {
            return true;
        }
    }
    return false;
}

// Clean AI response data: remove Korean text from Myanmar meanings and examples
function cleanAIResponse(data) {
    return data.map(item => {
        // Clean Myanmar meaning
        if (containsKorean(item.myanmar)) {
            item.myanmar = '';
        }

        // Clean compound meanings
        if (Array.isArray(item.compounds)) {
            item.compounds = item.compounds.map(c => {
                if (c && typeof c === 'object' && containsKorean(c.meaning)) {
                    c.meaning = '';
                }
                return c;
            });
        }

        // Clean examples
        if (Array.isArray(item.ex)) {
            item.ex = item.ex.filter(ex => {
                if (typeof ex === 'object' && ex !== null) {
                    return !containsKorean(ex.meaning) && !containsKorean(ex.jp);
                }
                return !containsKorean(ex);
            });
        }

        return item;
    });
}

// Escape HTML special characters for safe innerHTML
// Using String.fromCharCode to prevent auto-formatter from converting entities
function escapeHTML(text) {
    const amp = '&' + 'amp;';
    const lt = '&' + 'lt;';
    const gt = '&' + 'gt;';
    const quot = '&' + 'quot;';
    const apos = '&#' + '039;';
    return text
        .replace(/&/g, amp)
        .replace(/</g, lt)
        .replace(/>/g, gt)
        .replace(/"/g, quot)
        .replace(/'/g, apos);
}

// Build furigana HTML: hiragana on top of kanji using <ruby> elements
function buildFuriganaHTML(jp, hira) {
    if (!hira) return escapeHTML(jp);

    let html = '';
    let hiraPos = 0;
    let jpPos = 0;

    while (jpPos < jp.length) {
        const ch = jp[jpPos];
        const code = ch.charCodeAt(0);
        const isKanji = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);

        if (isKanji) {
            // Collect consecutive kanji characters
            let kanjiGroup = '';
            while (jpPos < jp.length) {
                const c = jp[jpPos];
                const cCode = c.charCodeAt(0);
                const cIsKanji = (cCode >= 0x4e00 && cCode <= 0x9fff) || (cCode >= 0x3400 && cCode <= 0x4dbf);
                if (!cIsKanji) break;
                kanjiGroup += c;
                jpPos++;
            }

            // Find the hiragana reading for this kanji group
            let reading = '';
            while (hiraPos < hira.length) {
                const nextJp = jp[jpPos]; // next non-kanji char in jp
                const hCh = hira[hiraPos];

                // Stop if the next jp char matches the current hira char
                if (nextJp && hCh === nextJp) {
                    break;
                }

                reading += hCh;
                hiraPos++;
            }

            if (reading) {
                html += `<ruby>${escapeHTML(kanjiGroup)}<rt>${escapeHTML(reading)}</rt></ruby>`;
            } else {
                html += escapeHTML(kanjiGroup);
            }
        } else {
            // Non-kanji character
            html += escapeHTML(ch);

            if (hiraPos < hira.length) {
                const hCh = hira[hiraPos];
                const jpNorm = katakanaToHiragana(ch);

                if (hCh === jpNorm) {
                    // Direct match — advance
                    hiraPos++;
                } else {
                    // No direct match — this could be a number (e.g. 3 → みっつ)
                    // whose reading is in the hiragana string but not in the
                    // Japanese sentence. Look ahead in the hiragana string to
                    // find where the next kana character's reading begins.
                    const nextJp = jp[jpPos + 1];
                    if (nextJp) {
                        const nextCode = nextJp.charCodeAt(0);
                        const isNextKana = (nextCode >= 0x3040 && nextCode <= 0x30ff);
                        if (isNextKana) {
                            const nextJpNorm = katakanaToHiragana(nextJp);
                            while (hiraPos < hira.length && hira[hiraPos] !== nextJpNorm) {
                                hiraPos++;
                            }
                        }
                    }
                }
            }
            jpPos++;
        }
    }

    return html;
}

// Get a hiragana reading for a kanji item (prefer kun, fall back to on converted to hiragana)
function getHiraganaReading(item) {
    if (item.kun && item.kun !== '-' && item.kun.trim()) {
        // Clean up kun reading: remove dots, take first reading
        return item.kun.split(/[.、\s]/)[0];
    }
    if (item.on && item.on.trim()) {
        // Convert katakana on'yomi to hiragana
        return katakanaToHiragana(item.on.split(/[.、\s]/)[0]);
    }
    return '';
}

function renderGrid() {
    gridEl.innerHTML = '';
    kanjiData.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = `kanji-card ${viewedKanji.has(index) ? 'viewed' : ''}`;

        // Furigana (hiragana reading) on top of the kanji
        const reading = getHiraganaReading(item);
        if (reading) {
            const furigana = document.createElement('span');
            furigana.className = 'furigana';
            furigana.innerText = reading;
            card.appendChild(furigana);
        }

        // Kanji character
        const kanjiChar = document.createElement('span');
        kanjiChar.className = 'kanji-char';
        kanjiChar.innerText = item.char;
        card.appendChild(kanjiChar);

        card.onclick = () => openModal(index);
        gridEl.appendChild(card);
    });
    updateProgress();
}

function updateProgress() {
    const progress = (viewedKanji.size / kanjiData.length) * 100;
    progressBar.style.width = `${progress}%`;

    if (viewedKanji.size === kanjiData.length) {
        startTestBtn.style.opacity = '1';
        startTestBtn.style.pointerEvents = 'auto';
    }
}

const modal = document.getElementById('kanjiModal');

// Fill the kanji detail modal with the given kanji item
// (fields: char, compounds, on, kun, myanmar, ex, notes).
function fillKanjiModal(item) {
    currentModalItem = item;
    const modalKanjiEl = document.getElementById('modalKanji');
    modalKanjiEl.innerText = item.char;

    // If a note is registered for this kanji, show it directly on hover.
    const note = (loadUserNotes()[item.char]) || item.notes || '';
    if (note && note.trim()) {
        modalKanjiEl.title = note;
    } else {
        modalKanjiEl.removeAttribute('title');
    }

    // Display compound words as a comma-separated list to the right of the
    // "(Compound Words)" label. Each item shows the word with furigana
    // (hiragana on top of kanji) and its Myanmar meaning beside the kanji in ().
    const compoundEl = document.getElementById('modalCompound');
    const compounds = item.compounds || [];
    if (compounds.length > 0) {
        compoundEl.innerHTML = compounds.map(c => {
            const furigana = buildFuriganaHTML(c.word || '', c.hira || '');
            // Myanmar meaning shown to the side of the kanji word, in parentheses
            const meaning = c.meaning
                ? `<span class="compound-myanmar">(${escapeHTML(c.meaning)})</span>`
                : '';
            return `${furigana}${meaning}`;
        }).join(', ');
    } else if (item.compound) {
        compoundEl.innerText = item.compound;
    } else {
        compoundEl.innerText = '—';
    }

    document.getElementById('modalOn').innerText = item.on || '—';
    document.getElementById('modalKun').innerText = item.kun || '—';
    document.getElementById('modalMyanmar').innerText = item.myanmar || '—';

    const exList = document.getElementById('modalExamples');
    exList.innerHTML = '';

    // Displays usage examples with furigana (hiragana on top of kanji via <ruby>).
    (item.ex || []).forEach(ex => {
        const li = document.createElement('li');
        li.style.marginBottom = '8px';
        li.style.lineHeight = '1.8';

        if (typeof ex === 'object' && ex !== null) {
            const jp = ex.jp || '';
            const hira = ex.hira || '';
            const meaning = ex.meaning || '';

            // Japanese sentence with ruby furigana (hiragana on top of kanji)
            const jpSpan = document.createElement('span');
            jpSpan.style.fontWeight = '600';
            jpSpan.innerHTML = buildFuriganaHTML(jp, hira);

            // Myanmar meaning
            if (meaning) {
                const meaningSpan = document.createElement('span');
                meaningSpan.innerText = ` — ${meaning}`;
                meaningSpan.style.color = 'var(--primary)';
                li.appendChild(jpSpan);
                li.appendChild(meaningSpan);
            } else {
                li.appendChild(jpSpan);
            }
        } else {
            li.innerText = ex;
        }

        exList.appendChild(li);
    });

    // If no examples, show a placeholder
    if (!item.ex || item.ex.length === 0) {
        const li = document.createElement('li');
        li.innerText = 'No examples available.';
        li.style.color = '#999';
        li.style.fontStyle = 'italic';
        exList.appendChild(li);
    }

    modal.style.display = 'flex';
}

// Open the modal for a kanji from the current session grid.
function openModal(index) {
    currentModalIndex = index;
    const item = kanjiData[index];
    fillKanjiModal(item);
    viewedKanji.add(index);
    renderGrid();
}

function closeModal() {
    modal.style.display = 'none';
    // Reset to view mode when closing
    document.getElementById('modalViewMode').style.display = 'block';
    document.getElementById('modalEditMode').style.display = 'none';
}

// ===== Edit Kanji Data =====
// localStorage key for user edits
const KANJI_EDITS_STORAGE_KEY = 'learnkanji_edits';
// localStorage key for user notes
const KANJI_NOTES_STORAGE_KEY = 'learnkanji_notes';

// Load user edits from localStorage
function loadUserEdits() {
    try {
        const stored = localStorage.getItem(KANJI_EDITS_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        console.warn('Failed to load kanji edits:', e.message);
        return {};
    }
}

// Save user edits to localStorage
function saveUserEdits(edits) {
    try {
        localStorage.setItem(KANJI_EDITS_STORAGE_KEY, JSON.stringify(edits));
    } catch (e) {
        console.warn('Failed to save kanji edits:', e.message);
    }
}

// Load user notes from localStorage
function loadUserNotes() {
    try {
        const stored = localStorage.getItem(KANJI_NOTES_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        console.warn('Failed to load kanji notes:', e.message);
        return {};
    }
}

// Save user notes to localStorage
function saveUserNotes(notes) {
    try {
        localStorage.setItem(KANJI_NOTES_STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
        console.warn('Failed to save kanji notes:', e.message);
    }
}

// Apply user edits to kanjiData (called after loading local data)
function applyUserEdits() {
    const edits = loadUserEdits();
    const editKeys = Object.keys(edits);
    if (editKeys.length === 0) return;

    for (const item of kanjiData) {
        const edit = edits[item.char];
        if (!edit) continue;
        if (edit.compound !== undefined) item.compound = edit.compound;
        if (edit.compounds !== undefined) item.compounds = edit.compounds;
        if (edit.on !== undefined) item.on = edit.on;
        if (edit.kun !== undefined) item.kun = edit.kun;
        if (edit.myanmar !== undefined) item.myanmar = edit.myanmar;
    }
}

// Open the edit form for the current kanji
function openEditForm() {
    const item = currentModalItem;
    if (!item) return;

    // Fill the form with current values
    const compounds = item.compounds || [];
    document.getElementById('editCompound').value = compounds.map(c => c.word || '').join('、');
    document.getElementById('editCompoundHira').value = compounds.map(c => c.hira || '').join('、');
    document.getElementById('editOn').value = item.on || '';
    document.getElementById('editKun').value = item.kun || '';
    document.getElementById('editMyanmar').value = item.myanmar || '';

    // Switch to edit mode
    document.getElementById('modalViewMode').style.display = 'none';
    document.getElementById('modalEditMode').style.display = 'block';
}

// Save the edited data
function saveEdit() {
    const item = currentModalItem;
    if (!item) return;

    const edits = loadUserEdits();
    const compoundText = document.getElementById('editCompound').value.trim();
    const hiraText = document.getElementById('editCompoundHira').value.trim();
    const hiraList = hiraText ? hiraText.split(/[、,]/).map(h => h.trim()).filter(Boolean) : [];
    const compounds = compoundText
        ? compoundText.split(/[、,]/).map((w, i) => w.trim()).filter(Boolean).map((word, i) => ({ word, hira: hiraList[i] || '' }))
        : [];

    const edit = {
        compound: compounds[0]?.word || '',
        compounds: compounds,
        on: document.getElementById('editOn').value.trim(),
        kun: document.getElementById('editKun').value.trim(),
        myanmar: document.getElementById('editMyanmar').value.trim(),
    };

    // Save to localStorage
    edits[item.char] = edit;
    saveUserEdits(edits);

    // Apply to current data
    item.compound = edit.compound;
    item.compounds = edit.compounds;
    item.on = edit.on;
    item.kun = edit.kun;
    item.myanmar = edit.myanmar;

    // Save to Supabase (overrides original data)
    updateKanjiInSupabase(item.char, {
        on_yomi: edit.on,
        kun_yomi: edit.kun,
        myanmar: edit.myanmar,
        compounds: edit.compounds,
    });

    // Refresh the modal display (works for both grid and learned/database kanji)
    fillKanjiModal(item);
    alert('✅ Saved! Your edit for "' + item.char + '" is stored in this browser and Supabase.');
}

// Cancel editing
function cancelEdit() {
    document.getElementById('modalViewMode').style.display = 'block';
    document.getElementById('modalEditMode').style.display = 'none';
}

// ===== Notes =====
// Open the notes popup for the current kanji
function openNotesPopup() {
    const item = currentModalItem;
    if (!item) return;

    document.getElementById('notesKanjiChar').innerText = item.char;
    const notes = loadUserNotes();
    document.getElementById('notesText').value = notes[item.char] || '';
    document.getElementById('notesModal').style.display = 'flex';
}

// Close the notes popup
function closeNotesPopup() {
    document.getElementById('notesModal').style.display = 'none';
}

// Save the note for the current kanji
function saveNote() {
    const item = currentModalItem;
    if (!item) return;

    const notes = loadUserNotes();
    const text = document.getElementById('notesText').value.trim();
    if (text) {
        notes[item.char] = text;
    } else {
        delete notes[item.char];
    }
    saveUserNotes(notes);
    // Save note to Supabase
    updateKanjiInSupabase(item.char, { notes: text || null });
    alert('✅ Note saved for "' + item.char + '"!');
    closeNotesPopup();
}

// Delete the note for the current kanji
function deleteNote() {
    const item = currentModalItem;
    if (!item) return;

    const notes = loadUserNotes();
    delete notes[item.char];
    saveUserNotes(notes);
    // Delete note from Supabase
    updateKanjiInSupabase(item.char, { notes: null });
    document.getElementById('notesText').value = '';
    alert('🗑️ Note deleted for "' + item.char + '".');
    closeNotesPopup();
}

function startTest() {
    document.getElementById('testSection').style.display = 'block';
    startTestBtn.style.display = 'none';
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

    testQuestions = [...kanjiData].sort(() => 0.5 - Math.random()).slice(0, 10);
    currentQuestionIndex = 0;
    score = 0;
    learnedKanji = [];
    loadQuestion();
}

function loadQuestion() {
    if (currentQuestionIndex >= testQuestions.length) {
        showTestResults();
        return;
    }

    const q = testQuestions[currentQuestionIndex];
    document.getElementById('questionTitle').innerText = `Question ${currentQuestionIndex + 1}/${testQuestions.length}`;
    document.getElementById('questionText').innerText = `What is the Myanmar meaning of character "${q.char}" (${q.compound || '—'})?`;

    let options = [q.myanmar];
    while (options.length < 4) {
        const randomItem = kanjiData[Math.floor(Math.random() * kanjiData.length)].myanmar;
        if (!options.includes(randomItem)) {
            options.push(randomItem);
        }
    }
    options.sort(() => 0.5 - Math.random());

    const optionsGrid = document.getElementById('optionsGrid');
    optionsGrid.innerHTML = '';
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerText = opt;
        btn.onclick = () => selectAnswer(opt, q.myanmar);
        optionsGrid.appendChild(btn);
    });
}

function selectAnswer(selected, correct) {
    if (selected === correct) {
        score++;
        // Track the correctly answered kanji for the learned group
        const q = testQuestions[currentQuestionIndex];
        if (q && !learnedKanji.some(k => k.char === q.char)) {
            learnedKanji.push(q);
            // Mark as learned in Supabase (syncs across devices)
            updateKanjiInSupabase(q.char, { learned: true });
        }
    }
    currentQuestionIndex++;
    loadQuestion();
}

// Check if a kanji char is already in the saved learned list
function isKanjiLearned(char) {
    return savedLearnedKanji.some(k => k.char === char);
}

function showTestResults() {
    document.getElementById('testSection').style.display = 'none';
    const resultsContainer = document.getElementById('resultsContainer');
    resultsContainer.style.display = 'block';

    let advice = "";
    if (score >= 9) {
        advice = "Outstanding performance! You have a solid grasp of these JLPT N2 kanji meanings and contexts. You are well on your way to mastering this set.";
    } else if (score >= 6) {
        advice = "Good job! You understand most concepts, but a few terms need review. Focus on the examples and compound usage to reinforce retention.";
    } else {
        advice = "Keep practicing! These kanji can be tricky, so review the Myanmar meanings and usage examples again before trying another quiz.";
    }

    resultsContainer.innerHTML = `
        <h3>Study Results</h3>
        <p><strong>Your Final Score:</strong> ${score} / ${testQuestions.length} (${Math.round(score / testQuestions.length * 100)}%)</p>
        <div class="result-box">
            <p><strong>Review Advice:</strong></p>
            <p>${advice}</p>
        </div>
        <button class="btn" style="margin-top: 15px;" onclick="location.reload()">Restart Learning Session</button>
    `;

    // Save learned kanji to localStorage and show them
    saveLearnedKanji();
    renderLearnedKanji();
}

// Fetch a single kanji's data from the database (Supabase) — NOT AI-generated.
async function fetchOneKanjiFromDB(char) {
    try {
        const response = await fetch(`/api/supabase?char=${encodeURIComponent(char)}`, { method: 'GET' });
        if (!response.ok) return null;
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const row = rows[0];
        return {
            char: row.char,
            compounds: Array.isArray(row.compounds) ? row.compounds : [],
            on: row.on_yomi || '',
            kun: row.kun_yomi || '',
            myanmar: row.myanmar || row.english || '',
            english: row.english || '',
            ex: Array.isArray(row.examples) ? row.examples : [],
            notes: row.notes || null,
        };
    } catch (e) {
        console.warn('Failed to load kanji from DB:', e.message);
        return null;
    }
}

// Open the kanji detail popup for a learned kanji using its data from the
// database (Supabase), not from AI.
async function openLearnedKanji(char) {
    const item = await fetchOneKanjiFromDB(char);
    if (!item) {
        alert(`Could not load data for "${char}" from the database.`);
        return;
    }
    currentModalIndex = -1; // not part of the current session grid
    fillKanjiModal(item);
}

// Display all learned kanji (saved + current session) in the "learned" group at the bottom
function renderLearnedKanji() {
    const learnedSection = document.getElementById('learnedSection');
    const learnedGrid = document.getElementById('learnedGrid');
    const learnedCount = document.getElementById('learnedCount');

    // Merge saved and current session learned kanji (no duplicates)
    const allLearned = [...savedLearnedKanji];
    for (const item of learnedKanji) {
        if (!allLearned.some(k => k.char === item.char)) {
            allLearned.push(item);
        }
    }

    if (allLearned.length === 0) {
        learnedSection.style.display = 'none';
        return;
    }

    learnedSection.style.display = 'block';
    if (learnedCount) {
        learnedCount.innerText = allLearned.length;
    }
    learnedGrid.innerHTML = '';

    allLearned.forEach(item => {
        const card = document.createElement('div');
        card.className = 'kanji-card learned';

        // Furigana (hiragana reading) on top of the kanji
        const reading = getHiraganaReading(item);
        if (reading) {
            const furigana = document.createElement('span');
            furigana.className = 'furigana';
            furigana.innerText = reading;
            card.appendChild(furigana);
        }

        // Kanji character
        const kanjiChar = document.createElement('span');
        kanjiChar.className = 'kanji-char';
        kanjiChar.innerText = item.char;
        card.appendChild(kanjiChar);

        // Clicking a learned kanji opens its detail popup (data from the database).
        card.style.cursor = 'pointer';
        card.onclick = () => openLearnedKanji(item.char);

        learnedGrid.appendChild(card);
    });
}

// Load saved learned kanji on startup, then fetch kanji data
loadSavedLearnedKanji();
fetchKanjiData();

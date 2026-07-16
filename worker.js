// =====================================
// Bitcoin1070 Market API v10.0
// 現在価格 + 過去チャートデータ
// =====================================

const DEFAULT_SYMBOLS = {
    NVDA: "NVDA",
    MHI: "7011.T",
    ADVT: "6857.T",
    FJK: "5803.T",
    VRAIN: "135A.T",
    USDJPY: "JPY=X"
};

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "public, max-age=60"
};

function jsonResponse(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: CORS_HEADERS
        }
    );
}

function isValidYahooSymbol(symbol) {
    return /^[A-Za-z0-9.^=_-]{1,30}$/.test(symbol);
}

// =====================================
// 現在価格用シンボル解析
// symbols=AAPL:AAPL,INPEX:1605.T
// =====================================

function parseRequestedSymbols(url) {
    const parameter =
        url.searchParams.get("symbols");

    if (!parameter) {
        return { ...DEFAULT_SYMBOLS };
    }

    const parsed = {};

    parameter
        .split(",")
        .slice(0, 30)
        .forEach(item => {
            const separatorIndex =
                item.indexOf(":");

            if (separatorIndex <= 0) {
                return;
            }

            const key =
                item
                    .slice(0, separatorIndex)
                    .trim()
                    .toUpperCase();

            const yahooSymbol =
                item
                    .slice(separatorIndex + 1)
                    .trim();

            const validKey =
                /^[A-Z0-9_-]{1,20}$/.test(key);

            if (
                validKey &&
                isValidYahooSymbol(yahooSymbol)
            ) {
                parsed[key] = yahooSymbol;
            }
        });

    parsed.USDJPY = "JPY=X";

    return Object.keys(parsed).length > 1
        ? parsed
        : { ...DEFAULT_SYMBOLS };
}

// =====================================
// Yahoo Finance取得
// =====================================

async function fetchYahooChart(
    symbol,
    interval,
    range
) {
    const encodedSymbol =
        encodeURIComponent(symbol);

    const endpoint =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodedSymbol +
        `?interval=${interval}` +
        `&range=${range}` +
        "&includePrePost=false" +
        "&events=div%2Csplits";

    const response = await fetch(endpoint, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (compatible; Bitcoin1070/10.0)",
            "Accept": "application/json"
        },
        cf: {
            cacheTtl: 60,
            cacheEverything: true
        }
    });

    if (!response.ok) {
        throw new Error(
            `${symbol}: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    const result =
        data?.chart?.result?.[0];

    if (!result) {
        const message =
            data?.chart?.error?.description ||
            "価格データなし";

        throw new Error(
            `${symbol}: ${message}`
        );
    }

    return result;
}

// =====================================
// 現在価格
// =====================================

async function fetchCurrentPrice(symbol) {
    const result =
        await fetchYahooChart(
            symbol,
            "1m",
            "1d"
        );

    const meta =
        result.meta || {};

    let price =
        Number(
            meta.regularMarketPrice
        );

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {
        const closes =
            result
                ?.indicators
                ?.quote
                ?.[0]
                ?.close || [];

        const validCloses =
            closes.filter(value =>
                Number.isFinite(
                    Number(value)
                ) &&
                Number(value) > 0
            );

        price =
            Number(
                validCloses[
                    validCloses.length - 1
                ]
            );
    }

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {
        throw new Error(
            `${symbol}: 有効な価格なし`
        );
    }

    return {
        price,
        currency:
            meta.currency || "",
        marketState:
            meta.marketState || "",
        exchangeName:
            meta.exchangeName || "",
        updatedAt:
            Number(
                meta.regularMarketTime
            ) > 0
                ? new Date(
                    Number(
                        meta.regularMarketTime
                    ) * 1000
                ).toISOString()
                : null
    };
}

// =====================================
// 過去日足データ
// =====================================

async function fetchHistory(symbol) {
    const result =
        await fetchYahooChart(
            symbol,
            "1d",
            "1y"
        );

    const timestamps =
        result.timestamp || [];

    const quote =
        result
            ?.indicators
            ?.quote
            ?.[0] || {};

    const adjustedClose =
        result
            ?.indicators
            ?.adjclose
            ?.[0]
            ?.adjclose || [];

    const candles = [];

    timestamps.forEach(
        (timestamp, index) => {
            const close =
                Number(
                    adjustedClose[index] ??
                    quote.close?.[index]
                );

            if (
                !Number.isFinite(close) ||
                close <= 0
            ) {
                return;
            }

            candles.push({
                date:
                    new Date(
                        timestamp * 1000
                    ).toISOString(),

                open:
                    Number(
                        quote.open?.[index]
                    ) || close,

                high:
                    Number(
                        quote.high?.[index]
                    ) || close,

                low:
                    Number(
                        quote.low?.[index]
                    ) || close,

                close,

                volume:
                    Number(
                        quote.volume?.[index]
                    ) || 0
            });
        }
    );

    if (candles.length === 0) {
        throw new Error(
            `${symbol}: 日足データなし`
        );
    }

    const meta =
        result.meta || {};

    return {
        symbol,
        currency:
            meta.currency || "",
        exchangeName:
            meta.exchangeName || "",
        candles,
        count:
            candles.length,
        fetchedAt:
            new Date().toISOString()
    };
}

// =====================================
// 現在価格API
// =====================================

async function handleCurrentPrices(url) {
    const requestedSymbols =
        parseRequestedSymbols(url);

    const entries =
        Object.entries(
            requestedSymbols
        );

    const results =
        await Promise.allSettled(
            entries.map(
                async ([key, symbol]) => {
                    const result =
                        await fetchCurrentPrice(
                            symbol
                        );

                    return {
                        key,
                        symbol,
                        ...result
                    };
                }
            )
        );

    const prices = {};
    const details = {};
    const errors = [];

    results.forEach(
        (result, index) => {
            const [key, symbol] =
                entries[index];

            if (
                result.status ===
                "fulfilled"
            ) {
                prices[key] =
                    result.value.price;

                details[key] = {
                    symbol,
                    currency:
                        result.value.currency,
                    marketState:
                        result.value.marketState,
                    exchangeName:
                        result.value.exchangeName,
                    updatedAt:
                        result.value.updatedAt
                };
            } else {
                errors.push({
                    key,
                    symbol,
                    message:
                        result.reason?.message ||
                        "取得失敗"
                });
            }
        }
    );

    if (
        Object.keys(prices).length === 0
    ) {
        return jsonResponse(
            {
                error:
                    "すべての価格取得に失敗",
                errors
            },
            502
        );
    }

    return jsonResponse({
        ...prices,
        details,
        errors,
        fetchedAt:
            new Date().toISOString(),
        requestedSymbols
    });
}

// =====================================
// 過去データAPI
// 使用例：?mode=history&symbol=AAPL
// =====================================

async function handleHistory(url) {
    const symbol =
        String(
            url.searchParams.get(
                "symbol"
            ) || ""
        ).trim();

    if (!symbol) {
        return jsonResponse(
            {
                error:
                    "symbolを指定してください"
            },
            400
        );
    }

    if (!isValidYahooSymbol(symbol)) {
        return jsonResponse(
            {
                error:
                    "無効なsymbolです"
            },
            400
        );
    }

    const history =
        await fetchHistory(symbol);

    return jsonResponse(history);
}



// =====================================
// 仮想通貨価格API v8.2
// mode=crypto&ids=bitcoin,ethereum
// =====================================

const COINGECKO_ID_PATTERN = /^[a-z0-9-]{1,80}$/;

function parseCryptoIds(url) {
    const raw = String(url.searchParams.get("ids") || "bitcoin");
    return [...new Set(raw.split(",").map(v => v.trim().toLowerCase()).filter(v => COINGECKO_ID_PATTERN.test(v)))].slice(0, 30);
}

async function fetchCoinGeckoJson(endpoint, cacheTtl = 60) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetch(endpoint, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "Bitcoin1070-PRO/10.0"
                },
                cf: { cacheTtl, cacheEverything: true }
            });
            if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
        }
    }
    throw lastError || new Error("CoinGecko取得失敗");
}

async function handleCryptoPrices(url) {
    const ids = parseCryptoIds(url);
    if (ids.length === 0) return jsonResponse({ error: "有効なidsを指定してください" }, 400);

    const endpoint = "https://api.coingecko.com/api/v3/simple/price" +
        `?ids=${encodeURIComponent(ids.join(","))}` +
        "&vs_currencies=jpy&include_24hr_change=true&include_last_updated_at=true";

    const data = await fetchCoinGeckoJson(endpoint, 60);
    const prices = {};
    const missing = [];

    ids.forEach(id => {
        const jpy = Number(data?.[id]?.jpy);
        if (Number.isFinite(jpy) && jpy > 0) {
            prices[id] = {
                jpy,
                jpy_24h_change: Number(data?.[id]?.jpy_24h_change) || 0,
                last_updated_at: Number(data?.[id]?.last_updated_at) || null
            };
        } else {
            missing.push(id);
        }
    });

    if (Object.keys(prices).length === 0) {
        return jsonResponse({ error: "仮想通貨価格を取得できませんでした", missing }, 502);
    }

    return jsonResponse({ prices, missing, fetchedAt: new Date().toISOString() });
}

async function handleCryptoHistory(url) {
    const id = String(url.searchParams.get("id") || "bitcoin").trim().toLowerCase();
    const daysRaw = Number(url.searchParams.get("days") || 120);
    const days = Math.min(365, Math.max(30, Number.isFinite(daysRaw) ? Math.floor(daysRaw) : 120));
    if (!COINGECKO_ID_PATTERN.test(id)) return jsonResponse({ error: "無効なidです" }, 400);

    const endpoint = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart` +
        `?vs_currency=jpy&days=${days}&interval=daily`;
    const data = await fetchCoinGeckoJson(endpoint, 300);
    const prices = Array.isArray(data?.prices) ? data.prices.filter(row => Array.isArray(row) && Number(row[1]) > 0) : [];
    if (prices.length === 0) return jsonResponse({ error: "履歴データなし" }, 502);
    return jsonResponse({ id, days, prices, fetchedAt: new Date().toISOString() });
}



// =====================================
// 銘柄検索API v10.0
// mode=asset-search&q=9984&type=jp
// =====================================

function normalizeSearchType(value) {
    const type = String(value || "").toLowerCase();
    return ["jp", "us", "crypto", "all"].includes(type) ? type : "all";
}

async function fetchYahooSearch(query) {
    const endpoint = "https://query1.finance.yahoo.com/v1/finance/search" +
        `?q=${encodeURIComponent(query)}` +
        "&quotesCount=20&newsCount=0&enableFuzzyQuery=true";
    const response = await fetch(endpoint, {
        headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; Bitcoin1070/10.0)"
        },
        cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) throw new Error(`Yahoo search HTTP ${response.status}`);
    return await response.json();
}

async function fetchCoinGeckoSearch(query) {
    const endpoint = "https://api.coingecko.com/api/v3/search" +
        `?query=${encodeURIComponent(query)}`;
    return await fetchCoinGeckoJson(endpoint, 300);
}

function yahooResultToAsset(item) {
    const symbol = String(item?.symbol || "").toUpperCase();
    if (!symbol) return null;
    const isJapan = /\.T$/i.test(symbol);
    const type = isJapan ? "jp" : "us";
    const cleanSymbol = isJapan ? symbol.replace(/\.T$/i, "") : symbol;
    const name = String(item?.shortname || item?.longname || item?.name || cleanSymbol).trim();
    const quoteType = String(item?.quoteType || "").toUpperCase();
    if (!["EQUITY", "ETF", "MUTUALFUND"].includes(quoteType)) return null;
    return {
        type,
        symbol: cleanSymbol,
        name,
        yahooSymbol: symbol,
        exchange: item?.exchange || item?.exchDisp || "",
        source: "yahoo"
    };
}

function coinResultToAsset(item) {
    const id = String(item?.id || "").trim().toLowerCase();
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    const name = String(item?.name || symbol).trim();
    if (!id || !symbol) return null;
    return {
        type: "crypto",
        symbol,
        name,
        coinGeckoId: id,
        marketCapRank: Number(item?.market_cap_rank) || null,
        source: "coingecko"
    };
}

async function handleAssetSearch(url) {
    const query = String(url.searchParams.get("q") || "").trim();
    const type = normalizeSearchType(url.searchParams.get("type"));
    if (query.length < 1) return jsonResponse({ error: "qを指定してください" }, 400);

    const tasks = [];
    if (type === "all" || type === "jp" || type === "us") tasks.push(fetchYahooSearch(query));
    else tasks.push(Promise.resolve(null));
    if (type === "all" || type === "crypto") tasks.push(fetchCoinGeckoSearch(query));
    else tasks.push(Promise.resolve(null));

    const [yahooSettled, cryptoSettled] = await Promise.allSettled(tasks);
    const results = [];
    const errors = [];

    if (yahooSettled.status === "fulfilled" && yahooSettled.value) {
        const quotes = Array.isArray(yahooSettled.value?.quotes) ? yahooSettled.value.quotes : [];
        quotes.map(yahooResultToAsset).filter(Boolean).forEach(item => {
            if (type === "all" || item.type === type) results.push(item);
        });
    } else if (yahooSettled.status === "rejected") {
        errors.push(yahooSettled.reason?.message || "Yahoo検索失敗");
    }

    if (cryptoSettled.status === "fulfilled" && cryptoSettled.value) {
        const coins = Array.isArray(cryptoSettled.value?.coins) ? cryptoSettled.value.coins : [];
        coins.slice(0, 20).map(coinResultToAsset).filter(Boolean).forEach(item => results.push(item));
    } else if (cryptoSettled.status === "rejected") {
        errors.push(cryptoSettled.reason?.message || "CoinGecko検索失敗");
    }

    // 日本株コードならYahoo結果がなくても入力を止めない
    if ((type === "jp" || type === "all") && /^(?:[0-9]{4}|[0-9]{3}[A-Z])$/i.test(query)) {
        const clean = query.toUpperCase().replace(/\.T$/i, "");
        if (!results.some(item => item.type === "jp" && item.symbol === clean)) {
            results.push({ type: "jp", symbol: clean, name: `日本株 ${clean}`, yahooSymbol: `${clean}.T`, source: "fallback" });
        }
    }

    const unique = [];
    const seen = new Set();
    for (const item of results) {
        const key = `${item.type}:${item.coinGeckoId || item.yahooSymbol || item.symbol}`;
        if (!seen.has(key)) { seen.add(key); unique.push(item); }
    }

    return jsonResponse({ query, type, results: unique.slice(0, 20), errors, fetchedAt: new Date().toISOString() });
}

// =====================================
// Worker
// =====================================

export default {
    async fetch(request) {
        if (
            request.method ===
            "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,
                    headers:
                        CORS_HEADERS
                }
            );
        }

        if (
            request.method !== "GET"
        ) {
            return jsonResponse(
                {
                    error:
                        "GETのみ対応しています"
                },
                405
            );
        }

        try {
            const url =
                new URL(
                    request.url
                );

            const mode =
                url.searchParams.get(
                    "mode"
                );

            if (mode === "asset-search") {
                return await handleAssetSearch(url);
            }

            if (mode === "crypto") {
                return await handleCryptoPrices(url);
            }

            if (mode === "crypto-history") {
                return await handleCryptoHistory(url);
            }

            if (
                mode === "history"
            ) {
                return await handleHistory(
                    url
                );
            }

            return await handleCurrentPrices(
                url
            );

        } catch (error) {
            return jsonResponse(
                {
                    error:
                        "市場データ取得エラー",
                    message:
                        error?.message ||
                        String(error)
                },
                500
            );
        }
    }
};

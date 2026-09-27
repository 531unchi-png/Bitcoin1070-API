// =====================================
// Bitcoin1070 Market API v11.6
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

// Only these two eMAXIS Slim funds have verified association codes in the app.
// MUFG's public fund-information API returns NAV per 10,000 units and its base date.
const FUND_CODES = new Set(["0331418A", "03311187"]);

async function fetchFundNav(symbol) {
    const endpoint = `https://developer.am.mufg.jp/fund_information_latest/association_fund_cd/${symbol}`;
    const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        cf: { cacheTtl: 3600, cacheEverything: true }
    });
    if (!response.ok) throw new Error(`配信元 HTTP ${response.status}`);
    const payload = await response.json();
    const item = payload?.datasets?.[0];
    if (String(item?.association_fund_cd || "").toUpperCase() !== symbol) {
        throw new Error("ファンドコードが一致しません");
    }
    const price = Number(item.nav);
    const rawDate = String(item.base_date || "");
    const date = /^\d{8}$/.test(rawDate)
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : "";
    const todayJst = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    if (!Number.isFinite(price) || price <= 0 || price > 1000000 ||
        !date || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
        date > todayJst) throw new Error("基準価額または公表日が不正です");
    return { navJpy: price, navDate: date, source: "mufg" };
}

async function handleFundNav(url) {
    const raw = String(url.searchParams.get("symbols") || "");
    const requested = [...new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!requested.length || requested.length > 2 || requested.some(s => !FUND_CODES.has(s))) {
        return jsonResponse({ error: "対応する投資信託コードを指定してください" }, 400);
    }
    const settled = await Promise.allSettled(requested.map(fetchFundNav));
    const funds = {}, errors = {};
    settled.forEach((result, index) => {
        const symbol = requested[index];
        if (result.status === "fulfilled") funds[symbol] = result.value;
        else errors[symbol] = result.reason?.message || "取得失敗";
    });
    return jsonResponse({ funds, errors, fetchedAt: new Date().toISOString() },
        Object.keys(funds).length ? 200 : 502);
}

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
    range,
    period1 = null,
    period2 = null
) {
    const encodedSymbol =
        encodeURIComponent(symbol);

    const endpoint =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodedSymbol +
        `?interval=${interval}` +
        (period1 !== null && period2 !== null
            ? `&period1=${period1}&period2=${period2}`
            : `&range=${range}`) +
        "&includePrePost=false" +
        "&events=div%2Csplits";

    const response = await fetch(endpoint, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (compatible; Bitcoin1070/11.6)",
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
                    "User-Agent": "Bitcoin1070-PRO/11.6"
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
// BTC長期サイクルAPI v11.6
// mode=btc-cycle
// Yahoo Finance BTC-JPYの実際の観測間隔を検査し、現在価格も同時返却
// =====================================

function validateBtcCycleCadence(candles, source) {
    const days = [...new Set(candles.map(c => Date.parse(c.date)).filter(Number.isFinite))].sort((a, b) => a - b);
    const gaps = days.slice(1).map((day, i) => (day - days[i]) / 86400000).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] || Infinity;
    if (days.length < 400 || median > 10 || days[0] > Date.parse("2014-12-01") ||
        days[days.length - 1] < Date.now() - 21 * 86400000 || gaps[gaps.length - 1] > 35) {
        throw new Error(`${source}: BTC履歴の粒度・期間が不足（${days.length}点、中央値${Math.round(median)}日）`);
    }
    return Math.round(median);
}

async function fetchBtcLongHistoryYahoo() {
    // Yahoo may silently return monthly points for range=max despite interval=1wk.
    // Request shorter overlapping windows and reject the result unless it is weekly in fact.
    const since = Date.parse("2014-09-01"), until = Date.now() + 86400000, span = 900 * 86400000;
    const windows = [];
    for (let start = since; start < until; start += span) {
        windows.push([Math.floor(start / 1000), Math.floor(Math.min(start + span + 7 * 86400000, until) / 1000)]);
    }
    const results = await Promise.all(windows.map(([start, end]) => fetchYahooChart("BTC-JPY", "1wk", null, start, end)));
    const byDay = new Map();
    results.forEach(result => {
        const quote = result?.indicators?.quote?.[0] || {};
        const adjustedClose = result?.indicators?.adjclose?.[0]?.adjclose || [];
        (result.timestamp || []).forEach((timestamp, index) => {
            const close = Number(adjustedClose[index] ?? quote.close?.[index]);
            if (!Number.isFinite(close) || close <= 0) return;
            const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
            byDay.set(day, {
                date: new Date(timestamp * 1000).toISOString(),
                open: Number(quote.open?.[index]) || close,
                high: Number(quote.high?.[index]) || close,
                low: Number(quote.low?.[index]) || close,
                close, volume: Number(quote.volume?.[index]) || 0
            });
        });
    });
    const candles = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const cadenceDays = validateBtcCycleCadence(candles, "Yahoo");
    const meta = results[results.length - 1].meta || {};
    const latest = candles[candles.length - 1];
    return {
        source: "yahoo",
        cadenceDays,
        symbol: "BTC-JPY",
        currency: meta.currency || "JPY",
        currentPrice: Number(meta.regularMarketPrice) > 0 ? Number(meta.regularMarketPrice) : latest.close,
        updatedAt: Number(meta.regularMarketTime) > 0 ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : latest.date,
        candles
    };
}

async function fetchBtcLongHistoryCoinGecko() {
    const endpoint = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart" +
        "?vs_currency=jpy&days=max&interval=daily";
    const data = await fetchCoinGeckoJson(endpoint, 900);
    const raw = Array.isArray(data?.prices) ? data.prices : [];
    const candles = raw
        .filter((row, index) => Array.isArray(row) && Number(row[1]) > 0 && (index % 7 === 0 || index === raw.length - 1))
        .map(row => ({
            date: new Date(Number(row[0])).toISOString(),
            open: Number(row[1]), high: Number(row[1]), low: Number(row[1]), close: Number(row[1]), volume: 0
        }));
    const cadenceDays = validateBtcCycleCadence(candles, "CoinGecko");
    return {
        source: "coingecko",
        cadenceDays,
        symbol: "bitcoin",
        currency: "JPY",
        currentPrice: candles[candles.length - 1].close,
        updatedAt: candles[candles.length - 1].date,
        candles
    };
}

async function handleBtcCycle() {
    const errors = [];
    try {
        const result = await fetchBtcLongHistoryYahoo();
        return jsonResponse({ ...result, count: result.candles.length, errors, fetchedAt: new Date().toISOString() });
    } catch (error) {
        errors.push(`Yahoo: ${error?.message || String(error)}`);
    }
    try {
        const result = await fetchBtcLongHistoryCoinGecko();
        return jsonResponse({ ...result, count: result.candles.length, errors, fetchedAt: new Date().toISOString() });
    } catch (error) {
        errors.push(`CoinGecko: ${error?.message || String(error)}`);
    }
    return jsonResponse({ error: "BTC長期履歴を取得できませんでした", errors }, 502);
}

async function handleFearGreed() {
    const response = await fetch("https://api.alternative.me/fng/?limit=1", {
        headers: { "Accept": "application/json", "User-Agent": "Bitcoin1070-PRO/11.6" },
        cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) throw new Error(`Fear & Greed HTTP ${response.status}`);
    const data = await response.json();
    const item = data?.data?.[0];
    const value = Number(item?.value);
    if (!Number.isFinite(value)) throw new Error("Fear & Greedデータ不正");
    return jsonResponse({
        value,
        classification: String(item?.value_classification || ""),
        timestamp: item?.timestamp || null,
        fetchedAt: new Date().toISOString()
    });
}

// =====================================
// 銘柄検索API v10.1
// mode=asset-search&q=9984&type=jp
// =====================================

function normalizeSearchType(value) {
    const type = String(value || "").toLowerCase();
    return ["jp", "us", "crypto", "all"].includes(type) ? type : null;
}

function hiraToKata(value) {
    return String(value || "").replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function kataToHira(value) {
    return String(value || "").replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function normalizeSearchText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

const SEARCH_TIMEOUT_MS = 4500;
const SEARCH_RESULT_LIMIT_DEFAULT = 20;
const SEARCH_RESULT_LIMIT_MAX = 50;

async function fetchJsonWithTimeout(endpoint, options, timeoutMs = SEARCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(endpoint, { ...options, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        if (error?.name === "AbortError") throw new Error("外部検索がタイムアウトしました");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchYahooSearchOnce(query) {
    const endpoint = "https://query1.finance.yahoo.com/v1/finance/search" +
        `?q=${encodeURIComponent(query)}` +
        "&quotesCount=50&newsCount=0&enableFuzzyQuery=true" +
        "&lang=ja-JP&region=JP";
    return await fetchJsonWithTimeout(endpoint, {
        headers: {
            "Accept": "application/json",
            "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
            "User-Agent": "Mozilla/5.0 (compatible; Bitcoin1070/11.6)"
        },
        cf: { cacheTtl: 300, cacheEverything: true }
    });
}

async function fetchYahooSearch(query) {
    const normalized = normalizeSearchText(query);
    const variants = [...new Set([normalized, hiraToKata(normalized), kataToHira(normalized)].filter(Boolean))].slice(0, 3);
    const settled = await Promise.allSettled(variants.map(fetchYahooSearchOnce));
    const quotes = [];
    const seen = new Set();
    let firstError = null;
    for (const result of settled) {
        if (result.status === "rejected") {
            firstError ||= result.reason;
            continue;
        }
        for (const item of (Array.isArray(result.value?.quotes) ? result.value.quotes : [])) {
            const key = String(item?.symbol || "");
            if (key && !seen.has(key)) { seen.add(key); quotes.push(item); }
        }
    }
    if (!quotes.length && firstError) throw firstError;
    return { quotes };
}

async function fetchCoinGeckoSearch(query) {
    const endpoint = "https://api.coingecko.com/api/v3/search" +
        `?query=${encodeURIComponent(query)}`;
    return await fetchJsonWithTimeout(endpoint, {
        headers: { "Accept": "application/json", "User-Agent": "Bitcoin1070-PRO/12.4" },
        cf: { cacheTtl: 300, cacheEverything: true }
    });
}

const JP_NAME_CORRECTIONS = {
    "9984.T": "ソフトバンクグループ",
    "9434.T": "ソフトバンク",
    "6269.T": "三井海洋開発",
    "285A.T": "キオクシアホールディングス",
    "3556.T": "リネットジャパングループ"
};

function yahooResultToAsset(item) {
    const symbol = String(item?.symbol || "").toUpperCase();
    if (!symbol) return null;
    const isJapan = /\.T$/i.test(symbol);
    const type = isJapan ? "jp" : "us";
    const cleanSymbol = isJapan ? symbol.replace(/\.T$/i, "") : symbol;
    const name = JP_NAME_CORRECTIONS[symbol] || String(item?.longname || item?.shortname || item?.name || cleanSymbol).trim();
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

// External search remains the source of truth. This small alias index makes the
// most frequently used Japanese names/kana useful even when a provider only
// indexes an English legal name.
const ASSET_SEARCH_ALIASES = [
    { type: "jp", symbol: "7203", name: "トヨタ自動車", yahooSymbol: "7203.T", aliases: "とよた トヨタ toyota" },
    { type: "jp", symbol: "6758", name: "ソニーグループ", yahooSymbol: "6758.T", aliases: "そにー ソニー sony" },
    { type: "jp", symbol: "9984", name: "ソフトバンクグループ", yahooSymbol: "9984.T", aliases: "そふとばんく softbank sbg" },
    { type: "jp", symbol: "9432", name: "日本電信電話", yahooSymbol: "9432.T", aliases: "にほんでんしんでんわ えぬてぃてぃ エヌティティ ntt" },
    { type: "jp", symbol: "8306", name: "三菱UFJフィナンシャル・グループ", yahooSymbol: "8306.T", aliases: "みつびし ゆーえふじぇい mufg" },
    { type: "jp", symbol: "7011", name: "三菱重工業", yahooSymbol: "7011.T", aliases: "みつびしじゅうこう 三菱重工 mhi" },
    { type: "us", symbol: "AAPL", name: "Apple Inc.", yahooSymbol: "AAPL", aliases: "apple アップル あっぷる" },
    { type: "us", symbol: "MSFT", name: "Microsoft Corporation", yahooSymbol: "MSFT", aliases: "microsoft マイクロソフト まいくろそふと" },
    { type: "us", symbol: "NVDA", name: "NVIDIA Corporation", yahooSymbol: "NVDA", aliases: "nvidia エヌビディア えぬびでぃあ" },
    { type: "us", symbol: "TSLA", name: "Tesla, Inc.", yahooSymbol: "TSLA", aliases: "tesla テスラ てすら" },
    { type: "crypto", symbol: "BTC", name: "Bitcoin", coinGeckoId: "bitcoin", aliases: "bitcoin ビットコイン びっとこいん" },
    { type: "crypto", symbol: "ETH", name: "Ethereum", coinGeckoId: "ethereum", aliases: "ethereum イーサリアム いーさりあむ イーサ" },
    { type: "crypto", symbol: "XRP", name: "XRP", coinGeckoId: "ripple", aliases: "ripple リップル りっぷる" },
    { type: "crypto", symbol: "SOL", name: "Solana", coinGeckoId: "solana", aliases: "solana ソラナ そらな" }
];

function findAliasResults(query, type) {
    const needle = kataToHira(normalizeSearchText(query)).toLocaleLowerCase("ja");
    return ASSET_SEARCH_ALIASES.filter(item => {
        if (type !== "all" && item.type !== type) return false;
        const haystack = kataToHira(`${item.symbol} ${item.name} ${item.yahooSymbol || ""} ${item.coinGeckoId || ""} ${item.aliases}`).toLocaleLowerCase("ja");
        return haystack.includes(needle);
    }).map(({ aliases, ...item }) => ({ ...item, source: "local" }));
}

function resultScore(item, query) {
    const needle = kataToHira(query).toLocaleLowerCase("ja");
    const symbol = String(item.symbol || "").toLocaleLowerCase("ja");
    const name = kataToHira(item.name || "").toLocaleLowerCase("ja");
    if (symbol === needle || String(item.yahooSymbol || "").toLocaleLowerCase("ja") === needle || item.coinGeckoId === needle) return 0;
    if (name === needle) return 1;
    if (symbol.startsWith(needle) || name.startsWith(needle)) return 2;
    return 3;
}

async function handleAssetSearch(url) {
    const query = normalizeSearchText(url.searchParams.get("q"));
    const rawType = url.searchParams.get("type");
    const type = normalizeSearchType(rawType || "all");
    if (query.length < 1) return jsonResponse({ error: "qを指定してください" }, 400);
    if (query.length > 80) return jsonResponse({ error: "qは80文字以内で指定してください" }, 400);
    if (!type) return jsonResponse({ error: "typeはjp、us、crypto、allのいずれかを指定してください" }, 400);
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return jsonResponse({ error: "limitは整数で指定してください" }, 400);
    const limit = Math.min(SEARCH_RESULT_LIMIT_MAX, Math.max(1, Number(rawLimit) || SEARCH_RESULT_LIMIT_DEFAULT));

    const tasks = [];
    if (type === "all" || type === "jp" || type === "us") tasks.push(fetchYahooSearch(query));
    else tasks.push(Promise.resolve(null));
    if (type === "all" || type === "crypto") tasks.push(fetchCoinGeckoSearch(query));
    else tasks.push(Promise.resolve(null));

    const [yahooSettled, cryptoSettled] = await Promise.allSettled(tasks);
    const results = findAliasResults(query, type);
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

    unique.sort((a, b) => resultScore(a, query) - resultScore(b, query));
    if (!unique.length && errors.length) {
        return jsonResponse({ query, type, results: [], errors, fetchedAt: new Date().toISOString() }, 502);
    }
    return jsonResponse({ query, type, results: unique.slice(0, limit), errors, fetchedAt: new Date().toISOString() });
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

            if (mode === "btc-cycle") {
                return await handleBtcCycle();
            }

            if (mode === "fear-greed") {
                return await handleFearGreed();
            }

            if (mode === "asset-search") {
                return await handleAssetSearch(url);
            }

            if (mode === "fund-nav") {
                return await handleFundNav(url);
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

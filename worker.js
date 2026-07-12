// =====================================
// Bitcoin1070 Market API v3.0
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
                "Mozilla/5.0 (compatible; Bitcoin1070/3.0)",
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

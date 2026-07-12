// =====================================
// Bitcoin1070 Stock API
// Cloudflare Worker v1.0
// =====================================

const SYMBOLS = {
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

async function fetchYahooPrice(symbol) {
    const encodedSymbol =
        encodeURIComponent(symbol);

    const url =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodedSymbol +
        "?interval=1m&range=1d";

    const response = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (compatible; Bitcoin1070/1.0)",
            "Accept": "application/json"
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
        throw new Error(
            `${symbol}: 株価データなし`
        );
    }

    const meta = result.meta || {};

    let price =
        Number(meta.regularMarketPrice);

    if (!Number.isFinite(price) || price <= 0) {
        const closes =
            result?.indicators?.quote?.[0]?.close || [];

        const validCloses =
            closes.filter(value =>
                Number.isFinite(Number(value))
            );

        price =
            Number(
                validCloses[
                    validCloses.length - 1
                ]
            );
    }

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(
            `${symbol}: 有効な価格なし`
        );
    }

    return {
        price,
        currency: meta.currency || "",
        marketState: meta.marketState || "",
        exchangeName: meta.exchangeName || "",
        updatedAt:
            Number(meta.regularMarketTime) > 0
                ? new Date(
                    Number(meta.regularMarketTime) * 1000
                ).toISOString()
                : null
    };
}

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: CORS_HEADERS
            });
        }

        if (request.method !== "GET") {
            return jsonResponse(
                {
                    error:
                        "GETリクエストのみ対応しています"
                },
                405
            );
        }

        try {
            const entries =
                Object.entries(SYMBOLS);

            const results =
                await Promise.allSettled(
                    entries.map(
                        async ([key, symbol]) => {
                            const result =
                                await fetchYahooPrice(
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

            results.forEach((result, index) => {
                const [key, symbol] =
                    entries[index];

                if (
                    result.status === "fulfilled"
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
            });

            if (
                Object.keys(prices).length === 0
            ) {
                return jsonResponse(
                    {
                        error:
                            "すべての株価取得に失敗しました",
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
                source:
                    "Yahoo Finance chart data"
            });

        } catch (error) {
            return jsonResponse(
                {
                    error:
                        "株価APIでエラーが発生しました",
                    message:
                        error?.message ||
                        String(error)
                },
                500
            );
        }
    }
};

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

test("asset-search returns the PRO-compatible Japanese equity shape", async () => {
    globalThis.fetch = async url => {
        if (String(url).includes("finance/search")) return json({ quotes: [] });
        if (String(url).includes("api.coingecko.com/api/v3/search")) return json({ coins: [] });
        throw new Error(`unexpected URL: ${url}`);
    };

    const response = await worker.fetch(new Request("https://example.test/?mode=asset-search&q=%E3%81%A8%E3%82%88%E3%81%9F&type=jp"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.results[0], {
        type: "jp",
        symbol: "7203",
        name: "トヨタ自動車",
        yahooSymbol: "7203.T",
        source: "local"
    });
});

test("asset-search preserves CoinGecko identifiers and honors limit", async () => {
    globalThis.fetch = async url => {
        if (String(url).includes("api.coingecko.com/api/v3/search")) {
            return json({ coins: [
                { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 },
                { id: "bitcoin-cash", symbol: "bch", name: "Bitcoin Cash", market_cap_rank: 15 }
            ] });
        }
        throw new Error(`unexpected URL: ${url}`);
    };

    const response = await worker.fetch(new Request("https://example.test/?mode=asset-search&q=bitcoin&type=crypto&limit=1"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].coinGeckoId, "bitcoin");
    assert.equal(body.results[0].symbol, "BTC");
});

test("asset-search validates query, type, and limit", async () => {
    for (const [url, message] of [
        ["https://example.test/?mode=asset-search&type=all", "qを指定してください"],
        ["https://example.test/?mode=asset-search&q=a&type=invalid", "typeはjp、us、crypto、allのいずれかを指定してください"],
        ["https://example.test/?mode=asset-search&q=a&limit=many", "limitは整数で指定してください"]
    ]) {
        const response = await worker.fetch(new Request(url));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, message);
    }
});

test("asset-search returns safe structured errors when every provider fails", async () => {
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const response = await worker.fetch(new Request("https://example.test/?mode=asset-search&q=unknown&type=all"));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body.results, []);
    assert.equal(body.errors.length, 2);
    assert.ok(body.errors.every(message => message === "HTTP 503"));
});

test("existing history and current-price modes retain their response contracts", async () => {
    globalThis.fetch = async url => {
        assert.match(String(url), /finance\/chart/);
        return json({ chart: { result: [{
            meta: { regularMarketPrice: 123, currency: "USD", regularMarketTime: 1 },
            timestamp: [1],
            indicators: { quote: [{ open: [100], high: [130], low: [90], close: [123], volume: [10] }] }
        }] } });
    };

    const priceResponse = await worker.fetch(new Request("https://example.test/?symbols=TEST:AAPL"));
    assert.equal(priceResponse.status, 200);
    assert.equal((await priceResponse.json()).TEST, 123);

    const historyResponse = await worker.fetch(new Request("https://example.test/?mode=history&symbol=AAPL"));
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(history.symbol, "AAPL");
    assert.equal(history.candles[0].close, 123);
});

test("btc-cycle requests bounded Yahoo windows and returns validated weekly history", async () => {
    let windows = 0;
    globalThis.fetch = async url => {
        const u = new URL(String(url));
        assert.equal(u.searchParams.get("interval"), "1wk");
        assert.equal(u.searchParams.has("range"), false);
        const start = Number(u.searchParams.get("period1")) * 1000;
        const end = Number(u.searchParams.get("period2")) * 1000;
        assert.ok(end - start < 910 * 86400000);
        windows++;
        const timestamp = [], close = [];
        for (let ms = start; ms < end; ms += 7 * 86400000) {
            timestamp.push(Math.floor(ms / 1000)); close.push(100 + timestamp.length);
        }
        return json({ chart: { result: [{ timestamp, meta: { currency: "JPY", regularMarketPrice: 1000 }, indicators: { quote: [{ close }] } }] } });
    };
    const response = await worker.fetch(new Request("https://example.test/?mode=btc-cycle"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "yahoo");
    assert.ok(windows >= 5);
    assert.ok(body.count > 400);
    assert.equal(body.cadenceDays, 7);
});

test("btc-cycle rejects misleading monthly data and never labels it weekly", async () => {
    globalThis.fetch = async url => {
        const u = new URL(String(url));
        if (u.hostname.includes("coingecko")) return new Response("unavailable", { status: 503 });
        const start = Number(u.searchParams.get("period1")) * 1000;
        const end = Number(u.searchParams.get("period2")) * 1000;
        const timestamp = [], close = [];
        for (let ms = start; ms < end; ms += 31 * 86400000) {
            timestamp.push(Math.floor(ms / 1000)); close.push(100);
        }
        return json({ chart: { result: [{ timestamp, indicators: { quote: [{ close }] } }] } });
    };
    const response = await worker.fetch(new Request("https://example.test/?mode=btc-cycle"));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.match(body.errors[0], /粒度・期間が不足/);
});

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

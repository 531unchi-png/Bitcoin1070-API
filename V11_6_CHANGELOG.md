# Bitcoin1070 API v11.6

## 追加エンドポイント
- `?mode=btc-cycle`
  - Yahoo FinanceのBTC-JPY週足長期履歴を取得
  - Yahoo取得失敗時はCoinGeckoへフォールバック
  - 現在価格と長期ローソクデータを同時返却
- `?mode=fear-greed`
  - Fear & Greed Indexをプロキシ取得

## 修正目的
iPhoneブラウザから外部APIへ直接接続した際のCORS・レート制限・取得停止を回避します。

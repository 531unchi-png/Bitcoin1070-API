# Bitcoin1070 API v10.1

- Yahoo Finance検索を日本語・日本地域設定へ変更
- ひらがな入力時はカタカナ検索も併用
- 検索候補を最大50件取得
- 主要日本株の英語名を日本語正式名へ補正
- 既存の価格・履歴・仮想通貨APIは維持

## 銘柄検索 API

`GET /?mode=asset-search&q=検索語&type=all&limit=20`

- `type`: `jp`（日本株）、`us`（米国株）、`crypto`（暗号資産）、`all`。省略時は `all`
- `limit`: 1〜50。省略時は20
- `q`: 1〜80文字。ティッカー、銘柄コード、正式名称、日本語名、ひらがな・カタカナに対応
- 応答の `results` は株式の場合 `type`, `symbol`, `name`, `yahooSymbol`、暗号資産の場合 `type`, `symbol`, `name`, `coinGeckoId` を含む

外部検索の一部だけが失敗した場合は、取得できた候補と `errors` を返します。すべての外部検索が失敗して候補もない場合は、同じ応答形式のまま HTTP 502 を返します。

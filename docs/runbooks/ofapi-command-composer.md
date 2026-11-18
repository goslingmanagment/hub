# OFAPI banned-words dictionary

Banned Words is a versioned retained dictionary. The owner reads and refreshes it on «Система → OnlyFans API → События и ключ» (`/system/onlyfans-api#tools`; `ofapiBannedWordsAdminGet`, `ofapiBannedWordsRefresh`, `services/ofapi-banned-words.ts`). An explicit refresh fetches at most 1–30 pages of 100 entries. The response shows full versus partial traversal. No timer refreshes the dictionary. Its tariff is not documented as free: the UI bounds physical calls and the common ledger records actual response metadata; it does not promise a monetary ceiling from an unknown price.

The OnlyFans publisher does not read the retained copy: it creates every post with `blockBannedWords: "strict_ban"`, so OnlyFans itself refuses a post with a banned word and names it (`services/publications-onlyfans.ts`).

Provider documentation: https://docs.onlyfansapi.com/api-reference/banned-words/list-banned-words
